import express, { Request, Response } from 'express';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { getStorage } from '../services/storage.js';
import { getTranscriptionProvider } from '../services/transcription.js';
import { getTranslationService } from '../services/translation.js';
import { getTTSProvider } from '../services/tts.js';
import { getAudioSeparationProvider } from '../services/audioSeparation.js';
import { getSeparatorConnection } from '../services/separatorSettings.js';
import { SystemConfigStatus } from '../types.js';
import { getGeminiApiKey } from '../utils/aiKeys.js';

const router = express.Router();

router.get('/status', async (req: Request, res: Response) => {
  const ffmpegInfo = await FFmpegHelper.checkAvailability();
  const storage = getStorage();
  const storageInfo = storage.getInfo();

  const geminiConfigured = Boolean(getGeminiApiKey());
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  const sttInstance = getTranscriptionProvider();
  const sttConfigured = sttInstance.isConfigured();
  const sttProvider = sttInstance.name;
  const sttModel =
    sttProvider === 'assemblyai'
      ? 'AssemblyAI Conformer-2 + Diarization'
      : sttProvider === 'groq'
      ? process.env.GROQ_STT_MODEL || 'whisper-large-v3'
      : process.env.STT_MODEL || 'gemini-3.5-transcribe';

  const translationService = getTranslationService();
  const translationFallbackModels = (process.env.GROQ_TRANSLATION_FALLBACK_MODELS || 'openai/gpt-oss-20b,qwen/qwen3.8-27b')
    .split(',')
    .map(m => m.trim())
    .filter(m => m && m !== translationService.getModelName());

  const ttsInstance = getTTSProvider();
  const ttsConfigured = ttsInstance.isConfigured();
  const ttsProvider = ttsInstance.name;
  const ttsModel = ttsInstance.getModelName();

  // Stem separation runs on the Demucs service and nothing else, so this reads
  // `false` until one is connected — there is no built-in substitute. Asking the
  // provider itself keeps that honest.
  const audioSeparationInstance = getAudioSeparationProvider();
  const audioSeparationProvider = audioSeparationInstance.name;
  const audioSeparationConfigured = audioSeparationInstance.isConfigured();
  const audioSeparationConnection = getSeparatorConnection();

  const maxVideoSizeMb = parseInt(process.env.MAX_VIDEO_SIZE_MB || '500', 10);
  const videoSegmentSeconds = parseInt(process.env.VIDEO_SEGMENT_SECONDS || '300', 10);

  const status: SystemConfigStatus = {
    gemini: {
      configured: geminiConfigured,
      model: geminiModel,
    },
    translation: {
      configured: translationService.isConfigured(),
      provider: translationService.getProviderName(),
      model: translationService.getModelName(),
      fallbackModels: translationFallbackModels,
    },
    stt: {
      configured: sttConfigured,
      provider: sttProvider,
      model: sttModel,
    },
    tts: {
      configured: ttsConfigured,
      provider: ttsProvider,
      model: ttsModel,
    },
    audioSeparation: {
      configured: audioSeparationConfigured,
      provider: audioSeparationProvider,
      ...(audioSeparationProvider === 'demucs_api'
        ? { model: audioSeparationConnection.model || 'service default' }
        : {}),
      ...(audioSeparationConfigured
        ? {}
        : {
            message:
              'មិនទាន់ភ្ជាប់ម៉ាស៊ីនញែកភ្លេងទេ — សូមដាក់ URL ក្នុងផ្ទាំង «ញែកភ្លេង» ឬកំណត់ AUDIO_SEPARATOR_URL។ (No stem service is connected; set it in the Stem separation panel or via AUDIO_SEPARATOR_URL.)',
          }),
    },
    storage: {
      configured: storage.isConfigured(),
      provider: storageInfo.provider,
      bucket: storageInfo.bucket,
      endpoint: storageInfo.endpoint,
      hasCredentials: storageInfo.hasCredentials,
      message: storageInfo.message,
    },
    ffmpeg: {
      configured: ffmpegInfo.available,
      version: ffmpegInfo.version,
    },
    maxVideoSizeMb,
    videoSegmentSeconds,
  };

  res.json(status);
});

export default router;
