import fs from 'fs';
import path from 'path';
import { getDatabase } from './db.js';
import { getStorage } from './storage.js';
import {
  JobCancelledError,
  KHMER_CANCELLED_MESSAGE,
  jobEvents,
  muxStemOverVideo,
} from './separationJob.js';
import { generateGeminiJson } from './geminiPool.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';
import { CleanupReport, JobRecord, NoiseSpan } from '../types.js';

/**
 * «សម្អាតសំឡេង» — keep the voice, throw the noise away.
 *
 * This is the second product, and it is deliberately separate from stem
 * separation: the visitor here already *has* a vocal take (a singing recording,
 * a voice memo) and wants the disturbance gone — hiss, hum, wind, a fan, a
 * passing motorbike, a chair squeak between phrases.
 *
 * Gemini cannot emit audio, and no API can: so it is used for what it is good at
 * — listening. Each slice of the recording is sent to the model, which answers
 * with JSON: where the voice is, and which spans contain *only* noise. FFmpeg
 * then does the editing the model asked for (remove those spans, denoise, even
 * the level) because cutting audio is exactly what FFmpeg is good at.
 *
 * Every model answer is treated as a suggestion, not a command: spans are
 * clamped to the clip, tiny ones dropped, overlapping ones merged, and the total
 * removed is capped, because a model that decides half the song is noise would
 * otherwise return a 30-second file and call it a success.
 */

const ANALYSIS_CHUNK_SECONDS = Number(process.env.GEMINI_CLEANUP_CHUNK_SECONDS || 120);
/** Above this, one request's audio would be megabytes of base64. */
const MAX_CHUNK_SECONDS = 240;
/** A span shorter than this is a click, not a pause worth editing around. */
const MIN_SPAN_SECONDS = 0.25;
/** Segments the model is less sure than this about are ignored. */
const MIN_CONFIDENCE = 0.4;
/** Never remove more than this share of the recording, whatever the model says. */
const MAX_REMOVED_SHARE = 0.6;
/** The cut expression is one FFmpeg argument; keep it a sane length. */
const MAX_CUT_SPANS = 64;

/**
 * How many parts of one recording are sent to Gemini at the same time.
 *
 * Each part is its own request — upload the audio, let the model listen, read
 * its JSON answer — and the parts do not depend on one another, so answering
 * them one after another was pure waiting: a five-part take waited for five
 * answers in a row. The number stays modest because a free key has a
 * per-minute limit and the pool needs room to rotate keys instead of tripping
 * it.
 */
const CONCURRENCY = Math.max(1, Number(process.env.GEMINI_CLEANUP_CONCURRENCY || 3));

/** The jobs this process is cleaning right now. */
const activeJobs = new Set<string>();

const KHMER_MESSAGES = {
  extracting: 'កំពុងអានបន្ទាត់សំឡេងពីឯកសារ...',
  analysing: 'Gemini កំពុងស្តាប់ និងរកកន្លែងដែលមានសំឡេងរំខាន...',
  cleaning: 'កំពុងកាត់សំឡេងរំខានចេញ ដោយរក្សាសំឡេងដើមដដែល...',
  packaging: 'កំពុងបម្លែងសំឡេងស្អាតទៅជាឯកសារទាញយក...',
  done: 'សម្អាតសំឡេងរួចរាល់! អ្នកអាចស្តាប់ប្រៀបធៀប និងទាញយកបានហើយ។',
};

/** One stretch the model says holds nothing but disturbance. */
interface ChunkNoise {
  start: number;
  end: number;
  kind?: string;
  confidence?: number;
}

interface ChunkVerdict {
  voice: boolean;
  speechFraction: number;
  noise: ChunkNoise[];
}

const ANALYSIS_PROMPT = (index: number, count: number, lengthSeconds: number) =>
  `You are an audio editor cutting a single performer's take (one singer, or one speaker) for release.

You are hearing part ${index} of ${count} of the recording. This part is ${lengthSeconds.toFixed(
    1
  )} seconds long.

The performer is the voice this recording is about: the closest, most continuous one. Everything else in the room is disturbance and should be cut out: hiss, hum, electrical buzz, wind, fan or air-conditioning, room rumble, traffic, clicks and pops, chair squeaks, papers, crowd noise, music or TV/radio bleeding in, and other people talking around the performer.

Mark the stretches that do NOT belong to the performer's voice.

Rules — follow them exactly:
- Never include a stretch where the performer is audible, even a syllable or a note. When you cannot tell whether a voice is the performer or someone else, leave the stretch in.
- Someone talking over the performer cannot be removed by cutting without losing the performance — only mark voices that sit in their own separate stretch.
- Pauses, breaths and tails inside the performance are part of it: leave them in.
- Spans are in seconds from the START OF THIS PART (0 = the first sample you hear), boundaries accurate to about 0.1 s, each span at least 0.2 s long.

Answer with JSON only, in this exact shape:
{"voice": true|false, "speechFraction": 0.0-1.0, "noise": [{"start": 0.0, "end": 0.0, "kind": "hiss|hum|click|wind|rumble|fan|chatter|other-voices|crowd|music|other", "confidence": 0.0-1.0, "why": "short reason"}]}`;

/** Accept seconds, milliseconds or a mm:ss string; return seconds. */
function toSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const clock = /^(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Turn the model's answer into spans this process trusts.
 *
 * Numbers that look like milliseconds (a 5-second clip answered with 4200) are
 * rescaled rather than clamped to the end of the clip, which is how a whole
 * chunk used to end up "noise".
 */
function readVerdict(value: unknown, chunkLength: number): ChunkVerdict {
  const raw = (value ?? {}) as any;
  const verdict: ChunkVerdict = {
    voice: raw.voice !== false,
    speechFraction:
      typeof raw.speechFraction === 'number' && Number.isFinite(raw.speechFraction)
        ? Math.min(1, Math.max(0, raw.speechFraction))
        : 1,
    noise: [],
  };

  const list = Array.isArray(raw.noise) ? raw.noise : Array.isArray(raw.segments) ? raw.segments : [];
  const looksLikeMs = list.some((item: any) => {
    const start = toSeconds(item?.start);
    return start !== null && start > chunkLength * 1.5 && start <= chunkLength * 1500;
  });

  for (const item of list) {
    const rawStart = toSeconds(item?.start);
    const rawEnd = toSeconds(item?.end);
    if (rawStart === null || rawEnd === null) continue;
    const scale = looksLikeMs ? 1 / 1000 : 1;
    const start = rawStart * scale;
    const end = rawEnd * scale;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const clampedStart = Math.max(0, start);
    const clampedEnd = Math.min(chunkLength, end);
    if (clampedEnd - clampedStart < MIN_SPAN_SECONDS) continue;
    verdict.noise.push({
      start: clampedStart,
      end: clampedEnd,
      kind: typeof item?.kind === 'string' ? item.kind.slice(0, 24) : undefined,
      confidence:
        typeof item?.confidence === 'number' && Number.isFinite(item.confidence)
          ? Math.min(1, Math.max(0, item.confidence))
          : 0.7,
    });
  }

  return verdict;
}

/**
 * Merge the per-chunk answers into one list of absolute spans, then keep only
 * the ones worth acting on: confident, long enough, and — across the whole file
 * — no more than a third of the recording, so a bad opinion cannot delete the
 * performance.
 */
function planCuts(
  spans: NoiseSpan[],
  duration: number
): { cuts: NoiseSpan[]; removedSeconds: number; candidates: number } {
  const candidates = spans.length;

  const sorted = spans
    .filter((span) => (span.confidence ?? 0) >= MIN_CONFIDENCE)
    .filter((span) => span.end - span.start >= MIN_SPAN_SECONDS)
    .sort((a, b) => a.start - b.start);

  // Merge spans that touch or nearly touch: cutting two pieces 50 ms apart
  // sounds far worse than cutting the breath between them.
  const merged: NoiseSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start - last.end <= 0.16) {
      last.end = Math.max(last.end, span.end);
      last.confidence = Math.max(last.confidence ?? 0, span.confidence ?? 0);
    } else {
      merged.push({ ...span });
    }
  }

  const budget = duration * MAX_REMOVED_SHARE;
  const byConfidence = [...merged].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const accepted = new Set<NoiseSpan>();
  let removedSeconds = 0;
  for (const span of byConfidence) {
    const length = span.end - span.start;
    if (removedSeconds + length > budget) continue;
    accepted.add(span);
    removedSeconds += length;
  }

  const cuts = merged
    .filter((span) => accepted.has(span))
    .slice(0, MAX_CUT_SPANS)
    .sort((a, b) => a.start - b.start);
  const finalSeconds = cuts.reduce((sum, span) => sum + (span.end - span.start), 0);

  return { cuts, removedSeconds: finalSeconds, candidates };
}

/**
 * The FFmpeg filter that does the actual editing.
 *
 * Order matters: first the model's spans are dropped (`aselect` keeps every
 * frame outside them and `asetpts` closes the gaps), then the remaining noise
 * floor is pulled down with `afftdn`, the sub-bass rumble and the top-end hiss
 * are band-limited, and the level is normalised so the result is not quieter
 * than the original.
 */
function cleanupFilters(cuts: NoiseSpan[]): string {
  const filters: string[] = [];

  if (cuts.length) {
    // The expression is quoted: a filter argument is split on commas, so
    // `between(t,a,b)` has to be quoted or escaped, and getting that wrong turns
    // "4.00" into a filter name ("No such filter: '4.00'"). Single quotes make
    // the commas literal, and the sum is 0 exactly where the performer is, so
    // `not(...)` keeps every frame that belongs to the voice.
    const expr = `not(${cuts
      .map((span) => `between(t,${span.start.toFixed(2)},${span.end.toFixed(2)})`)
      .join('+')})`;
    filters.push(`aselect='${expr}'`, 'asetpts=N/SR/TB');
  }

  // Off by default: the owner wants the take to keep its own sound, and an
  // EQ/denoise/loudnorm chain audibly re-tones a voice. `GEMINI_CLEANUP_NR`
  // enables a gentle `afftdn` pass for a recording whose hiss must go too.
  const nr = Number(process.env.GEMINI_CLEANUP_NR || '0');
  if (Number.isFinite(nr) && nr > 0) {
    filters.push(`afftdn=nr=${nr}:nf=${process.env.GEMINI_CLEANUP_NF || '-32'}`);
  }

  return filters.join(',');
}

export class CleanupProcessor {
  static isActive(jobId: string): boolean {
    return activeJobs.has(jobId);
  }

  /**
   * Run one cleanup. Like the separator, it never throws out of here: the reason
   * is written onto the job so the studio can show a red card instead of a job
   * that spins forever.
   */
  static async processJob(jobId: string): Promise<void> {
    if (activeJobs.has(jobId)) return;
    const db = getDatabase();
    const initial = await db.getJob(jobId);
    if (!initial) return;

    activeJobs.add(jobId);
    const workDir = path.join(process.cwd(), 'data', 'processing', jobId);
    fs.mkdirSync(workDir, { recursive: true });

    const update = async (updates: Partial<JobRecord>) => {
      const updated = await db.updateJob(jobId, updates);
      if (updated) jobEvents.emit(`job:${jobId}`, updated);
    };

    const checkpoint = async () => {
      const fresh = await db.getJob(jobId);
      if (fresh?.cancelRequested) throw new JobCancelledError();
    };

    try {
      const job = initial;
      logger.info(`Cleaning ${job.originalFilename} (${job.id})`);

      // ----------------------------------------------------------- extract
      await update({
        status: 'extracting_audio',
        progress: 10,
        message: 'Reading the audio track...',
        khmerMessage: KHMER_MESSAGES.extracting,
      });
      await checkpoint();

      const inputWav = path.join(workDir, 'input.wav');
      await FFmpegHelper.extractAudio(job.inputFile, inputWav);
      const duration = await FFmpegHelper.getAudioDuration(inputWav);
      if (!duration || duration <= 0) {
        throw new Error('the uploaded file has no playable audio track');
      }

      // ---------------------------------------------------------- analyse
      const chunkSeconds = Math.min(
        MAX_CHUNK_SECONDS,
        Math.max(30, Math.round(duration > ANALYSIS_CHUNK_SECONDS * 40 ? duration / 40 : ANALYSIS_CHUNK_SECONDS))
      );
      const chunkCount = Math.max(1, Math.ceil(duration / chunkSeconds));

      await update({
        status: 'analyzing_audio',
        progress: 20,
        message: `Listening to the recording with Gemini (${chunkCount} part${
          chunkCount === 1 ? '' : 's'
        })...`,
        khmerMessage: KHMER_MESSAGES.analysing,
        metadata: { ...(job.metadata || { duration, sizeBytes: 0 }), duration },
      });

      const spans: NoiseSpan[] = [];
      let analysed = 0;
      let servedModel = '';
      let servedKey = '';
      let failedChunks = 0;

      // The parts this run will analyse, in order; a tail shorter than a blink
      // is not worth a request.
      const parts: { index: number; start: number; length: number }[] = [];
      for (let index = 0; index < chunkCount; index++) {
        const start = index * chunkSeconds;
        const length = Math.min(chunkSeconds, duration - start);
        if (length <= 0.2) break;
        parts.push({ index, start, length });
      }

      let completedParts = 0;
      let nextPart = 0;

      /** Cut one part out, ask Gemini what is noise in it, and record the spans. */
      const analysePart = async (part: { index: number; start: number; length: number }) => {
        const { index, start, length } = part;
        await checkpoint();

        const chunkPath = path.join(workDir, `chunk_${index}.mp3`);
        // Mono 16 kHz is plenty for the model to hear what is noise: it keeps a
        // two-minute chunk around 700 KB instead of tens of megabytes of WAV.
        await FFmpegHelper.execute([
          '-y', '-v', 'error',
          '-ss', start.toFixed(3),
          '-t', length.toFixed(3),
          '-i', inputWav,
          '-vn',
          '-ac', '1',
          '-ar', '16000',
          '-codec:a', 'libmp3lame',
          '-b:a', '48k',
          chunkPath,
        ]);

        try {
          const result = await generateGeminiJson<ChunkVerdict>({
            prompt: ANALYSIS_PROMPT(index + 1, chunkCount, length),
            audio: { base64: fs.readFileSync(chunkPath).toString('base64'), mimeType: 'audio/mp3' },
            maxOutputTokens: 2048,
            label: `cleanup chunk ${index + 1}/${chunkCount}`,
            parse: (value) => readVerdict(value, length),
          });
          servedModel = result.model;
          servedKey = result.keyLabel;
          analysed++;

          for (const noise of result.data.noise) {
            spans.push({
              start: start + noise.start,
              end: start + noise.end,
              kind: noise.kind,
              confidence: noise.confidence,
            });
          }
        } catch (err: any) {
          // One part the model could not read should not throw away the parts it
          // did read — unless every part failed, which is reported below.
          failedChunks++;
          logger.warn(`Cleanup chunk ${index + 1}/${chunkCount} failed: ${err?.message || err}`);
        } finally {
          if (fs.existsSync(chunkPath)) {
            try {
              fs.unlinkSync(chunkPath);
            } catch {}
          }
        }

        completedParts++;
        const pct = 20 + Math.round((completedParts / parts.length) * 35);
        await update({
          progress: Math.min(55, pct),
          message: `Listening with Gemini... ${completedParts}/${parts.length}`,
          khmerMessage:
            parts.length > 1
              ? `${KHMER_MESSAGES.analysing.replace('...', '')} — កំណាត់ ${completedParts}/${parts.length}`
              : KHMER_MESSAGES.analysing,
        });
      };

      // A small pool of workers pulls the parts off one shared cursor, so no part
      // is sent twice and the slowest answer is not the one that decides when the
      // next request starts.
      const workerCount = Math.max(1, Math.min(CONCURRENCY, parts.length || 1));
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            const part = parts[nextPart++];
            if (!part) return;
            await analysePart(part);
          }
        })
      );

      if (analysed === 0) {
        throw new Error(
          'Gemini មិនអាចវិភាគសំឡេងនេះបានទេ។ (Gemini could not analyse any part of this file.)'
        );
      }

      // ----------------------------------------------------------- clean
      const plan = planCuts(spans, duration);
      await checkpoint();

      await update({
        status: 'cleaning_audio',
        progress: 62,
        message: plan.cuts.length
          ? `Cutting ${plan.cuts.length} noise stretch(es) out...`
          : 'No noise stretch worth cutting — keeping the take as recorded',
        khmerMessage: KHMER_MESSAGES.cleaning,
      });

      const cleanWav = path.join(workDir, 'clean.wav');
      const filter = cleanupFilters(plan.cuts);
      // With nothing to cut and no denoise, the audio passes through as it is:
      // this studio removes what is *around* the voice, never re-tones the voice.
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-i', inputWav,
        ...(filter ? ['-af', filter] : []),
        '-ac', '2',
        '-ar', '44100',
        cleanWav,
      ]);

      // --------------------------------------------------------- package
      await update({
        status: 'mixing',
        progress: 86,
        message: 'Encoding the cleaned audio...',
        khmerMessage: KHMER_MESSAGES.packaging,
      });

      const storage = getStorage();
      const cleanMp3 = path.join(workDir, `clean_${jobId}.mp3`);
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-i', cleanWav,
        '-codec:a', 'libmp3lame', '-q:a', '2',
        cleanMp3,
      ]);
      await checkpoint();

      const cleanFile = await storage.saveFile('outputs', `clean_${jobId}.mp3`, cleanMp3);

      // A video upload gets its cleaned sound back over its own picture: the
      // sound is the point, but nobody wants to mux it by hand afterwards.
      let cleanVideoFile: string | undefined;
      if (job.inputKind === 'video') {
        const muxed = await muxStemOverVideo(
          job.inputFile,
          cleanWav,
          path.join(workDir, `clean_${jobId}.mp4`)
        );
        if (muxed) {
          cleanVideoFile = await storage.saveFile('outputs', `clean_${jobId}.mp4`, muxed);
        }
      }

      const report: CleanupReport = {
        model: servedModel || 'gemini',
        keyLabel: servedKey || 'Key 1',
        chunks: chunkCount,
        chunksAnalysed: analysed,
        chunksFailed: failedChunks,
        spansFound: plan.candidates,
        spansRemoved: plan.cuts.length,
        removedSeconds: Number(plan.removedSeconds.toFixed(2)),
        originalSeconds: Number(duration.toFixed(2)),
      };

      await update({
        status: 'completed',
        progress: 100,
        message: 'Cleanup finished',
        khmerMessage: KHMER_MESSAGES.done,
        cleanFile,
        cleanVideoFile,
        cleanup: report,
        metadata: { ...(job.metadata || { duration, sizeBytes: 0 }), duration },
        completedAt: new Date().toISOString(),
      });
      logger.info(
        `Cleanup finished for job ${jobId}: ${plan.cuts.length} span(s), ${plan.removedSeconds.toFixed(
          1
        )}s removed by ${report.model}/${report.keyLabel}`
      );
    } catch (err: any) {
      const cancelled = err instanceof JobCancelledError;
      const reason = cancelled
        ? KHMER_CANCELLED_MESSAGE
        : err?.message || 'ការសម្អាតសំឡេងបរាជ័យ។ (Cleanup failed.)';
      logger.warn(`Cleanup ${jobId} ended: ${reason}`);

      await update({
        status: 'failed',
        progress: 100,
        message: reason,
        khmerMessage: cancelled ? KHMER_CANCELLED_MESSAGE : 'ការសម្អាតសំឡេងបរាជ័យ',
        error: reason,
        technicalError: cancelled ? undefined : String(err?.stack || err),
        cancelled,
        completedAt: new Date().toISOString(),
      });
    } finally {
      activeJobs.delete(jobId);
      await getStorage().cleanProcessingDir(jobId).catch(() => {});
    }
  }
}
