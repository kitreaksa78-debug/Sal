import express, { Request, Response } from 'express';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { getStorage } from '../services/storage.js';
import {
  getAudioSeparationProvider,
  DEMUCS_REQUIRED_MESSAGE,
} from '../services/audioSeparation.js';
import { getSeparatorConnection } from '../services/separatorSettings.js';
import { SystemConfigStatus } from '../types.js';

const router = express.Router();

router.get('/status', async (req: Request, res: Response) => {
  const ffmpegInfo = await FFmpegHelper.checkAvailability();
  const storage = getStorage();
  const storageInfo = storage.getInfo();

  // Stem separation runs on the Demucs service and nothing else, so this reads
  // `false` until one is connected — there is no built-in substitute. Asking the
  // provider itself keeps that honest.
  const audioSeparationInstance = getAudioSeparationProvider();
  const audioSeparationProvider = audioSeparationInstance.name;
  const audioSeparationConfigured = audioSeparationInstance.isConfigured();
  const audioSeparationConnection = getSeparatorConnection();

  const maxVideoSizeMb = parseInt(process.env.MAX_VIDEO_SIZE_MB || '500', 10);

  const status: SystemConfigStatus = {
    audioSeparation: {
      configured: audioSeparationConfigured,
      provider: audioSeparationProvider,
      ...(audioSeparationProvider === 'demucs_api'
        ? { model: audioSeparationConnection.model || 'service default' }
        : {}),
      ...(audioSeparationConfigured ? {} : { message: DEMUCS_REQUIRED_MESSAGE }),
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
  };

  res.json(status);
});

export default router;
