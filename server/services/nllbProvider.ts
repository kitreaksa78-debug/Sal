import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getStorage } from './storage.js';

/**
 * The translation stage, and the only engine it has: **NLLB-200**.
 *
 * The owner asked for Groq and Gemini to be removed from translation and for
 * `facebook/nllb-200-distilled-600M` to be the translator, run on Google Colab.
 * The model needs roughly 1.5 GB of RAM, which the free Render instance
 * (512 MB) does not have, so it is served over HTTP from a Colab session instead
 * of being loaded in-process — the same shape as the Demucs stem service.
 *
 * Where the connection comes from, first one wins:
 *
 *  1. `PINNED_NLLB_URL` — a single service baked into the code (empty here);
 *  2. what the app owner pasted into the website (`/api/config/nllb`), saved to
 *     `data/nllb.json` and mirrored to object storage so it survives a restart;
 *  3. the deployment's environment (`NLLB_TRANSLATION_URL` /
 *     `NLLB_TRANSLATION_API_KEY`).
 *
 * A Colab quick tunnel is handed a new hostname every time it is reopened, so
 * the website value has to win over the environment: re-pointing it must not
 * need a redeploy.
 */

/** The one translation model this project uses. */
export const NLLB_TRANSLATION_MODEL = 'nllb-200-distilled-600M';

/** The Hugging Face model the Colab service loads. Shown to the owner. */
export const NLLB_HF_MODEL = 'facebook/nllb-200-distilled-600M';

/** Baked-in address; empty so the website panel or the env decides. */
export const PINNED_NLLB_URL = '';

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'nllb.json');
const STATE_KEY = 'nllb.json';

/** How long one `/translate` call may take before the block is treated as failed. */
const NLLB_REQUEST_TIMEOUT_MS = Number(process.env.NLLB_REQUEST_TIMEOUT_MS || '120000');

/**
 * How many times a retryable failure is attempted before it is reported.
 *
 * A Colab quick tunnel blips: the tunnel reconnects, the origin restarts, or
 * Cloudflare briefly answers 530/502 while the edge catches up. A block that hit
 * one of those is worth asking again rather than keeping the source text.
 */
const NLLB_MAX_ATTEMPTS = Math.max(1, Number(process.env.NLLB_MAX_ATTEMPTS || '3'));

/** Base backoff between retries; multiplied by the attempt number. */
const NLLB_RETRY_BACKOFF_MS = Math.max(0, Number(process.env.NLLB_RETRY_BACKOFF_MS || '1500'));

export interface NllbConnection {
  url: string;
  apiKey: string;
  updatedAt?: string;
}

export interface ResolvedNllbConnection {
  url: string;
  apiKey: string;
  source: 'pinned' | 'app' | 'env' | 'none';
  updatedAt?: string;
}

function normaliseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalise(input: Partial<NllbConnection>): NllbConnection {
  return {
    url: normaliseUrl(String(input.url ?? '')),
    apiKey: String(input.apiKey ?? '').trim(),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

let stored: NllbConnection | null = null;
let loaded = false;

function readLocalFile(): NllbConnection | null {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<NllbConnection>;
    const connection = normalise(parsed);
    return connection.url ? connection : null;
  } catch (err) {
    logger.warn('Could not read the saved NLLB translation service settings:', err);
    return null;
  }
}

export function getStoredNllbConnection(): NllbConnection | null {
  if (!loaded) {
    stored = readLocalFile();
    loaded = true;
  }
  return stored ? { ...stored } : null;
}

/** The connection the pipeline should actually use. */
export function getNllbConnection(): ResolvedNllbConnection {
  const saved = getStoredNllbConnection();
  const env = (name: string) => (process.env[name] || '').trim();

  const pinned = normaliseUrl(PINNED_NLLB_URL);
  if (pinned) {
    return {
      url: pinned,
      apiKey: env('NLLB_TRANSLATION_API_KEY'),
      source: 'pinned',
      updatedAt: saved?.updatedAt,
    };
  }

  if (saved?.url) {
    return { url: saved.url, apiKey: saved.apiKey, source: 'app', updatedAt: saved.updatedAt };
  }

  const envUrl = normaliseUrl(env('NLLB_TRANSLATION_URL'));
  if (envUrl) {
    return { url: envUrl, apiKey: env('NLLB_TRANSLATION_API_KEY'), source: 'env' };
  }

  return { url: '', apiKey: '', source: 'none' };
}

/** Whether a translation service is connected at all. */
export function isNllbConfigured(): boolean {
  return Boolean(getNllbConnection().url);
}

export async function flushNllbSettings(): Promise<void> {
  if (!stored) return;
  try {
    await getStorage().setState(STATE_KEY, JSON.stringify(stored));
  } catch (err) {
    logger.warn('Failed to mirror the NLLB service settings to remote storage:', err);
  }
}

export async function saveNllbConnection(input: Partial<NllbConnection>): Promise<NllbConnection> {
  const current = getStoredNllbConnection() ?? { url: '', apiKey: '' };
  // An empty key field means "keep the one already saved", so the owner does not
  // have to retype the token every time the tunnel URL changes.
  const apiKey =
    input.apiKey === undefined || input.apiKey === '' ? current.apiKey : String(input.apiKey).trim();

  stored = {
    ...normalise({ ...current, ...input, apiKey }),
    updatedAt: new Date().toISOString(),
  };
  loaded = true;

  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(stored, null, 2), 'utf8');
  } catch (err) {
    logger.warn('Failed to write the NLLB service settings to disk:', err);
  }

  await flushNllbSettings();
  logger.info(`NLLB translation service saved (${stored.url || 'not set'})`);
  return { ...stored };
}

export async function clearNllbConnection(): Promise<void> {
  stored = null;
  loaded = true;
  try {
    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
  } catch (err) {
    logger.warn('Failed to remove the saved NLLB service settings:', err);
  }
  try {
    await getStorage().setState(STATE_KEY, '');
  } catch (err) {
    logger.warn('Failed to clear the mirrored NLLB service settings:', err);
  }
}

/** Load the mirrored settings on boot, before the first job can run. */
export async function hydrateNllbSettings(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await getStorage().getState(STATE_KEY);
  } catch (err) {
    logger.warn('Could not read the mirrored NLLB service settings:', err);
  }

  if (!raw) {
    getStoredNllbConnection();
    return;
  }

  try {
    const parsed = normalise(JSON.parse(raw) as Partial<NllbConnection>);
    if (parsed.url) {
      stored = parsed;
      loaded = true;
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(parsed, null, 2), 'utf8');
      logger.info(`Recovered the NLLB translation service connection: ${parsed.url}`);
      return;
    }
  } catch (err) {
    logger.warn('Failed to parse the mirrored NLLB service settings:', err);
  }

  getStoredNllbConnection();
}

/**
 * FLORES-200 codes, which is what NLLB speaks. The website's own source-language
 * codes are mapped to these before a line is sent.
 */
const FLORES_CODES: Record<string, string> = {
  en: 'eng_Latn',
  zh: 'zho_Hans',
  th: 'tha_Thai',
  vi: 'vie_Latn',
  ko: 'kor_Hang',
  ja: 'jpn_Jpan',
  km: 'khm_Khmr',
  fr: 'fra_Latn',
  es: 'spa_Latn',
};

/** The target is always Khmer. */
export const NLLB_TARGET_LANGUAGE = 'khm_Khmr';

export function floresCodeFor(sourceLanguage: string | undefined): string {
  const key = (sourceLanguage || '').trim().toLowerCase();
  return FLORES_CODES[key] || FLORES_CODES.en;
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export interface NllbServiceInfo {
  service: string;
  version?: string;
  model: string;
  device: string;
  loaded?: boolean;
}

/** Probe the service's `GET /`, which is what the panel's test button calls. */
export async function describeNllbService(
  url: string,
  apiKey: string,
  timeoutMs = 6_000
): Promise<NllbServiceInfo | null> {
  try {
    const response = await fetch(`${normaliseUrl(url)}/`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    if (!data || data.status !== 'ok') return null;
    return {
      service: String(data.service || 'NLLB Translation API'),
      version: data.version ? String(data.version) : undefined,
      model: String(data.model || NLLB_HF_MODEL),
      device: String(data.device || 'unknown'),
      loaded: data.loaded === undefined ? undefined : Boolean(data.loaded),
    };
  } catch {
    return null;
  }
}

/**
 * True when a service that answered `GET /` is clearly the stem/Demucs service
 * rather than NLLB.
 *
 * Both services answer `{ status: 'ok' }`, so the reachability probe alone
 * cannot tell them apart — and the owner very plausibly pastes the Demucs tunnel
 * into this card (or the reverse), because both are quick tunnels with similar
 * names. Matching on the service's own name/model catches that before a job is
 * run against the wrong URL.
 */
export function looksLikeStemService(info: { service?: string; model?: string }): boolean {
  const text = `${info.service || ''} ${info.model || ''}`.toLowerCase();
  return /\bdemucs\b|separator|stem|vocal/.test(text);
}

/** A failure we classify so the caller can decide whether asking again is worth it. */
class NllbRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'NllbRequestError';
  }
}

/**
 * Cloudflare's tunnel answers 530 (error 1033) when the tunnel or its origin is
 * gone, with 502/503 while an edge catches up. Those are "try again in a
 * moment" failures; a 4xx would be a real request error.
 */
function isRetryableNllbStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * A short, actionable reason instead of Cloudflare's page of HTML, which is what
 * a 530/502 actually returns and which used to be pasted into the job warning.
 */
function nllbFailureMessage(status: number): string {
  if (status === 530 || status === 502 || status === 503) {
    return `NLLB service មិនអាចទាក់ទងបានទេ (${status}: tunnel របស់ Colab ប្រហែលបានដាច់)។ សូមបើក NLLB ឡើងវិញ រួច paste URL ថ្មីក្នុងកាត «បកប្រែ · NLLB API»។ (NLLB service unreachable — the Colab tunnel appears to be down.)`;
  }
  return `NLLB service answered ${status}.`;
}

/**
 * Whether a fetch-level failure is worth retrying. A DNS miss (the whole tunnel
 * is gone) or a timeout (the request was too big for Cloudflare's edge) will not
 * fix itself in a couple of seconds, so those are reported straight away.
 */
function isRetryableFetchError(err: any): boolean {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return false;
  const code = String(err?.cause?.code || err?.code || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return false;
  return true;
}

/** One `/translate` call, no retry. */
async function requestNllbTranslate(
  url: string,
  apiKey: string,
  lines: { id: string; text: string }[],
  srcLang: string
): Promise<Map<string, string>> {
  let response: Response;
  try {
    response = await fetch(`${normaliseUrl(url)}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ lines, src_lang: srcLang, tgt_lang: NLLB_TARGET_LANGUAGE }),
      signal: AbortSignal.timeout(NLLB_REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error';
    throw new NllbRequestError(`NLLB service request failed (${reason}).`, isRetryableFetchError(err));
  }

  if (!response.ok) {
    // Read and drop the body: a Cloudflare tunnel error is pages of HTML, not JSON.
    await response.text().catch(() => '');
    throw new NllbRequestError(
      nllbFailureMessage(response.status),
      isRetryableNllbStatus(response.status)
    );
  }

  const data = (await response.json()) as { segments?: { id?: string; khmer?: string }[] };
  const out = new Map<string, string>();
  for (const segment of data.segments || []) {
    if (!segment?.id) continue;
    out.set(String(segment.id), String(segment.khmer || '').trim());
  }
  return out;
}

/**
 * Translate a batch of lines with the Colab service. Returns `id -> Khmer`.
 *
 * A retryable failure (tunnel blip, 5xx) is asked again a couple of times with a
 * short backoff before it is reported, so one hiccup does not cost the block its
 * translation. Anything else throws straight away, which the caller reports to
 * the job.
 */
export async function nllbTranslateLines(
  url: string,
  apiKey: string,
  lines: { id: string; text: string }[],
  srcLang: string
): Promise<Map<string, string>> {
  if (lines.length === 0) return new Map();

  let lastError: unknown;
  for (let attempt = 1; attempt <= NLLB_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestNllbTranslate(url, apiKey, lines, srcLang);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof NllbRequestError && err.retryable;
      if (!retryable || attempt >= NLLB_MAX_ATTEMPTS) throw err;
      const wait = NLLB_RETRY_BACKOFF_MS * attempt;
      logger.warn(
        `NLLB request failed (attempt ${attempt}/${NLLB_MAX_ATTEMPTS}); retrying in ${wait}ms: ${
          err instanceof Error ? err.message : err
        }`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

/** Translate with whichever service is configured. */
export async function translateWithConfiguredNllb(
  lines: { id: string; text: string }[],
  srcLang: string
): Promise<Map<string, string>> {
  const connection = getNllbConnection();
  if (!connection.url) {
    throw new Error(
      'មិនទាន់ភ្ជាប់ NLLB API ទេ។ (No NLLB translation service is connected — open the NLLB panel and paste the Colab URL.)'
    );
  }
  return nllbTranslateLines(connection.url, connection.apiKey, lines, srcLang);
}
