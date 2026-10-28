import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../services/db.js';
import { getStorage, resolveStoredArtifact } from '../services/storage.js';
import {
  SeparationProcessor,
  jobEvents,
  KHMER_CANCELLED_MESSAGE,
} from '../services/separationJob.js';
import {
  getAudioSeparationProvider,
  DEMUCS_REQUIRED_MESSAGE,
} from '../services/audioSeparation.js';
import { JobRecord } from '../types.js';
import { logger } from '../utils/logger.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';

const router = express.Router();

/** The queued line, kept next to the record that carries it. */
const KHMER_QUEUED_MESSAGE = 'កំពុងស្ថិតក្នុងជួររង់ចាំ...';

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

/**
 * What the studio accepts: a video to pull the voices out of, or an audio file
 * to pull the singing (or the speech) out of. Both reach the same separator —
 * the only difference is whether the result is also written back over the
 * original picture.
 */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac'];

const upload = multer({
  storage: storageEngine,
  limits: { fileSize: maxBytes },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.includes(ext) || file.mimetype.startsWith('video/');
    const isAudio = AUDIO_EXTENSIONS.includes(ext) || file.mimetype.startsWith('audio/');

    if (isVideo || isAudio) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `ទម្រង់ឯកសារមិនត្រូវបានគាំទ្រទេ។ សូមបញ្ចូលវីដេអូ (MP4, MOV, WEBM) ឬឯកសារសំឡេង (MP3, WAV, M4A)។ (Unsupported format: ${ext})`
        )
      );
    }
  },
});

/** True when the upload is a bare audio file rather than a video with sound. */
function isAudioUpload(file: Express.Multer.File): boolean {
  const ext = path.extname(file.originalname).toLowerCase();
  if (AUDIO_EXTENSIONS.includes(ext)) return true;
  return file.mimetype.startsWith('audio/') && !file.mimetype.startsWith('video/');
}

/**
 * POST /api/jobs
 * Upload a video or an audio file and start the separation.
 */
router.post('/', upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'សូមជ្រើសរើសវីដេអូ ឬឯកសារសំឡេងដើម្បីបញ្ចូល។ (No file provided)' });
    }

    // Separation *is* the product: with no Demucs service connected there is
    // nothing to sell, so the upload is refused before the file is stored
    // instead of failing minutes later with an empty result.
    if (!getAudioSeparationProvider().isConfigured()) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
      return res.status(400).json({ error: DEMUCS_REQUIRED_MESSAGE });
    }

    const jobId = `sep_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const storage = getStorage();
    const db = getDatabase();

    // Save uploaded file into storage uploads directory
    const savedFilename = `input_${jobId}${path.extname(req.file.originalname)}`;
    const savedInputPath = await storage.saveFile('uploads', savedFilename, req.file.path);

    // Clean temp multer file if different
    if (req.file.path !== savedInputPath && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }

    // Probe initial metadata (duration, size, codecs) — the same numbers the
    // result screen shows after the run.
    const meta = await FFmpegHelper.probeVideo(savedInputPath);

    const newJob: JobRecord = {
      id: jobId,
      status: 'queued',
      progress: 5,
      message: 'Job queued...',
      khmerMessage: KHMER_QUEUED_MESSAGE,
      inputFile: savedInputPath,
      originalFilename: req.file.originalname,
      inputMimeType: req.file.mimetype,
      inputKind: isAudioUpload(req.file) ? 'audio' : 'video',
      metadata: meta,
      createdAt: new Date().toISOString(),
    };

    await db.createJob(newJob);

    // Trigger asynchronous processing pipeline
    setImmediate(() => {
      SeparationProcessor.processJob(jobId).catch((err) => {
        logger.error(`Error processing job ${jobId}:`, err);
      });
    });

    return res.status(201).json({
      jobId,
      status: 'queued',
      message: 'ឯកសារបានបញ្ចូលដោយជោគជ័យ និងកំពុងចាប់ផ្តើមការញែកសំឡេង...',
      job: newJob,
    });
  } catch (err: any) {
    logger.error('Failed to create job:', err);
    return res.status(500).json({
      error: 'មានបញ្ហាក្នុងការបញ្ចូលឯកសារ។ សូមសាកល្បងម្តងទៀត។',
      details: err?.message,
    });
  }
});

/**
 * GET /api/jobs/:id
 * Get single job details
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    if (!job) {
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
  const jobId = req.params.id;
  const db = getDatabase();
  const job = await db.getJob(jobId);

  if (!job) {
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
 * GET /api/jobs/:id/download?stem=vocals|music&format=mp3|mp4[&inline=1]
 *
 * One route for every deliverable: the separated voice (spoken dialogue and
 * singing) or the music it was lifted out of, as an MP3 — or, for an upload that
 * had a picture, that same stem played over the original video.
 *
 * Byte ranges are honoured so the browser can seek inside the video preview
 * instead of downloading the whole file before the first frame appears.
 */
router.get('/:id/download', async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const job = await db.getJob(req.params.id);

    if (!job) {
      return res.status(404).send('Job not found');
    }
    if (job.status !== 'completed') {
      return res
        .status(400)
        .send('ការញែកសំឡេងមិនទាន់រួចរាល់ទេ។ (Separation not finished)');
    }

    const stem = req.query.stem === 'music' ? 'music' : 'vocals';
    const wantVideo = String(req.query.format || '').toLowerCase() === 'mp4';

    const stored = wantVideo
      ? stem === 'music'
        ? job.musicVideoFile
        : job.vocalsVideoFile
      : stem === 'music'
      ? job.musicFile
      : job.vocalsFile;

    // A restart wipes the local disk, so the file usually has to come back from
    // object storage before it can be streamed.
    const file = await resolveStoredArtifact(stored);
    if (!file) {
      return res
        .status(404)
        .send('ឯកសារនេះមិនអាចរកឃើញទេ។ (That stem is not available for this job.)');
    }

    const size = fs.statSync(file).size;
    const ext = path.extname(file).toLowerCase();
    const contentType =
      ext === '.mp4'
        ? 'video/mp4'
        : ext === '.wav'
        ? 'audio/wav'
        : ext === '.mp3'
        ? 'audio/mpeg'
        : 'application/octet-stream';

    const disposition = String(req.query.inline || '') === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${stem}-${job.id}${ext}"`
    );
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (match) {
      const startRaw = match[1];
      const endRaw = match[2];
      let start = startRaw ? Number(startRaw) : 0;
      let end = endRaw ? Number(endRaw) : size - 1;
      if (!startRaw && endRaw) {
        // A suffix range ("bytes=-500") asks for the last N bytes.
        start = Math.max(0, size - Number(endRaw));
        end = size - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      end = Math.min(end, size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', String(size));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (err: any) {
    logger.error('Download error:', err);
    res.status(500).send('Download failed');
  }
});

/** A job still being processed writes into its directories, so never delete it. */
function isBusy(job: JobRecord): boolean {
  return job.status !== 'completed' && job.status !== 'failed';
}

/**
 * POST /api/jobs/:id/cancel
 * Stop a run that is still processing.
 *
 * The flag lives in the database because the pipeline checks it at every step
 * boundary. A job nobody is running (queued before the server restarted, for
 * example) is finished right here so the button never appears to do nothing.
 */
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'រកមិនឃើញការងារនេះទេ។ (Job not found)' });
    }
    if (!isBusy(job)) {
      return res.json({ ok: true, status: job.status });
    }

    const flagged = await db.updateJob(job.id, { cancelRequested: true });
    jobEvents.emit(`job:${job.id}`, flagged);

    // Nothing is running this job in any process: mark it cancelled now instead
    // of leaving a forever-spinning entry.
    if (!SeparationProcessor.isActive(job.id)) {
      const cancelled = await db.updateJob(job.id, {
        status: 'failed',
        progress: 100,
        message: 'Cancelled by user',
        khmerMessage: KHMER_CANCELLED_MESSAGE,
        error: KHMER_CANCELLED_MESSAGE,
        cancelled: true,
        completedAt: new Date().toISOString(),
      });
      await getStorage().cleanProcessingDir(job.id);
      jobEvents.emit(`job:${job.id}`, cancelled);
      return res.json({ ok: true, status: 'failed', cancelled: true });
    }

    logger.info(`Cancel requested for job ${job.id} by the studio`);
    return res.json({ ok: true, cancelling: true });
  } catch (err: any) {
    logger.error('Failed to cancel job:', err);
    return res.status(500).json({ error: 'មិនអាចបោះបង់ការងារនេះបានទេ។' });
  }
});

export default router;
