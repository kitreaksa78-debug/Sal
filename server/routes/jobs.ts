import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../services/db.js';
import { getStorage } from '../services/storage.js';
import { requireSession } from '../middleware/session.js';
import { isAppOwner } from '../services/accounts.js';
import { JobProcessor, jobEvents } from '../services/jobProcessor.js';
import { JobRecord, JobSettings, SOURCE_LANGUAGES } from '../types.js';
import { logger } from '../utils/logger.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';

const router = express.Router();

const maxVideoSizeMb = parseInt(process.env.MAX_VIDEO_SIZE_MB || '500', 10);
const maxBytes = maxVideoSizeMb * 1024 * 1024;

// Temporary upload folder
const uploadDir = path.join(process.cwd(), 'data', 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storageEngine = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `upload_${Date.now()}_${randomSuffix}${ext}`);
  },
});

const upload = multer({
  storage: storageEngine,
  limits: { fileSize: maxBytes },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMime = [
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'video/x-matroska',
      'video/avi',
      'video/x-msvideo',
    ];

    if (allowedExtensions.includes(ext) || allowedMime.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`ទម្រង់វីដេអូមិនត្រូវបានគាំទ្រទេ។ សូមបញ្ចូលឯកសារ MP4, MOV ឬ WEBM។ (Unsupported format: ${ext})`));
    }
  },
});

/**
 * POST /api/jobs
 * Upload video and start asynchronous processing
 */
router.post('/', upload.single('video'), async (req: Request, res: Response) => {
  try {
    // Every video belongs to the account that uploaded it — that is what keeps
    // two users' histories apart.
    const session = await requireSession(req, res);
    if (!session) return;

    if (!req.file) {
      return res.status(400).json({ error: 'សូមជ្រើសរើសវីដេអូដើម្បីបញ្ចូល។ (No video file provided)' });
    }

    const jobId = `kd_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const storage = getStorage();
    const db = getDatabase();

    // Parse settings
    let settings: JobSettings = {
      voice: 'auto',
      voiceStyle: 'natural',
      backgroundMusic: 'keep',
      subtitle: true,
      outputQuality: 'original',
      translationStyle: 'natural',
      smartVoice: true,
      sourceLanguage: 'auto',
    };

    if (req.body.settings) {
      try {
        const parsed = typeof req.body.settings === 'string' ? JSON.parse(req.body.settings) : req.body.settings;
        settings = { ...settings, ...parsed };
      } catch (e) {
        logger.warn('Failed to parse custom settings string, using defaults');
      }
    }

    // Only allow languages the studio offers; anything else falls back to auto-detect.
    if (settings.sourceLanguage && !SOURCE_LANGUAGES.includes(settings.sourceLanguage)) {
      logger.warn(`Unknown source language "${settings.sourceLanguage}" — using auto-detect.`);
      settings.sourceLanguage = 'auto';
    }

    // Save uploaded file into storage uploads directory
    const savedFilename = `input_${jobId}${path.extname(req.file.originalname)}`;
    const savedInputPath = await storage.saveFile('uploads', savedFilename, req.file.path);

    // Clean temp multer file if different
    if (req.file.path !== savedInputPath && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    // Probe initial metadata
    const meta = await FFmpegHelper.probeVideo(savedInputPath);

    const newJob: JobRecord = {
      id: jobId,
      ownerId: session.userId,
      ownerEmail: session.email,
      status: 'queued',
      progress: 5,
      message: 'Job queued...',
      khmerMessage: 'កំពុងស្ថិតក្នុងជួររង់ចាំ...',
      inputFile: savedInputPath,
      originalFilename: req.file.originalname,
      inputMimeType: req.file.mimetype,
      metadata: meta,
      settings,
      createdAt: new Date().toISOString(),
    };

    await db.createJob(newJob);

    // Count the video against this account's daily allowance. The server is the
    // one keeping score, so switching devices or clearing a browser cannot reset
    // the free tier.
    await db.addUsage(session.userId, Number(meta?.duration) || 0);

    // Trigger asynchronous processing pipeline
    setImmediate(() => {
      JobProcessor.processJob(jobId).catch((err) => {
        logger.error(`Error processing job ${jobId}:`, err);
      });
    });

    return res.status(201).json({
      jobId,
      status: 'queued',
      message: 'វីដេអូបានបញ្ចូលដោយជោគជ័យ និងកំពុងចាប់ផ្តើមដំណើរការ...',
      job: newJob,
    });
  } catch (err: any) {
    logger.error('Failed to create job:', err);
    return res.status(500).json({
      error: 'មានបញ្ហាក្នុងការបញ្ចូលវីដេអូ។ សូមសាកល្បងម្តងទៀត។',
      details: err?.message,
    });
  }
});

/**
 * GET /api/jobs
 * List recent jobs
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    const db = getDatabase();
    const limit = parseInt(req.query.limit as string || '20', 10);
    let jobs = await db.listJobsForOwner(session.userId, limit);

    // Videos uploaded before accounts existed belong to nobody. They stay with
    // the app owner rather than leaking into every new account.
    if (await isAppOwner(session)) {
      const legacy = (await db.listJobs(1000)).filter((job) => !job.ownerId);
      const seen = new Set(jobs.map((job) => job.id));
      jobs = [...jobs, ...legacy.filter((job) => !seen.has(job.id))]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);
    }

    return res.json({
      jobs,
      account: { id: session.userId, email: session.email },
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to list jobs' });
  }
});

/**
 * GET /api/jobs/:id
 * Get single job details
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    // Another account's job is simply "not found" — never someone else's video.
    if (!job || (job.ownerId && job.ownerId !== session.userId)) {
      return res.status(404).json({ error: 'រកមិនឃើញការងារនេះទេ។ (Job not found)' });
    }
    return res.json(job);
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to get job details' });
  }
});

/**
 * GET /api/jobs/:id/events
 * Server-Sent Events for real-time progress updates
 */
router.get('/:id/events', async (req: Request, res: Response) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const jobId = req.params.id;
  const db = getDatabase();
  const job = await db.getJob(jobId);

  if (!job || (job.ownerId && job.ownerId !== session.userId)) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial state
  res.write(`data: ${JSON.stringify(job)}\n\n`);

  const onUpdate = (updatedJob: JobRecord) => {
    if (updatedJob.id === jobId) {
      res.write(`data: ${JSON.stringify(updatedJob)}\n\n`);
      if (updatedJob.status === 'completed' || updatedJob.status === 'failed') {
        res.end();
      }
    }
  };

  jobEvents.on(`job:${jobId}`, onUpdate);

  req.on('close', () => {
    jobEvents.off(`job:${jobId}`, onUpdate);
  });
});

/**
 * GET /api/jobs/:id/download
 * Download final dubbed MP4 file
 */
router.get('/:id/download', async (req: Request, res: Response) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    const db = getDatabase();
    const job = await db.getJob(req.params.id);

    if (!job || (job.ownerId && job.ownerId !== session.userId)) {
      return res.status(404).send('Job not found');
    }

    if (job.status !== 'completed' || !job.outputFile || !fs.existsSync(job.outputFile)) {
      return res.status(400).send('វីដេអូបកប្រែមិនទាន់រួចរាល់ ឬមានបញ្ហា។ (Output video not ready)');
    }

    const safeFilename = `khmer-dubbed-${job.id}.mp4`;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    const fileStream = fs.createReadStream(job.outputFile);
    fileStream.pipe(res);
  } catch (err: any) {
    logger.error('Download error:', err);
    res.status(500).send('Download failed');
  }
});

/**
 * GET /api/jobs/:id/subtitles
 * Download or stream subtitles (SRT or VTT)
 */
router.get('/:id/subtitles', async (req: Request, res: Response) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    if (!job || (job.ownerId && job.ownerId !== session.userId)) {
      return res.status(404).send('Job not found');
    }

    const format = (req.query.format as string || 'vtt').toLowerCase();
    const subFile = format === 'srt' ? job.outputSubtitlesSrt : job.outputSubtitlesVtt;

    if (!subFile || !fs.existsSync(subFile)) {
      return res.status(404).send('Subtitles not ready');
    }

    const mimeType = format === 'srt' ? 'application/x-subrip' : 'text/vtt; charset=utf-8';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="khmer-subtitles-${job.id}.${format}"`);
    fs.createReadStream(subFile).pipe(res);
  } catch (e) {
    res.status(500).send('Failed to read subtitles');
  }
});

/**
 * GET /api/jobs/:id/audio
 * Download mixed dubbed audio
 */
router.get('/:id/audio', async (req: Request, res: Response) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    if (!job || (job.ownerId && job.ownerId !== session.userId)) {
      return res.status(404).send('Job not found');
    }
    if (!job.outputAudioFile || !fs.existsSync(job.outputAudioFile)) {
      return res.status(404).send('Audio not ready');
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="khmer-audio-${job.id}.wav"`);
    fs.createReadStream(job.outputAudioFile).pipe(res);
  } catch (e) {
    res.status(500).send('Failed to download audio');
  }
});

export default router;
