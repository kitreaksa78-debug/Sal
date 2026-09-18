// Must stay first: loads .env / .env.local before other modules read process.env.
import './server/env.js';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import jobsRouter from './server/routes/jobs.js';
import filesRouter from './server/routes/files.js';
import configRouter from './server/routes/config.js';
import { logger } from './server/utils/logger.js';
import { FFmpegHelper } from './server/utils/ffmpeg.js';
import { getDatabase } from './server/services/db.js';

const app = express();
// Honour the port injected by the host, falling back to 3000 for local runs.
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'KhmerDub AI',
    timestamp: new Date().toISOString(),
  });
});

// Mount API routes
app.use('/api/jobs', jobsRouter);
app.use('/api/files', filesRouter);
app.use('/api/config', configRouter);

async function startServer() {
  // Recover job history from object storage: hosts like Render free wipe the local
  // disk on every restart, but uploads and results live on in Cloudflare R2.
  await getDatabase().hydrateFromRemote();

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
    logger.info(`KhmerDub AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
