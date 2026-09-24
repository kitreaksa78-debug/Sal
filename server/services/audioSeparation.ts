import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { logger } from '../utils/logger.js';
import { getSeparatorConnection } from './separatorSettings.js';

export interface SeparationResult {
  vocalsPath: string;
  noVocalsPath: string;
  /**
   * True when the background track still contains the original voices. Demucs
   * removes them cleanly, so this is false on every successful separation; the
   * mixer still honours it so a degraded run could never be over-dipped.
   */
  backgroundHasOriginalVoice?: boolean;
}

/**
 * Splitting the voices out of a video. There is exactly one implementation —
 * the Demucs service — because the owner asked for real model separation only:
 * a job either gets Demucs stems or fails with the reason, and never quietly
 * continues with a substitute separation.
 */
export interface AudioSeparationProvider {
  name: string;
  isConfigured(): boolean;
  separate(inputWavPath: string, outputDir: string): Promise<SeparationResult>;
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
 * `fetch` collapses every network-level failure into the bare message "fetch
 * failed" and hides the real reason in `cause` — ENOTFOUND when the address no
 * longer exists, ECONNREFUSED, a reset connection, a timeout. A quick tunnel is
 * exactly the case where that detail matters: it is handed a brand-new hostname
 * every time it is reopened, so the old one stops resolving entirely. Lifting the
 * cause into the message is what turns an opaque failure into a fixable one.
 */
function describeFetchError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (!cause) return base;

  const detail =
    typeof cause === 'object' && cause !== null
      ? (cause as { code?: string }).code ?? (cause as Error).message
      : String(cause);

  return detail && detail !== base ? `${base} (${detail})` : base;
}

/** Everything that went wrong inside `fetch`, message and all, as one string. */
function fetchErrorText(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: string }).name ?? '' : '';
  return `${name} ${describeFetchError(err)}`;
}

/**
 * A sentence naming what to check, chosen from how the connection actually
 * failed. Empty when the failure was about the stems rather than the network, so
 * a service that answered wrongly is not blamed on a dead tunnel.
 */
function connectionHint(err: unknown): string {
  const text = fetchErrorText(err);

  if (/ENOTFOUND|EAI_AGAIN|Could not resolve|getaddrinfo/i.test(text)) {
    return ' រកអាសយដ្ឋាននេះមិនឃើញ — tunnel នេះបានបិទហើយ។ Quick tunnel ទទួលបាន URL ថ្មីរាល់ពេលបើក ដូច្នេះសូមបើកវាឡើងវិញ រួច paste URL ថ្មីក្នុងកាត «ញែកភ្លេង»។ (That hostname no longer exists: the quick tunnel is closed and has a new URL — reopen it and paste the new one.)';
  }

  if (/ECONNREFUSED|ECONNRESET|other side closed|socket hang up|EPIPE/i.test(text)) {
    return ' ភ្ជាប់ទៅម៉ាស៊ីនញែកភ្លេងមិនបាន — API ឬ tunnel បានបិទ។ សូមបើកវាឡើងវិញនៅលើទូរស័ព្ទ។ (The connection was refused or dropped: the Demucs API or its tunnel is not running.)';
  }

  if (/TimeoutError|AbortError|ETIMEDOUT|UND_ERR.*TIMEOUT|timed out/i.test(text)) {
    return ' អស់ពេលរង់ចាំ — ម៉ាស៊ីនញែកភ្លេងយឺត ឬបណ្តាញទូរស័ព្ទដាច់។ សាកល្បងវីដេអូខ្លី ឬពិនិត្យបណ្តាញ។ (It timed out: the phone is slow or its network dropped.)';
  }

  if (/fetch failed|UND_ERR/i.test(text)) {
    return ' សូមពិនិត្យថា Demucs API និង tunnel កំពុងរត់នៅលើទូរស័ព្ទ រួចចុច «សាកល្បងការតភ្ជាប់» ម្តងទៀត។ (Check that the Demucs API and its tunnel are still running on the phone.)';
  }

  return '';
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
 * There is no substitute path: a job that cannot reach the service fails with
 * the reason instead of silently continuing with a lesser separation, so a
 * broken tunnel can never be mistaken for a working Demucs run.
 */
export class RemoteStemSeparationProvider implements AudioSeparationProvider {
  name: string;

  constructor(name = 'demucs_api') {
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
    // sidecar name is only used for the sidecar this repository ships.
    return this.name === 'demucs_api' ? '' : 'UVR-MDX-NET-Inst_HQ_3';
  }

  async separate(inputWavPath: string, outputDir: string): Promise<SeparationResult> {
    const vocalsPath = path.join(outputDir, 'vocals.wav');
    const noVocalsPath = path.join(outputDir, 'no_vocals.wav');
    const connection = getSeparatorConnection();

    if (!connection.url) {
      throw new Error(
        'មិនទាន់បានភ្ជាប់ម៉ាស៊ីនញែកភ្លេង (Demucs API) ទេ — សូមដាក់ URL ក្នុងផ្ទាំង «ញែកភ្លេង · Demucs API» ជាមុនសិន។ (No Demucs API is connected; set its URL in the stem separation panel first.)'
      );
    }

    // The stems are streamed straight to disk, and the caller's directory may
    // not exist yet on the "test connection" path.
    fs.mkdirSync(outputDir, { recursive: true });

    try {
      const stems = await this.requestStems(inputWavPath, connection.url, connection.apiKey, connection.path);

      await this.writeStem(connection.url, stems.vocals, vocalsPath, connection.apiKey);
      await this.writeStem(connection.url, stems.instrumental, noVocalsPath, connection.apiKey);

      const usable = (p: string) => fs.existsSync(p) && fs.statSync(p).size > 1024;
      if (!usable(vocalsPath) || !usable(noVocalsPath)) {
        throw new Error('the service answered without usable stems');
      }

      logger.info(`Stem service finished (${connection.url}, model: ${stems.model || this.getModelName() || 'default'})`);
      return {
        vocalsPath,
        noVocalsPath,
        // Dialogue is gone from the background, so the music can stay loud.
        backgroundHasOriginalVoice: false,
      };
    } catch (err: any) {
      const reason = describeFetchError(err);
      logger.warn(`Stem separation via ${connection.url} failed:`, reason);
      // No substitute separation: the job stops here with the real reason, which
      // is what makes a dead tunnel obvious instead of silently degraded.
      throw new Error(
        `ញែកភ្លេងដោយ Demucs បរាជ័យ៖ ${reason} (Demucs stem separation failed.)${connectionHint(err)}`
      );
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
 * It runs the same code the pipeline runs, so whatever this reports is exactly
 * what a real job would get.
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
    const result = await provider.separate(inputWavPath, outputDir);
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

/**
 * The one separation provider the pipeline uses.
 *
 * Where Demucs runs — a phone in Termux, a home server, the bundled sidecar —
 * comes from `AUDIO_SEPARATOR_URL` or the connection the owner saved from the
 * website. With neither set the provider is simply unconfigured, and jobs fail
 * with a message saying so; stem separation is never swapped for another method.
 */
export function getAudioSeparationProvider(): AudioSeparationProvider {
  return new RemoteStemSeparationProvider('demucs_api');
}
