import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { getDatabase } from './db.js';
import { getStorage } from './storage.js';
import { getAudioSeparationProvider } from './audioSeparation.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';
import { JobRecord } from '../types.js';

/**
 * The whole product: take one file apart into the human voice and the music.
 *
 * A dubbing pipeline used to sit between the upload and the stems — speech was
 * transcribed, translated and re-voiced — and the separator was only its first
 * step. The studio no longer translates anything, so this processor is the
 * pipeline: extract the audio, let Demucs split voice from music, then hand both
 * back as downloadable files. Nothing here re-encodes the picture, except the
 * optional video twin where a stem is muxed over the original video track with
 * a stream copy, because a phone preview of the result is worth more than the
 * bytes saved.
 */

/** Progress updates reach the browser over this stream (see `/api/jobs/:id/events`). */
export const jobEvents = new EventEmitter();

/** The jobs this process is running right now. */
const activeJobs = new Set<string>();

/** The studio asked to stop, and the pipeline reached the next checkpoint. */
export class JobCancelledError extends Error {
  constructor() {
    super('cancelled by user');
    this.name = 'JobCancelledError';
  }
}

export const KHMER_CANCELLED_MESSAGE = 'ការងារត្រូវបានបោះបង់ដោយអ្នកប្រើប្រាស់។';

const KHMER_MESSAGES = {
  queued: 'កំពុងស្ថិតក្នុងជួររង់ចាំ...',
  extracting: 'កំពុងអានបន្ទាត់សំឡេងពីឯកសារ...',
  separating: 'កំពុងញែកសំឡេងនិយាយ និងសំឡេងច្រៀងចេញពីភ្លេង (Demucs)...',
  packaging: 'កំពុងបម្លែងសំឡេងដែលបានញែកទៅជាឯកសារទាញយក...',
  done: 'ញែកសំឡេងរួចរាល់! អ្នកអាចទាញយកសំឡេង និងភ្លេងបានហើយ។',
};

/** How a stem download is named, and where it is stored. */
export function stemFilename(jobId: string, stem: 'vocals' | 'music', ext: 'mp3' | 'mp4'): string {
  return `${stem}_${jobId}.${ext}`;
}

export class SeparationProcessor {
  static isActive(jobId: string): boolean {
    return activeJobs.has(jobId);
  }

  /**
   * Run one separation from start to finish. Failures never throw out of here:
   * they are written onto the job, which is what the studio polls and streams,
   * so a dead stem service ends as a red card with the reason instead of an
   * unhandled rejection in the server log.
   */
  static async processJob(jobId: string): Promise<void> {
    if (activeJobs.has(jobId)) return;
    const db = getDatabase();
    const initial = await db.getJob(jobId);
    if (!initial) return;

    activeJobs.add(jobId);
    const workDir = path.join(process.cwd(), 'data', 'processing', jobId);
    fs.mkdirSync(workDir, { recursive: true });

    /** Write the stage onto the job and push it to any open browser tab. */
    const update = async (updates: Partial<JobRecord>) => {
      const updated = await db.updateJob(jobId, updates);
      if (updated) jobEvents.emit(`job:${jobId}`, updated);
    };

    /** The stop flag lives in the database; this is where it is obeyed. */
    const checkpoint = async () => {
      const fresh = await db.getJob(jobId);
      if (fresh?.cancelRequested) throw new JobCancelledError();
    };

    try {
      const job = initial;
      logger.info(`Separating ${job.originalFilename} (${job.id})`);

      // ---------------------------------------------------------- extract
      await update({
        status: 'extracting_audio',
        progress: 20,
        message: 'Reading the audio track...',
        khmerMessage: KHMER_MESSAGES.extracting,
      });
      await checkpoint();

      // FFmpeg's `-vn` makes this a no-op pass for a pure audio file and the
      // one place a video loses its picture: Demucs only ever sees 44.1 kHz
      // stereo WAV, whatever was uploaded.
      const inputWav = path.join(workDir, 'input.wav');
      await FFmpegHelper.extractAudio(job.inputFile, inputWav);
      const duration = await FFmpegHelper.getAudioDuration(inputWav);
      if (!duration || duration <= 0) {
        throw new Error('the uploaded file has no playable audio track');
      }

      // -------------------------------------------------------- separate
      await update({
        status: 'separating_audio',
        progress: 35,
        message: 'Separating voice from music (Demucs)...',
        khmerMessage: KHMER_MESSAGES.separating,
        metadata: { ...(job.metadata || { duration, sizeBytes: 0 }), duration },
      });
      await checkpoint();

      const provider = getAudioSeparationProvider();
      const stems = await provider.separate(inputWav, workDir);
      await checkpoint();

      // -------------------------------------------------------- package
      await update({
        status: 'mixing',
        progress: 82,
        message: 'Encoding the separated tracks...',
        khmerMessage: KHMER_MESSAGES.packaging,
      });

      const storage = getStorage();
      const vocalsMp3 = path.join(workDir, stemFilename(jobId, 'vocals', 'mp3'));
      const musicMp3 = path.join(workDir, stemFilename(jobId, 'music', 'mp3'));

      // VBR q2 is ~190 kbps: indistinguishable from the WAV for this material,
      // and an order of magnitude smaller to store and download.
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-i', stems.vocalsPath,
        '-codec:a', 'libmp3lame', '-q:a', '2',
        vocalsMp3,
      ]);
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-i', stems.noVocalsPath,
        '-codec:a', 'libmp3lame', '-q:a', '2',
        musicMp3,
      ]);
      await checkpoint();

      const vocalsFile = await storage.saveFile(
        'outputs',
        stemFilename(jobId, 'vocals', 'mp3'),
        vocalsMp3
      );
      const musicFile = await storage.saveFile(
        'outputs',
        stemFilename(jobId, 'music', 'mp3'),
        musicMp3
      );

      // A video upload also gets each stem played over the original picture, so
      // "which part of this video did I just separate" can be answered by
      // watching instead of by ear. The picture is stream-copied, so this costs
      // a minute of the phone's CPU rather than a full re-encode.
      let vocalsVideoFile: string | undefined;
      let musicVideoFile: string | undefined;
      if (job.inputKind === 'video') {
        const vocalsVideo = await muxStemOverVideo(
          job.inputFile,
          stems.vocalsPath,
          path.join(workDir, stemFilename(jobId, 'vocals', 'mp4'))
        );
        const musicVideo = await muxStemOverVideo(
          job.inputFile,
          stems.noVocalsPath,
          path.join(workDir, stemFilename(jobId, 'music', 'mp4'))
        );
        if (vocalsVideo) {
          vocalsVideoFile = await storage.saveFile(
            'outputs',
            stemFilename(jobId, 'vocals', 'mp4'),
            vocalsVideo
          );
        }
        if (musicVideo) {
          musicVideoFile = await storage.saveFile(
            'outputs',
            stemFilename(jobId, 'music', 'mp4'),
            musicVideo
          );
        }
      }

      await update({
        status: 'completed',
        progress: 100,
        message: 'Separation finished',
        khmerMessage: KHMER_MESSAGES.done,
        vocalsFile,
        musicFile,
        vocalsVideoFile,
        musicVideoFile,
        metadata: { ...(job.metadata || { duration, sizeBytes: 0 }), duration },
        completedAt: new Date().toISOString(),
      });
      logger.info(`Separation finished for job ${jobId}`);
    } catch (err: any) {
      const cancelled = err instanceof JobCancelledError;
      const reason = cancelled
        ? KHMER_CANCELLED_MESSAGE
        : err?.message || 'ការញែកសំឡេងបរាជ័យ។ (Separation failed.)';
      logger.warn(`Separation ${jobId} ended: ${reason}`);

      await update({
        status: 'failed',
        progress: 100,
        message: reason,
        khmerMessage: cancelled ? KHMER_CANCELLED_MESSAGE : 'ការញែកសំឡេងបរាជ័យ',
        error: reason,
        technicalError: cancelled ? undefined : String(err?.stack || err),
        cancelled,
        completedAt: new Date().toISOString(),
      });
    } finally {
      activeJobs.delete(jobId);
      // The stems now live in storage; the cut pieces and WAVs they were built
      // from are megabytes of nothing and are removed here.
      await getStorage().cleanProcessingDir(jobId).catch(() => {});
    }
  }
}

/**
 * Play one stem over the original picture. Returns null when the container
 * refuses the copy (a WebM codec that no MP4 player accepts, a picture stream
 * FFmpeg cannot attach): the audio downloads still work, and a failed twin must
 * never fail the separation that already succeeded.
 */
async function muxStemOverVideo(
  videoPath: string,
  stemWavPath: string,
  target: string
): Promise<string | null> {
  try {
    await FFmpegHelper.execute([
      '-y', '-v', 'error',
      '-i', videoPath,
      '-i', stemWavPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      target,
    ]);
    return fs.existsSync(target) && fs.statSync(target).size > 1024 ? target : null;
  } catch (err) {
    logger.warn(`Could not mux a stem over the original video (${videoPath}):`, err);
    return null;
  }
}
