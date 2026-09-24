import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';
import { getSeparatorConnection, getStoredSeparatorConnection } from './separatorSettings.js';

export interface SeparationResult {
  vocalsPath: string;
  noVocalsPath: string;
  warning?: string;
  /**
   * True when the background track still contains the original voices, which
   * happens when phase cancellation is impossible (effectively mono audio).
   * The mixer uses it to decide how hard to mute the background under dialogue.
   */
  backgroundHasOriginalVoice?: boolean;
}

export interface SeparationOptions {
  /**
   * Report a failure instead of quietly using the DSP fallback. Only the admin
   * "test connection" screen asks for this: it wants the real error from the
   * service, not a job that keeps going.
   */
  noFallback?: boolean;
}

export interface AudioSeparationProvider {
  name: string;
  isConfigured(): boolean;
  separate(
    inputWavPath: string,
    outputDir: string,
    options?: SeparationOptions
  ): Promise<SeparationResult>;
}

/**
 * Local DSP Audio Separation using FFmpeg center-channel subtraction + bandpass filters.
 * High speed, zero external dependencies, robust and keeps stereo background music and ambience.
 */
export class DspAudioSeparationProvider implements AudioSeparationProvider {
  name = 'local_dsp';

  isConfigured(): boolean {
    return true; // Always available via native FFmpeg
  }

  async separate(inputWavPath: string, outputDir: string): Promise<SeparationResult> {
    const vocalsPath = path.join(outputDir, 'vocals.wav');
    const noVocalsPath = path.join(outputDir, 'no_vocals.wav');

    try {
      const separation = await FFmpegHelper.separateCenterVocalDsp(inputWavPath, vocalsPath, noVocalsPath);

      // Verify files were generated
      const noVocalsExists = fs.existsSync(noVocalsPath) && fs.statSync(noVocalsPath).size > 1024;

      if (!noVocalsExists) {
        logger.warn('no_vocals.wav was not generated cleanly, falling back to original audio copy');
        fs.copyFileSync(inputWavPath, noVocalsPath);
        return {
          vocalsPath,
          noVocalsPath,
          backgroundHasOriginalVoice: true,
          warning: 'ការញែកសំឡេងមិនទាន់ពេញលេញ។ សំឡេងដើមត្រូវបានរក្សាទុកជាផ្ទៃខាងក្រោយ។ (Audio separation partial; original audio preserved as background.)',
        };
      }

      logger.info(
        separation.backgroundHasOriginalVoice
          ? 'Background keeps the original mix; the original voices will be muted inside each dialogue window.'
          : 'Centre-channel cancellation used for the background; only a light dip is needed under dialogue.'
      );

      return {
        vocalsPath,
        noVocalsPath,
        backgroundHasOriginalVoice: separation.backgroundHasOriginalVoice,
      };
    } catch (err: any) {
      logger.warn('DSP audio separation encountered an issue, continuing gracefully with fallback:', err);
      // Graceful fallback: use original audio as background so job continues smoothly
      fs.copyFileSync(inputWavPath, noVocalsPath);
      fs.copyFileSync(inputWavPath, vocalsPath);

      return {
        vocalsPath,
        noVocalsPath,
        backgroundHasOriginalVoice: true,
        warning: 'ការញែកសំឡេងមិនបានល្អឥតខ្ចោះទេ ប៉ុន្តែវីដេអូនឹងនៅតែដំណើរការបន្ត។ (Audio separation warning; continuing with graceful fallback.)',
      };
    }
  }
}

/**
 * Demucs CLI provider if the user has demucs installed on the host
 */
export class DemucsAudioSeparationProvider implements AudioSeparationProvider {
  name = 'demucs';
  private fallback = new DspAudioSeparationProvider();

  isConfigured(): boolean {
    return process.env.AUDIO_SEPARATION_PROVIDER === 'demucs';
  }

  async separate(inputWavPath: string, outputDir: string): Promise<SeparationResult> {
    try {
      const isDemucsInstalled = await new Promise<boolean>((resolve) => {
        const check = spawn('demucs', ['--help']);
        check.on('close', (code) => resolve(code === 0));
        check.on('error', () => resolve(false));
      });

      if (!isDemucsInstalled) {
        logger.info('Demucs command not found, using local DSP separation fallback');
        return await this.fallback.separate(inputWavPath, outputDir);
      }

      logger.info('Running demucs vocal separation...');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('demucs', ['--two-stems=vocals', '-o', outputDir, inputWavPath]);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Demucs exited with code ${code}`));
        });
        proc.on('error', reject);
      });

      // Find demucs output
      const baseName = path.basename(inputWavPath, path.extname(inputWavPath));
      const modelDir = path.join(outputDir, 'htdemucs', baseName);
      const demucsVocals = path.join(modelDir, 'vocals.wav');
      const demucsNoVocals = path.join(modelDir, 'no_vocals.wav');

      const targetVocals = path.join(outputDir, 'vocals.wav');
      const targetNoVocals = path.join(outputDir, 'no_vocals.wav');

      if (fs.existsSync(demucsVocals) && fs.existsSync(demucsNoVocals)) {
        fs.copyFileSync(demucsVocals, targetVocals);
        fs.copyFileSync(demucsNoVocals, targetNoVocals);
        return { vocalsPath: targetVocals, noVocalsPath: targetNoVocals };
      }

      return await this.fallback.separate(inputWavPath, outputDir);
    } catch (e: any) {
      logger.warn('Demucs separation failed, gracefully falling back to DSP:', e);
      return await this.fallback.separate(inputWavPath, outputDir);
    }
  }
}

// --------------------------------------------------------------- remote stems

/** Where a stem lives, as whatever the service answered with. */
interface StemLocation {
  /** A URL, a path on the service, a `data:` URI, or raw base64. */
  value: string;
  /** The value is base64 audio rather than a location. */
  base64: boolean;
}

/** Multipart field names real-world stem services use for the upload. */
const UPLOAD_FIELDS = ['audio', 'file', 'video', 'track', 'input'];
/** Endpoint paths to try when the service was not told a specific one. */
const SEPARATE_PATHS = ['/separate', '/separate/', '/api/separate', '/api/v1/separate', '/stem'];

/**
 * Name a stem by its key — `vocals`, `no_vocals`, `instrumental`, `other`, …
 * The keys are compared with everything but letters and digits stripped, so
 * `no_vocals`, `noVocals` and `no-vocals` are all the same thing.
 */
function classifyStemName(rawName: string): 'vocals' | 'instrumental' | null {
  const name = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!name) return null;
  // "novocals"/"instrumental"/"accompaniment" all describe the music stem, and
  // they contain "vocal", so they have to be recognised first.
  if (/(novocal|instrumental|accompaniment|karaoke|background|music|other)/.test(name)) {
    return 'instrumental';
  }
  if (/(vocal|voice)/.test(name)) return 'vocals';
  return null;
}

interface FlatStemEntry {
  key: string;
  location: StemLocation;
}

/**
 * Walk whatever JSON came back and list every string in it, tagged with the key
 * it sat under.
 *
 * Services disagree about the shape — `{vocals, instrumental}`,
 * `{stems: [{name, url}]}`, `{output: {vocals: {url}}}`, sometimes base64 in
 * `{data, encoding}` — so the payload is flattened first and picked apart after,
 * instead of betting on one layout.
 */
function flattenStemEntries(
  value: unknown,
  key = '',
  out: FlatStemEntry[] = [],
  depth = 0
): FlatStemEntry[] {
  if (depth > 6 || out.length > 400) return out;

  if (typeof value === 'string') {
    out.push({ key, location: { value, base64: false } });
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) flattenStemEntries(item, key, out, depth + 1);
    return out;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    // `{ "data": "UklGR...", "encoding": "base64" }` and friends.
    const encoded =
      typeof record.data === 'string'
        ? record.data
        : typeof record.base64 === 'string'
        ? record.base64
        : null;
    if (encoded) out.push({ key, location: { value: encoded, base64: true } });

    for (const [childKey, childValue] of Object.entries(record)) {
      if (childKey === 'data' || childKey === 'base64' || childKey === 'encoding') continue;
      flattenStemEntries(childValue, childKey, out, depth + 1);
    }
  }

  return out;
}

/** Find the location of one stem in an answer of unknown shape. */
function pickStemLocation(payload: unknown, kind: 'vocals' | 'instrumental'): StemLocation | null {
  const entries = flattenStemEntries(payload);

  // 1. The key names the stem (`{"vocals": "..."}`).
  for (const entry of entries) {
    if (!entry.location.base64 && classifyStemName(entry.key) === kind) return entry.location;
  }

  // 2. The file name does (`{"outputs": [".../vocals.wav", ".../no_vocals.wav"]}`).
  for (const entry of entries) {
    if (entry.location.base64 || entry.location.value.startsWith('data:')) continue;
    const filename = entry.location.value.split('?')[0].split('/').pop() || '';
    if (classifyStemName(filename) === kind) return entry.location;
  }

  // 3. Only the audio itself came back, with no name attached.
  for (const entry of entries) {
    if (entry.location.base64) return entry.location;
  }

  return null;
}

function decodeBase64Audio(value: string): Buffer {
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  return Buffer.from(payload.replace(/\s+/g, ''), 'base64');
}

/**
 * A stem service reached over HTTP.
 *
 * The Node/FFmpeg host cannot run UVR/Demucs models itself, so the model runs
 * somewhere else — a phone in Termux, a home server, or the bundled
 * `audio-separator` sidecar in `tools/audio-separator-server/` — and this
 * provider talks to it: upload the extracted WAV, fetch the two stems back.
 *
 * The address comes from `server/services/separatorSettings.ts`: the connection
 * the app owner saved from the website first, then `AUDIO_SEPARATOR_URL`.
 *
 * Because the model removes the dialogue from the background completely, the
 * returned background is reported as carrying no original voice, which is what
 * lets the mixer hold the music at full level under the Khmer dialogue (a gentle
 * 6 dB dip) instead of gating it down to -30 dB.
 *
 * Anything that goes wrong — service down, timeout, unrecognised answer — falls
 * back to the local DSP provider, so separation never fails a job.
 */
export class RemoteStemSeparationProvider implements AudioSeparationProvider {
  name: string;
  private fallback = new DspAudioSeparationProvider();

  constructor(name = 'audio_separator') {
    this.name = name;
  }

  isConfigured(): boolean {
    return Boolean(getSeparatorConnection().url);
  }

  /** Model name to ask for; empty means "whatever the service defaults to". */
  getModelName(): string {
    const connection = getSeparatorConnection();
    if (connection.model) return connection.model;
    // A Demucs service rejects an MDX file name and the other way round, so the
    // fallback name is only used for the sidecar this repository ships.
    return this.name === 'demucs_api' ? '' : 'UVR-MDX-NET-Inst_HQ_3';
  }

  async separate(
    inputWavPath: string,
    outputDir: string,
    options: SeparationOptions = {}
  ): Promise<SeparationResult> {
    const vocalsPath = path.join(outputDir, 'vocals.wav');
    const noVocalsPath = path.join(outputDir, 'no_vocals.wav');
    const connection = getSeparatorConnection();

    if (!connection.url) {
      logger.info('No stem service is configured; using the local DSP separation fallback');
      if (options.noFallback) throw new Error('មិនទាន់បានកំណត់ URL របស់ម៉ាស៊ីនញែកភ្លេងទេ។ (No stem service URL is configured.)');
      return this.fallback.separate(inputWavPath, outputDir);
    }

    try {
      // The stems are streamed straight to disk, and the caller's directory may
      // not exist yet on the "test connection" path.
      fs.mkdirSync(outputDir, { recursive: true });

      const stems = await this.requestStems(inputWavPath, connection.url, connection.apiKey, connection.path);

      await this.writeStem(connection.url, stems.vocals, vocalsPath, connection.apiKey);
      await this.writeStem(connection.url, stems.instrumental, noVocalsPath, connection.apiKey);

      const usable = (p: string) => fs.existsSync(p) && fs.statSync(p).size > 1024;
      if (!usable(vocalsPath) || !usable(noVocalsPath)) {
        throw new Error('the service returned empty stems');
      }

      logger.info(`Stem service finished (${connection.url}, model: ${stems.model || this.getModelName() || 'default'})`);
      return {
        vocalsPath,
        noVocalsPath,
        // Dialogue is gone from the background, so the music can stay loud.
        backgroundHasOriginalVoice: false,
      };
    } catch (err: any) {
      logger.warn(`Stem separation via ${connection.url} failed:`, err?.message || err);
      if (options.noFallback) throw err;

      const result = await this.fallback.separate(inputWavPath, outputDir);
      return {
        ...result,
        warning:
          'ការញែកភ្លេងដោយម៉ូឌែល (Demucs) មិនបានសម្រេច ដូច្នេះវីដេអូនេះប្រើវិធីញែកធម្មតាជំនួសវិញ។ (Model separation was unavailable for this job; used the built-in DSP fallback.)',
      };
    }
  }

  /**
   * Upload the WAV and locate both stems in the answer.
   *
   * Services differ in their endpoint and in their multipart field name, so the
   * usual combinations are tried in order: a 404/405 means "wrong path", a
   * 400/415/422 means "wrong field name". Everything else is reported as-is.
   */
  private async requestStems(
    inputWavPath: string,
    base: string,
    apiKey: string,
    configuredPath: string
  ): Promise<{ vocals: StemLocation; instrumental: StemLocation; model?: string }> {
    const timeoutMs = Number(process.env.AUDIO_SEPARATOR_TIMEOUT_MS || '1800000');
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const endpoints = this.separateEndpoints(base, configuredPath);
    const model = this.getModelName();

    const failures: string[] = [];
    let attempts = 0;

    for (const endpoint of endpoints) {
      for (const field of this.uploadFields()) {
        if (attempts >= 6) break;
        attempts++;

        const form = new FormData();
        // openAsBlob streams the file lazily, so a multi-hundred-MB WAV is not
        // read into memory just to build the multipart body.
        const blob = await fs.openAsBlob(inputWavPath, { type: 'audio/wav' });
        form.append(field, blob, path.basename(inputWavPath));
        if (model) form.append('model', model);

        logger.info(`Uploading audio to ${endpoint} (field: ${field})...`);
        const upload = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (upload.status === 404 || upload.status === 405) {
          failures.push(`${endpoint} → ${upload.status}`);
          break; // this path does not exist: try the next one
        }

        if (!upload.ok) {
          const detail = await upload.text().catch(() => '');
          failures.push(`${endpoint} → ${upload.status} ${detail.slice(0, 160)}`);
          // 400/415/422 usually mean the field name was wrong; try the next one.
          if ([400, 401, 403, 415, 422].includes(upload.status)) continue;
          throw new Error(failures[failures.length - 1]);
        }

        const contentType = upload.headers.get('content-type') || '';
        const payload: unknown = contentType.includes('json')
          ? await upload.json()
          : { output: await upload.text() };

        const vocals = pickStemLocation(payload, 'vocals');
        const instrumental = pickStemLocation(payload, 'instrumental');

        if (!vocals || !instrumental) {
          failures.push(`${endpoint} answered without both stems (${JSON.stringify(payload).slice(0, 200)})`);
          throw new Error(failures[failures.length - 1]);
        }

        const reportedModel =
          payload && typeof payload === 'object' && typeof (payload as any).model === 'string'
            ? (payload as any).model
            : undefined;

        return { vocals, instrumental, model: reportedModel };
      }
    }

    throw new Error(
      `មិនអាចញែកភ្លេងតាម ${base} បានទេ។ (No usable endpoint on the stem service.) ${failures.join(' | ')}`
    );
  }

  /** Where to POST the audio: the configured path first, then the usual ones. */
  private separateEndpoints(base: string, configuredPath: string): string[] {
    const paths = configuredPath
      ? [configuredPath, ...SEPARATE_PATHS]
      : SEPARATE_PATHS;
    const seen = new Set<string>();
    return paths
      .map((p) => `${base}${p.startsWith('/') ? '' : '/'}${p}`)
      .filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
  }

  /** `AUDIO_SEPARATOR_FIELD` pins the field name; otherwise the common ones are tried. */
  private uploadFields(): string[] {
    const configured = (process.env.AUDIO_SEPARATOR_FIELD || '').trim();
    return configured ? [configured, ...UPLOAD_FIELDS] : UPLOAD_FIELDS;
  }

  /** Ask the service what it is; used by the "test connection" screen. */
  async describeService(): Promise<string | null> {
    const connection = getSeparatorConnection();
    if (!connection.url) return null;
    return describeRemoteService(connection.url, connection.apiKey);
  }

  /** Stem fields may be absolute URLs, paths on the service, or base64 audio. */
  private resolveStemUrl(base: string, location: string): string {
    if (/^https?:\/\//i.test(location)) return location;
    return `${base}${location.startsWith('/') ? '' : '/'}${location}`;
  }

  private async writeStem(
    base: string,
    stem: StemLocation,
    target: string,
    apiKey: string
  ): Promise<void> {
    const timeoutMs = Number(process.env.AUDIO_SEPARATOR_TIMEOUT_MS || '1800000');

    if (stem.base64 || stem.value.startsWith('data:')) {
      fs.writeFileSync(target, decodeBase64Audio(stem.value));
      return;
    }

    const res = await fetch(this.resolveStemUrl(base, stem.value), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) {
      throw new Error(`stem download failed (${res.status}) for ${stem.value}`);
    }
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(target));
  }
}

/**
 * Ask a stem service what it is. Reports the `service`/`name`/`status` fields of
 * its root or `/health` answer, which is how the connection screen can tell
 * "Demucs API on the phone" apart from "something else is on this URL".
 */
export async function describeRemoteService(base: string, apiKey: string): Promise<string | null> {
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  for (const path of ['/', '/health']) {
    try {
      const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const text = (await res.text()).slice(0, 2000);
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        const label = data.service ?? data.name ?? data.app ?? data.status;
        if (typeof label === 'string' && label.trim()) {
          const version = typeof data.version === 'string' ? ` v${data.version}` : '';
          const model = typeof data.model === 'string' ? ` · ${data.model}` : '';
          return `${label.trim()}${version}${model}`;
        }
      } catch {
        if (text.trim()) return text.trim().slice(0, 120);
      }
    } catch {
      // Try the next path; the caller reports the failure.
    }
  }

  return null;
}

export interface SeparatorTestReport {
  ok: boolean;
  service: string | null;
  latencyMs: number;
  detail: string;
  model?: string;
  stems?: { vocalsBytes: number; instrumentalBytes: number };
}

/**
 * End-to-end check used by the admin screen: send one short tone through the
 * configured service and confirm two real stems come back.
 *
 * It deliberately runs without the DSP fallback, so a silent fallback can never
 * be mistaken for a working Demucs service.
 */
export async function testRemoteSeparation(
  inputWavPath: string,
  outputDir: string
): Promise<SeparatorTestReport> {
  const startedAt = Date.now();
  const provider = new RemoteStemSeparationProvider('demucs_api');
  const connection = getSeparatorConnection();

  if (!connection.url) {
    return {
      ok: false,
      service: null,
      latencyMs: 0,
      detail: 'មិនទាន់បានដាក់ URL ទេ។ (No service URL is configured.)',
    };
  }

  const service = await describeRemoteService(connection.url, connection.apiKey).catch(() => null);

  try {
    const result = await provider.separate(inputWavPath, outputDir, { noFallback: true });
    const vocalsBytes = fs.statSync(result.vocalsPath).size;
    const instrumentalBytes = fs.statSync(result.noVocalsPath).size;
    return {
      ok: true,
      service,
      latencyMs: Date.now() - startedAt,
      detail: `បានទទួល stems ពី ${connection.url}។ (Both stems returned.)`,
      model: provider.getModelName() || undefined,
      stems: { vocalsBytes, instrumentalBytes },
    };
  } catch (err: any) {
    return {
      ok: false,
      service,
      latencyMs: Date.now() - startedAt,
      detail: err?.message || 'unknown error',
    };
  }
}

export function getAudioSeparationProvider(): AudioSeparationProvider {
  // Pointing the app at a phone/box service from the website is an explicit
  // choice, so it wins over whatever provider the deployment defaults to.
  const saved = getStoredSeparatorConnection();
  if (saved?.url) return new RemoteStemSeparationProvider('demucs_api');

  const provider = (process.env.AUDIO_SEPARATION_PROVIDER || 'local_dsp').toLowerCase();
  if (['audio_separator', 'audio-separator'].includes(provider)) {
    return new RemoteStemSeparationProvider('audio_separator');
  }
  if (['demucs_api', 'demucs-api', 'demucs_http'].includes(provider)) {
    return new RemoteStemSeparationProvider('demucs_api');
  }
  if (provider === 'demucs') {
    return new DemucsAudioSeparationProvider();
  }
  return new DspAudioSeparationProvider();
}
