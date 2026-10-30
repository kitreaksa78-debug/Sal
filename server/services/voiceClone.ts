import fs from 'fs';
import path from 'path';
import https from 'https';
import { getDatabase } from './db.js';
import { getStorage, resolveStoredArtifact } from './storage.js';
import { JobCancelledError, KHMER_CANCELLED_MESSAGE, jobEvents } from './separationJob.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';
import { JobRecord, VoiceCloneReport } from '../types.js';

/**
 * «សំឡេងដូចដើម» — the Khmer words, restyled into the original singer's voice.
 *
 * The studio keeps two things a voice converter needs: the words in Khmer with
 * no music (`khmerSpeechFile`) and the original voice with no music
 * (`vocalsFile`). The Khmer speech is the content, a dozen seconds of the
 * original voice is the reference, and the output is those Khmer words carrying
 * the original timbre.
 *
 * Free GPU spaces (Hugging Face ZeroGPU) answer server-to-server calls with an
 * error and Render has no GPU, so the model runs on a hosted inference API. The
 * model is asked for its own schema first, so whichever converter is configured,
 * the two audio fields are found by name instead of being guessed.
 */

const REPLICATE_API = 'https://api.replicate.com/v1';
/** How much of the original voice is used as the timbre reference. */
const REF_SECONDS = 12;
/** A converter holds one phrase well; longer parts drift and get wobbly. */
const CHUNK_SECONDS = Math.max(8, Number(process.env.VOICE_CLONE_CHUNK_SECONDS || 20));
const MAX_CHUNKS = 40;
const POLL_INTERVAL_MS = 2500;
const PREDICTION_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.VOICE_CLONE_TIMEOUT_MS || 480_000)
);

const KHMER_MESSAGES = {
  preparing: 'កំពុងរៀបចំសំឡេងសម្រាប់ប្តូរសំឡេង...',
  converting: 'កំពុងប្តូរសំឡេងខ្មែរ ទៅជាសំឡេងដើម...',
  mixing: 'កំពុងលាយសំឡេងថ្មីជាមួយភ្លេងដើម...',
  done: 'សំឡេងដូចដើមរួចរាល់! ស្តាប់ និងទាញយកបានហើយ។',
};

/** Shown when the deployment has no inference key yet. */
export const VOICE_CLONE_KEY_MESSAGE =
  'ប្តូរសំឡេងត្រូវការ key របស់សេវា AI។ សូមបញ្ចូល REPLICATE_API_TOKEN ក្នុង Render → Environment សិន។ (Add REPLICATE_API_TOKEN to the deployment.)';

/** The jobs this process is restyling right now. */
const activeJobs = new Set<string>();

export function getVoiceCloneToken(): string | null {
  const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_TOKEN || '';
  return token.trim() ? token.trim() : null;
}

export function voiceCloneModel(): string {
  return (process.env.VOICE_CLONE_MODEL || 'lucataco/singing_voice_conversion').trim();
}

export function isVoiceCloneConfigured(): boolean {
  return Boolean(getVoiceCloneToken());
}

/** A JSON call to the inference API, with the token that the deployment holds. */
function requestJson(
  url: string,
  token: string,
  init: { method?: string; body?: unknown } = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? null : Buffer.from(JSON.stringify(init.body));
    const req = https.request(
      url,
      {
        method: init.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
        },
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`inference API ${status}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            reject(new Error(`inference API returned no JSON: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('inference API request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Write a remote file to disk, following the CDN redirect the output lives behind. */
function downloadToFile(url: string, destination: string, hops = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hops > 5) {
      reject(new Error('too many redirects'));
      return;
    }
    https
      .get(url, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          downloadToFile(res.headers.location, destination, hops + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`download failed with ${status}`));
          return;
        }
        const file = fs.createWriteStream(destination);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

interface ModelSchema {
  /** The field that receives the words to restyle. */
  sourceField: string;
  /** The field that receives the reference voice, when the model has one. */
  targetField: string | null;
  /** Every other field, filled with the model's own default. */
  defaults: Record<string, unknown>;
}

/**
 * Ask the model what it accepts.
 *
 * Converter models disagree about names (`source_audio`, `input_audio`,
 * `source`, …), so the audio fields are found by shape and by meaning rather
 * than by a hard-coded list — a different model can be configured without a code
 * change.
 */
async function readModelSchema(token: string, model: string): Promise<ModelSchema> {
  const meta = await requestJson(`${REPLICATE_API}/models/${model}`, token);
  const inputSchema = meta?.latest_version?.openapi_schema?.components?.schemas?.Input;
  const properties: Record<string, any> = inputSchema?.properties || {};
  const required: string[] = Array.isArray(inputSchema?.required) ? inputSchema.required : [];

  const fileFields: string[] = [];
  const defaults: Record<string, unknown> = {};

  for (const [name, spec] of Object.entries(properties)) {
    const type = String(spec?.type || '');
    const format = String(spec?.format || '');
    const describesAudio = /(audio|voice|speech|sing)/i.test(
      `${name} ${String(spec?.description || '')}`
    );
    const isFile = format === 'uri' || format === 'data-url' || (type === 'string' && describesAudio);

    if (isFile) {
      fileFields.push(name);
      continue;
    }
    if (spec?.default !== undefined) {
      defaults[name] = spec.default;
    } else if (required.includes(name)) {
      defaults[name] = type === 'boolean' ? false : type === 'string' ? '' : 0;
    }
  }

  if (!fileFields.length) {
    throw new Error(`model ${model} accepts no audio input`);
  }

  const sourceField =
    fileFields.find((field) => /source|input|speech|content|src/i.test(field)) || fileFields[0];
  const targetField =
    fileFields.find(
      (field) => field !== sourceField && /target|ref|style|timbre|prompt|voice|speaker/i.test(field)
    ) ||
    fileFields.find((field) => field !== sourceField) ||
    null;

  return { sourceField, targetField, defaults };
}

/** Run one conversion and return the URL of the audio it produced. */
async function convertOnce(
  token: string,
  model: string,
  schema: ModelSchema,
  speechPath: string,
  refPath: string,
  checkpoint: () => Promise<void>
): Promise<string> {
  const input: Record<string, unknown> = { ...schema.defaults };
  input[schema.sourceField] = `data:audio/wav;base64,${fs.readFileSync(speechPath).toString('base64')}`;
  if (schema.targetField) {
    input[schema.targetField] = `data:audio/wav;base64,${fs.readFileSync(refPath).toString('base64')}`;
  }

  let prediction = await requestJson(`${REPLICATE_API}/models/${model}/predictions`, token, {
    method: 'POST',
    body: { input },
  });

  const startedAt = Date.now();
  while (prediction?.status === 'starting' || prediction?.status === 'processing') {
    if (Date.now() - startedAt > PREDICTION_TIMEOUT_MS) {
      throw new Error('the voice service took too long to answer');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    await checkpoint();
    prediction = await requestJson(`${REPLICATE_API}/predictions/${prediction.id}`, token);
  }

  if (prediction?.status !== 'succeeded') {
    throw new Error(String(prediction?.error || `the voice service answered ${prediction?.status}`));
  }

  const output = prediction.output;
  const url =
    typeof output === 'string'
      ? output
      : Array.isArray(output)
      ? output.find((entry: unknown) => typeof entry === 'string')
      : null;
  if (!url) throw new Error('the voice service returned no audio');
  return url as string;
}

export class VoiceCloneProcessor {
  static isActive(jobId: string): boolean {
    return activeJobs.has(jobId);
  }

  /**
   * Restyle one Khmer version. Like the other processors this never throws out
   * of the function: the reason goes onto the job, so the studio shows a red
   * card instead of a spinner that never stops.
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
      const token = getVoiceCloneToken();
      const model = voiceCloneModel();
      if (!token) throw new Error(VOICE_CLONE_KEY_MESSAGE);

      logger.info(`Restyling ${job.id} with ${model}`);

      await update({
        status: 'extracting_audio',
        progress: 6,
        message: 'Reading the Khmer words and the original voice...',
        khmerMessage: KHMER_MESSAGES.preparing,
      });
      await checkpoint();

      const speechSource = await resolveStoredArtifact(job.khmerSpeechFile, 'outputs');
      if (!speechSource) {
        throw new Error(
          'រកសំឡេងខ្មែរឥតភ្លេងមិនឃើញទេ។ សូមបង្កើតបទខ្មែរម្តងទៀត។ (The Khmer speech track is gone.)'
        );
      }
      const refSource = await resolveStoredArtifact(job.vocalsFile, 'outputs');
      if (!refSource) {
        throw new Error(
          'រកសំឡេងដើមមិនឃើញទេ។ សូមញែកសំឡេងម្តងទៀត។ (The original voice is gone.)'
        );
      }

      // 16 kHz mono is what voice converters expect, and it keeps every request
      // small enough to be sent inside the JSON body.
      const refWav = path.join(workDir, 'ref.wav');
      const speechWav = path.join(workDir, 'speech.wav');
      const refDuration = await FFmpegHelper.getAudioDuration(refSource);
      const refStart = Math.max(0, refDuration / 2 - REF_SECONDS / 2);
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-ss', refStart.toFixed(2),
        '-t', String(REF_SECONDS),
        '-i', refSource,
        '-ac', '1', '-ar', '16000',
        refWav,
      ]);
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-i', speechSource,
        '-ac', '1', '-ar', '16000',
        speechWav,
      ]);

      const duration = await FFmpegHelper.getAudioDuration(speechWav);
      if (!duration || duration <= 0) throw new Error('the Khmer speech track is empty');

      const chunkDir = path.join(workDir, 'chunks');
      const outDir = path.join(workDir, 'converted');
      fs.rmSync(chunkDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(chunkDir, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });

      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-i', speechWav,
        '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
        '-c:a', 'pcm_s16le',
        path.join(chunkDir, 'part_%03d.wav'),
      ]);

      const chunks = fs
        .readdirSync(chunkDir)
        .filter((name) => name.endsWith('.wav'))
        .sort()
        .slice(0, MAX_CHUNKS);
      if (!chunks.length) throw new Error('the Khmer speech track is empty');

      const schema = await readModelSchema(token, model);
      logger.info(
        `Voice clone ${job.id}: ${chunks.length} chunk(s), fields ${schema.sourceField} -> ${
          schema.targetField || '—'
        }`
      );

      await update({
        status: 'transcribing',
        progress: 12,
        message: `Restyling ${chunks.length} part(s) of the Khmer voice...`,
        khmerMessage: KHMER_MESSAGES.converting,
      });

      let failed = 0;
      let done = 0;
      for (const chunk of chunks) {
        await checkpoint();
        const chunkPath = path.join(chunkDir, chunk);
        const target = path.join(outDir, chunk);
        try {
          const url = await convertOnce(token, model, schema, chunkPath, refWav, checkpoint);
          const raw = path.join(workDir, `${chunk}.raw`);
          await downloadToFile(url, raw);
          // Converters answer in whatever they like; the join needs one format.
          await FFmpegHelper.execute([
            '-y', '-v', 'error',
            '-i', raw,
            '-ac', '2', '-ar', '44100',
            target,
          ]);
        } catch (err: any) {
          if (err instanceof JobCancelledError) throw err;
          failed += 1;
          logger.warn(`Voice clone chunk ${chunk} failed: ${err?.message || err}`);
          // Keep the words: an unconverted part is far better than a gap.
          await FFmpegHelper.execute([
            '-y', '-v', 'error',
            '-i', chunkPath,
            '-ac', '2', '-ar', '44100',
            target,
          ]);
        }
        done += 1;
        await update({
          progress: Math.min(86, 12 + Math.round((done / chunks.length) * 74)),
          message: `Restyling the Khmer voice... ${done}/${chunks.length}`,
          khmerMessage: `${KHMER_MESSAGES.converting.replace('...', '')} — ${done}/${chunks.length}`,
        });
      }

      if (failed === chunks.length) {
        throw new Error(
          'ប្តូរសំឡេងបរាជ័យទាំងអស់។ សូមពិនិត្យ key និងសាកល្បងម្តងទៀត។ (Every part failed — check the inference key.)'
        );
      }

      await checkpoint();
      await update({
        status: 'syncing',
        progress: 90,
        message: 'Mixing the new voice with the original music...',
        khmerMessage: KHMER_MESSAGES.mixing,
      });

      const listPath = path.join(workDir, 'list.txt');
      fs.writeFileSync(
        listPath,
        chunks.map((chunk) => `file '${path.join(outDir, chunk)}'`).join('\n'),
        'utf8'
      );
      const voiceWav = path.join(workDir, 'voice.wav');
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-ac', '2', '-ar', '44100',
        voiceWav,
      ]);

      const mixedWav = path.join(workDir, 'mixed.wav');
      const musicSource = await resolveStoredArtifact(job.musicFile, 'outputs');
      if (musicSource) {
        const musicWav = path.join(workDir, 'music.wav');
        await FFmpegHelper.extractAudio(musicSource, musicWav);
        await FFmpegHelper.mixDubbedAudio(voiceWav, musicWav, mixedWav, {
          backgroundMusic: 'reduce',
          speechVolume: 1.4,
          musicVolume: 0.55,
          backgroundHasOriginalVoice: false,
        });
      } else {
        await FFmpegHelper.execute([
          '-y', '-v', 'error',
          '-i', voiceWav,
          '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
          mixedWav,
        ]);
      }

      await checkpoint();
      const outMp3 = path.join(workDir, `clone_${jobId}.mp3`);
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-i', mixedWav,
        '-codec:a', 'libmp3lame', '-q:a', '2',
        outMp3,
      ]);
      const cloneFile = await getStorage().saveFile('outputs', `clone_${jobId}.mp3`, outMp3);

      const report: VoiceCloneReport = {
        model,
        chunks: chunks.length,
        chunksFailed: failed,
        seconds: Number(duration.toFixed(2)),
      };

      await update({
        status: 'completed',
        progress: 100,
        message: 'Voice clone finished',
        khmerMessage: KHMER_MESSAGES.done,
        cloneFile,
        clone: report,
        metadata: { ...(job.metadata || { duration, sizeBytes: 0 }), duration },
        completedAt: new Date().toISOString(),
      });

      logger.info(
        `Voice clone finished for ${jobId}: ${chunks.length - failed}/${chunks.length} part(s)`
      );
    } catch (err: any) {
      const cancelled = err instanceof JobCancelledError;
      const reason = cancelled
        ? KHMER_CANCELLED_MESSAGE
        : err?.message || 'ប្តូរសំឡេងបរាជ័យ។ (The voice clone failed.)';
      logger.warn(`Voice clone ${jobId} ended: ${reason}`);

      await update({
        status: 'failed',
        progress: 100,
        message: reason,
        khmerMessage: cancelled ? KHMER_CANCELLED_MESSAGE : 'ប្តូរសំឡេងបរាជ័យ',
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
