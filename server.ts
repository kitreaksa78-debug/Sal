// Must stay first: loads .env / .env.local before other modules read process.env.
import './server/env.js';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import jobsRouter from './server/routes/jobs.js';
import filesRouter from './server/routes/files.js';
import configRouter from './server/routes/config.js';
import separatorRouter from './server/routes/separator.js';
import voiceCloneRouter from './server/routes/voiceCloneConfig.js';
import geminiRouter from './server/routes/gemini.js';
import { logger } from './server/utils/logger.js';
import { FFmpegHelper } from './server/utils/ffmpeg.js';
import { getDatabase } from './server/services/db.js';
import { hydrateSeparatorSettings } from './server/services/separatorSettings.js';
import { hydrateVoiceCloneSettings } from './server/services/cloneSettings.js';
import { hydrateGeminiSettings } from './server/services/geminiSettings.js';

const app = express();
// Honour the port injected by the host, falling back to 3000 for local runs.
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'AI separate voice',
    timestamp: new Date().toISOString(),
  });
});

// Mount API routes
app.use('/api/jobs', jobsRouter);
app.use('/api/files', filesRouter);
app.use('/api/config', configRouter);
// Where the stem separation runs (the phone's Demucs API, a home server, the
// audio-separator sidecar); changeable from the studio's stem panel.
app.use('/api/config/separator', separatorRouter);
// Where the voice conversion runs: the owner's own Voice Convert API on a
// Colab GPU, pasted from the studio's voice card, or the hosted API by default.
app.use('/api/config/voice-clone', voiceCloneRouter);
// The Gemini keys and models behind the voice cleanup, changeable from the
// clean studio's panel so a new key needs no redeploy.
app.use('/api/config/gemini', geminiRouter);

// Anything still unmatched under /api has to answer like an API. Without this
// the static fallback below would serve index.html with a 200 for a removed or
// mistyped endpoint, and the client would try to parse HTML as JSON instead of
// seeing a plain 404.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'រកមិនឃើញ API នេះទេ។ (Unknown API endpoint.)' });
});

async function startServer() {
  // Recover finished jobs from object storage: hosts like Render free wipe the
  // local disk on every restart, but uploads and results live on in Cloudflare R2.
  await getDatabase().hydrateFromRemote();
  // A job that was mid-separation when the old process stopped is still stored as
  // running, but its pipeline is gone: without this it answers "still working"
  // forever and the studio's bar never moves again.
  await getDatabase().reconcileInterruptedJobs();
  // The stem service the owner pointed the app at from the website, so a job
  // started right after a restart still uses the phone. Demucs is a prerequisite
  // for a job — with no stem service connected the upload endpoint refuses the
  // video — so this hydration is what makes the pipeline ready at boot.
  await hydrateSeparatorSettings();
  // The voice conversion service is mirrored for the same reason: a tunnel URL
  // is pasted once and must still be there after a restart.
  await hydrateVoiceCloneSettings();
  // The Gemini keys for «សម្អាតសំឡេង» are mirrored to object storage for the same
  // reason: a free host forgets its disk, but not the bucket.
  await hydrateGeminiSettings();
  // Translation needs no service to hydrate: Google Translate is reached over
  // HTTPS from the request itself, with no key and nothing to reconnect.

  // Check system dependencies on start
  const ffmpegInfo = await FFmpegHelper.checkAvailability();
  if (ffmpegInfo.available) {
    logger.info(`FFmpeg initialized: ${ffmpegInfo.version}`);
  } else {
    logger.warn('FFmpeg binary not detected in PATH. Audio/video rendering might be restricted.');
  }

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    logger.info('Vite development server middleware loaded.');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    logger.info(`Serving static production build from ${distPath}`);
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Voice/music separation studio listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
