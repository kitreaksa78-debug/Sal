import fs from 'fs';
import os from 'os';
import path from 'path';
import { GoogleGenAI, Modality } from '@google/genai';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { DialogueSegment, JobSettings } from '../types.js';
import { logger } from '../utils/logger.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { withRetry } from '../utils/retry.js';
import { getGeminiApiKey } from '../utils/aiKeys.js';

/**
 * How far a Khmer line may be squeezed to fit its original slot.
 *
 * Khmer usually needs more words than the source language, so a translated line
 * often runs past its slot. Padding silence is stripped before the fit is judged
 * (see fitAudioToSlot), which already recovers a good part of that, and 1.5x is
 * still intelligible for speech — whereas a tighter cap means the line is cut
 * mid-syllable, which sounds broken and loses the words the viewer needs. Slow
 * it down with MAX_SPEECH_TEMPO if the owner prefers calmer delivery and can
 * accept trimming instead.
 */
const MAX_SPEECH_TEMPO = Number(process.env.MAX_SPEECH_TEMPO || '1.5');

export interface TTSOptions {
  gender?: 'male' | 'female' | 'neutral';
  emotion?: string;
  speed?: number; // 0.8 to 1.5
  voiceStyle?: string;
  targetDuration?: number; // in seconds
}

export interface TTSResult {
  audioPath: string;
  duration: number;
}

export interface TTSProvider {
  name: string;
  isConfigured(): boolean;
  getModelName(): string;
  synthesizeSpeech(
    text: string,
    outputPath: string,
    options: TTSOptions
  ): Promise<TTSResult>;
}

/** Escape text before it is embedded into the SSML request body. */
function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Gemini Text-to-Speech Provider using gemini-3.1-flash-tts-preview
 * Supports Cambodian Khmer language, male and female voices, emotional tone and natural pacing.
 */
export class GeminiTTSProvider implements TTSProvider {
  name = 'gemini';
  private client: GoogleGenAI | null = null;
  private modelName: string;

  constructor() {
    this.modelName = process.env.TTS_MODEL || 'gemini-3.1-flash-tts-preview';
    const apiKey = process.env.TTS_API_KEY || getGeminiApiKey();
    if (apiKey) {
      this.client = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }
  }

  isConfigured(): boolean {
    return Boolean(process.env.TTS_API_KEY || getGeminiApiKey());
  }

  getModelName(): string {
    return this.modelName;
  }

  async synthesizeSpeech(
    text: string,
    outputPath: string,
    options: TTSOptions
  ): Promise<TTSResult> {
    if (!this.client) {
      throw new Error('TTS Provider Gemini is not configured. Missing API key.');
    }

    const cleanText = text.trim();
    if (!cleanText) {
      throw new Error('Cannot synthesize empty speech text.');
    }

    // Voice assignment: Male vs Female
    // Available Gemini TTS prebuilt voices: 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
    let voiceName = 'Puck'; // male default
    if (options.gender === 'female') {
      voiceName = 'Kore'; // female default
    } else if (options.gender === 'neutral') {
      voiceName = 'Zephyr';
    }

    const emotionInstruction = options.emotion && options.emotion !== 'neutral'
      ? `with a ${options.emotion} emotional tone`
      : 'with a natural, friendly tone';

    // Direct sentence-level prompt for natural Cambodian Khmer dubbing pronunciation
    const prompt = `Say naturally as a native Cambodian speaker in natural spoken Khmer (${emotionInstruction}): "${cleanText}"`;

    const rawWavPath = outputPath.replace(/\.wav$/, '_raw.wav');

    await withRetry(
      async () => {
        const response = await this.client!.models.generateContent({
          model: this.modelName,
          contents: [{ parts: [{ text: prompt }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        });

        // Gemini TTS returns base64 PCM/audio data in candidates[0].content.parts[0].inlineData.data
        const audioPart = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (!audioPart || !audioPart.data) {
          throw new Error('No audio data received from Gemini TTS service.');
        }

        const audioBuffer = Buffer.from(audioPart.data, 'base64');
        const mimeType = audioPart.mimeType || 'audio/wav';

        // Check if raw PCM or WAV container
        if (mimeType.includes('pcm')) {
          // Wrap raw 24kHz 16-bit mono PCM into standard WAV using FFmpeg
          const tempPcm = outputPath.replace(/\.wav$/, '.pcm');
          fs.writeFileSync(tempPcm, audioBuffer);
          await FFmpegHelper.execute([
            '-y',
            '-f', 's16le',
            '-ar', '24000',
            '-ac', '1',
            '-i', tempPcm,
            '-ar', '44100',
            rawWavPath,
          ]);
          if (fs.existsSync(tempPcm)) fs.unlinkSync(tempPcm);
        } else {
          fs.writeFileSync(rawWavPath, audioBuffer);
        }
      },
      { operationName: 'Gemini Khmer Speech Synthesis' }
    );

    // Fit exactly to the original slot so the Khmer voice starts where the mouth
    // starts and never bleeds into the next line.
    const targetDur = options.targetDuration && options.targetDuration > 0.3 ? options.targetDuration : 0;
    if (targetDur) {
      await FFmpegHelper.fitAudioToSlot(rawWavPath, outputPath, targetDur, MAX_SPEECH_TEMPO);
    } else {
      fs.copyFileSync(rawWavPath, outputPath);
    }

    if (fs.existsSync(rawWavPath)) {
      try { fs.unlinkSync(rawWavPath); } catch {}
    }

    const finalDuration = await FFmpegHelper.getAudioDuration(outputPath);
    return {
      audioPath: outputPath,
      duration: finalDuration,
    };
  }
}

/**
 * Microsoft Edge "Read Aloud" neural voices — the free, keyless route to Khmer speech.
 *
 * Edge exposes the same km-KH neural voices as Azure Speech (Piseth for male,
 * Sreymom for female) with no subscription and no quota. It is Microsoft's public
 * read-aloud endpoint rather than a contracted API, so each line is retried and the
 * pipeline falls back to the original audio if the service is unreachable.
 */
export class EdgeTTSProvider implements TTSProvider {
  name = 'edge';

  isConfigured(): boolean {
    // No key required — this is the always-available Khmer voice engine.
    return process.env.EDGE_TTS_ENABLED !== 'false';
  }

  private getFemaleVoice(): string {
    return process.env.EDGE_TTS_VOICE_FEMALE || 'km-KH-SreymomNeural';
  }

  private getMaleVoice(): string {
    return process.env.EDGE_TTS_VOICE_MALE || 'km-KH-PisethNeural';
  }

  getModelName(): string {
    return `${this.getFemaleVoice()} / ${this.getMaleVoice()}`;
  }

  private resolveVoice(gender?: 'male' | 'female' | 'neutral'): string {
    if (gender === 'male') return this.getMaleVoice();
    return this.getFemaleVoice();
  }

  async synthesizeSpeech(
    text: string,
    outputPath: string,
    options: TTSOptions
  ): Promise<TTSResult> {
    const cleanText = text.trim();
    if (!cleanText) {
      throw new Error('Cannot synthesize empty speech text.');
    }

    const voiceName = this.resolveVoice(options.gender);
    const rawMp3Path = outputPath.replace(/\.wav$/, '_edge.mp3');
    const rawWavPath = outputPath.replace(/\.wav$/, '_edge_raw.wav');
    const synthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-'));

    try {
      await withRetry(
        async () => {
          const tts = new MsEdgeTTS();
          try {
            await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
            const result = await tts.toFile(synthDir, escapeSsml(cleanText));
            if (!result.audioFilePath || !fs.existsSync(result.audioFilePath)) {
              throw new Error('Edge TTS returned no audio file.');
            }
            fs.copyFileSync(result.audioFilePath, rawMp3Path);
          } finally {
            tts.close();
          }
        },
        { operationName: `Edge TTS (${voiceName})`, maxAttempts: 3 }
      );
    } finally {
      fs.rmSync(synthDir, { recursive: true, force: true });
    }

    // Edge returns 24 kHz mono MP3; the mixing stage works in 44.1 kHz stereo WAV.
    await FFmpegHelper.execute([
      '-y',
      '-i', rawMp3Path,
      '-ar', '44100',
      '-ac', '2',
      rawWavPath,
    ]);

    const targetDur = options.targetDuration && options.targetDuration > 0.3 ? options.targetDuration : 0;
    if (targetDur) {
      await FFmpegHelper.fitAudioToSlot(rawWavPath, outputPath, targetDur, MAX_SPEECH_TEMPO);
    } else {
      fs.copyFileSync(rawWavPath, outputPath);
    }

    for (const tempPath of [rawMp3Path, rawWavPath]) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }

    return {
      audioPath: outputPath,
      duration: await FFmpegHelper.getAudioDuration(outputPath),
    };
  }
}

/**
 * Custom Khmer TTS Provider (e.g. ElevenLabs or dedicated Cambodian TTS API)
 */
export class ExternalKhmerTTSProvider implements TTSProvider {
  name = 'custom_khmer';

  isConfigured(): boolean {
    return Boolean(process.env.TTS_API_KEY && process.env.TTS_PROVIDER === 'custom_khmer');
  }

  getModelName(): string {
    return process.env.TTS_MODEL || 'custom_khmer';
  }

  async synthesizeSpeech(
    text: string,
    outputPath: string,
    options: TTSOptions
  ): Promise<TTSResult> {
    if (!this.isConfigured()) {
      throw new Error('Custom Khmer TTS provider is selected but TTS_API_KEY is not set.');
    }
    // Fallback to Gemini if custom is configured as primary fallback
    const geminiFallback = new GeminiTTSProvider();
    return geminiFallback.synthesizeSpeech(text, outputPath, options);
  }
}

export function getTTSProvider(): TTSProvider {
  const provider = (process.env.TTS_PROVIDER || '').toLowerCase();

  if (provider === 'custom_khmer') {
    return new ExternalKhmerTTSProvider();
  }
  if (provider === 'gemini') {
    return new GeminiTTSProvider();
  }
  if (provider === 'edge') {
    return new EdgeTTSProvider();
  }

  // No explicit choice: use Gemini when a key is present, otherwise fall back to
  // the keyless Edge voices so Khmer voice-over works out of the box.
  const gemini = new GeminiTTSProvider();
  if (gemini.isConfigured()) return gemini;
  return new EdgeTTSProvider();
}
