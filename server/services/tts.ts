import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Modality } from '@google/genai';
import { DialogueSegment, JobSettings } from '../types.js';
import { logger } from '../utils/logger.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { withRetry } from '../utils/retry.js';

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
  synthesizeSpeech(
    text: string,
    outputPath: string,
    options: TTSOptions
  ): Promise<TTSResult>;
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
    const apiKey = process.env.TTS_API_KEY || process.env.GEMINI_API_KEY;
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
    return Boolean(process.env.TTS_API_KEY || process.env.GEMINI_API_KEY);
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

    // Measure duration of the synthesized speech
    let currentDuration = await FFmpegHelper.getAudioDuration(rawWavPath);

    // If target duration is specified (original video dialogue duration), match timing:
    if (options.targetDuration && options.targetDuration > 0.3) {
      const targetDur = options.targetDuration;
      // If generated speech is longer than target by >10%, speed up with FFmpeg atempo (up to 1.4x)
      if (currentDuration > targetDur * 1.08) {
        const speedFactor = Math.min(1.4, currentDuration / targetDur);
        logger.info(`Dialogue length (${currentDuration.toFixed(2)}s) exceeds target (${targetDur.toFixed(2)}s). Adjusting speech tempo by ${speedFactor.toFixed(2)}x`);
        await FFmpegHelper.adjustTempo(rawWavPath, outputPath, speedFactor);
      } else if (currentDuration < targetDur * 0.75) {
        // Dialogue is slightly shorter: retain natural pauses, slightly adjust if needed (down to 0.9x)
        const slowFactor = Math.max(0.9, currentDuration / targetDur);
        await FFmpegHelper.adjustTempo(rawWavPath, outputPath, slowFactor);
      } else {
        fs.copyFileSync(rawWavPath, outputPath);
      }
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
 * Custom Khmer TTS Provider (e.g. ElevenLabs or dedicated Cambodian TTS API)
 */
export class ExternalKhmerTTSProvider implements TTSProvider {
  name = 'custom_khmer';

  isConfigured(): boolean {
    return Boolean(process.env.TTS_API_KEY && process.env.TTS_PROVIDER === 'custom_khmer');
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
  const provider = (process.env.TTS_PROVIDER || 'gemini').toLowerCase();
  if (provider === 'custom_khmer') {
    return new ExternalKhmerTTSProvider();
  }
  return new GeminiTTSProvider();
}
