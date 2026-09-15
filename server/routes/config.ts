import express, { Request, Response } from 'express';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { getStorage } from '../services/storage.js';
import { getTranscriptionProvider } from '../services/transcription.js';
import { SystemConfigStatus } from '../types.js';

const router = express.Router();

router.get('/status', async (req: Request, res: Response) => {
  const ffmpegInfo = await FFmpegHelper.checkAvailability();
  const storage = getStorage();
  const storageInfo = storage.getInfo();

  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  const sttInstance = getTranscriptionProvider();
  const sttConfigured = sttInstance.isConfigured();
  const sttProvider = sttInstance.name;
  const sttModel =
    sttProvider === 'assemblyai'
      ? 'AssemblyAI Conformer-2 + Diarization'
      : (process.env.STT_MODEL || 'gemini-3.5-transcribe');

  const ttsConfigured = Boolean(process.env.TTS_API_KEY || process.env.GEMINI_API_KEY);
  const ttsProvider = process.env.TTS_PROVIDER || 'gemini';
  const ttsModel = process.env.TTS_MODEL || 'gemini-3.1-flash-tts-preview';

  const audioSeparationConfigured = true; // Local DSP separation is always ready with FFmpeg
  const audioSeparationProvider = process.env.AUDIO_SEPARATION_PROVIDER || 'local_dsp';

  const maxVideoSizeMb = parseInt(process.env.MAX_VIDEO_SIZE_MB || '500', 10);
  const videoSegmentSeconds = parseInt(process.env.VIDEO_SEGMENT_SECONDS || '300', 10);

  const status: SystemConfigStatus = {
    gemini: {
      configured: geminiConfigured,
      model: geminiModel,
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
