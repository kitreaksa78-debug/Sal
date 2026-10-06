import fs from 'fs';
import os from 'os';
import path from 'path';
import { GoogleGenAI, Modality } from '@google/genai';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { DialogueSegment, JobSettings, TargetLanguage } from '../types.js';
import { logger } from '../utils/logger.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { withRetry } from '../utils/retry.js';
import { getGeminiApiKey } from '../utils/aiKeys.js';

export interface TTSOptions {
  gender?: 'male' | 'female' | 'neutral';
  emotion?: string;
  speed?: number; // 0.8 to 1.5
  voiceStyle?: string;
  /**
   * The job's target language, so the voice engine speaks the language the dub
   * was translated into. Absent means Khmer — the dub the pipeline used to
   * always produce.
   */
  language?: TargetLanguage;
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

/** The target that old jobs and missing values fall back to. */
const DEFAULT_TTS_LANGUAGE = 'km';

/**
 * What each target language is called in a Gemini TTS prompt.
 *
 * Gemini's prebuilt voices are not tied to a language, so the instruction is
 * what steers the pronunciation. The Khmer entry keeps the wording this project
 * shipped with, so dubbing into Khmer sounds exactly as it did before the target
 * picker existed.
 */
const GEMINI_SPOKEN_LANGUAGES: Record<string, { native: string; spoken: string }> = {
  km: { native: 'Cambodian', spoken: 'Khmer' },
  en: { native: 'American', spoken: 'English' },
  zh: { native: 'Mandarin Chinese', spoken: 'Mandarin Chinese' },
  th: { native: 'Thai', spoken: 'Thai' },
  vi: { native: 'Vietnamese', spoken: 'Vietnamese' },
  ko: { native: 'Korean', spoken: 'Korean' },
  ja: { native: 'Japanese', spoken: 'Japanese' },
  fr: { native: 'French', spoken: 'French' },
  es: { native: 'Spanish', spoken: 'Spanish' },
};

/**
 * Edge neural voices per target language (female / male).
 *
 * Edge is the keyless engine and has a neural voice for every language the
 * studio offers, so the dub speaks the chosen target instead of always Khmer.
 * `EDGE_TTS_VOICE_FEMALE_<CODE>` / `EDGE_TTS_VOICE_MALE_<CODE>` override one
 * language; the older `EDGE_TTS_VOICE_FEMALE` / `EDGE_TTS_VOICE_MALE` still
 * override the default (Khmer) pair exactly as before.
 */
const EDGE_VOICES: Record<string, { female: string; male: string }> = {
  km: { female: 'km-KH-SreymomNeural', male: 'km-KH-PisethNeural' },
  en: { female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' },
  zh: { female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' },
  th: { female: 'th-TH-PremwadeeNeural', male: 'th-TH-NiwatNeural' },
  vi: { female: 'vi-VN-HoaiMyNeural', male: 'vi-VN-NamMinhNeural' },
  ko: { female: 'ko-KR-SunHiNeural', male: 'ko-KR-InJoonNeural' },
  ja: { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
  fr: { female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' },
  es: { female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' },
};

/** The Edge voice for a target language and gender, honouring the env overrides. */
function edgeVoice(language: string | undefined, gender: 'male' | 'female'): string {
  const code = (language || '').trim().toLowerCase() || DEFAULT_TTS_LANGUAGE;
  const pair = EDGE_VOICES[code] || EDGE_VOICES[DEFAULT_TTS_LANGUAGE];
  const perLanguage = (
    process.env[`EDGE_TTS_VOICE_${gender.toUpperCase()}_${code.toUpperCase()}`] || ''
  ).trim();
  if (perLanguage) return perLanguage;
  if (code === DEFAULT_TTS_LANGUAGE) {
    const generic = (process.env[`EDGE_TTS_VOICE_${gender.toUpperCase()}`] || '').trim();
    if (generic) return generic;
  }
  return gender === 'male' ? pair.male : pair.female;
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

    const spoken = GEMINI_SPOKEN_LANGUAGES[(options.language || '').trim().toLowerCase()] || GEMINI_SPOKEN_LANGUAGES.km;

    // Direct sentence-level prompt for natural dubbing pronunciation in the
    // job's target language (Khmer unless the studio chose another one).
    const prompt = `Say naturally as a native ${spoken.native} speaker in natural spoken ${spoken.spoken} (${emotionInstruction}): "${cleanText}"`;

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

    // The line is used exactly as the engine produced it. It is no longer sped
    // up or trimmed to fit the original slot — that per-line FFmpeg pass was the
    // "audio must match the video" step, and dropping it removes two encodes per
    // line. The voice is still placed on its own timestamp when the tracks are
    // assembled, so lines start where they should without being squeezed.
    fs.copyFileSync(rawWavPath, outputPath);

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
 * Microsoft Edge "Read Aloud" neural voices — the free, keyless route to speech.
 *
 * Edge exposes the same neural voices as Azure Speech (e.g. km-KH Piseth/Sreymom,
 * en-US Guy/Aria, …) with no subscription and no quota, and there is a voice for
 * every target language the studio offers. It is Microsoft's public read-aloud
 * endpoint rather than a contracted API, so each line is retried and the pipeline
 * falls back to the original audio if the service is unreachable.
 */
export class EdgeTTSProvider implements TTSProvider {
  name = 'edge';

  isConfigured(): boolean {
    // No key required — this is the always-available voice engine.
    return process.env.EDGE_TTS_ENABLED !== 'false';
  }

  getModelName(): string {
    // The default (Khmer) pair, which is what the settings card reports.
    return `${edgeVoice(DEFAULT_TTS_LANGUAGE, 'female')} / ${edgeVoice(DEFAULT_TTS_LANGUAGE, 'male')}`;
  }

  private resolveVoice(
    gender: 'male' | 'female' | 'neutral' | undefined,
    language?: string
  ): string {
    return edgeVoice(language, gender === 'male' ? 'male' : 'female');
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

    const voiceName = this.resolveVoice(options.gender, options.language);
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

    // Used as produced: no tempo fit and no trim to the original slot (see the
    // Gemini provider above for why).
    fs.copyFileSync(rawWavPath, outputPath);

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
