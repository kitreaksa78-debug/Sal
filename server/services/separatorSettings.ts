import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getStorage } from './storage.js';

/**
 * Where the model-based separation runs.
 *
 * A phone in Termux (Demucs API), a small home server, or the bundled
 * `audio-separator` sidecar all speak the same HTTP contract, so the app only
 * needs the base URL, an optional key, and which model to ask for.
 *
 * The connection can come from three places. The first one that is set wins:
 *
 *  1. `PINNED_SEPARATOR_URL` — a single service baked into the code, which is
 *     what this deployment normally uses so the pipeline can never drift back
 *     to an old, dead tunnel URL;
 *  2. what the app owner typed into the website (`/api/config/separator`) —
 *     saved here and mirrored to object storage, so it survives a restart;
 *  3. the deployment's own environment (`AUDIO_SEPARATOR_URL` and friends),
 *     which is what `render.yaml` / Render env vars use.
 *
 * The website value wins over the environment: a phone tunnel URL changes every
 * time the tunnel is reopened, and the owner should be able to paste the new one
 * without a redeploy. Clearing `PINNED_SEPARATOR_URL` hands the choice back to
 * the website panel.
 */
export interface SeparatorConnection {
  /** Base URL of the service, e.g. `https://xxxx.trycloudflare.com`. */
  url: string;
  /** Bearer token the service expects, when it has one. */
  apiKey: string;
  /** Model file name to ask for. Empty means "whatever the service defaults to". */
  model: string;
  /** Endpoint path to POST the audio to. Empty means "use the usual ones". */
  path: string;
  updatedAt?: string;
}

export interface ResolvedSeparatorConnection {
  url: string;
  apiKey: string;
  model: string;
  path: string;
  /** Where the resolved values came from: the pinned code value, the website,
   * the env, or nowhere. */
  source: 'pinned' | 'app' | 'env' | 'none';
  updatedAt?: string;
}

/**
 * The Demucs service this deployment talks to, pinned in code.
 *
 * The phone's Cloudflare quick tunnel is the only thing that can separate
 * stems, so the whole pipeline points at it. Baking the address in means a job
 * can never be sent to a stale tunnel URL that some earlier session left behind
 * in the saved settings or in the deployment's env vars.
 *
 * To hand the choice back to the website's stem panel, set this to an empty
 * string.
 */
export const PINNED_SEPARATOR_URL = 'https://genres-efforts-setting-placed.trycloudflare.com';

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'separator.json');
const STATE_KEY = 'separator.json';

let stored: SeparatorConnection | null = null;
let loaded = false;

function emptyConnection(): SeparatorConnection {
  return { url: '', apiKey: '', model: '', path: '' };
}

/** Trim a URL and drop any trailing slashes, so two spellings compare equal. */
function normaliseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalise(input: Partial<SeparatorConnection>): SeparatorConnection {
  return {
    url: String(input.url ?? '')
      .trim()
      .replace(/\/+$/, ''),
    apiKey: String(input.apiKey ?? '').trim(),
    model: String(input.model ?? '').trim(),
    path: String(input.path ?? '').trim(),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

function readLocalFile(): SeparatorConnection | null {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<SeparatorConnection>;
    const connection = normalise(parsed);
    return connection.url ? connection : null;
  } catch (err) {
    logger.warn('Could not read the saved separation service settings:', err);
    return null;
  }
}

/** The value the owner saved from the website, or null when there is none. */
export function getStoredSeparatorConnection(): SeparatorConnection | null {
  if (!loaded) {
    stored = readLocalFile();
    loaded = true;
  }
  return stored ? { ...stored } : null;
}

/**
 * The connection the pipeline should actually use. Saved settings win over the
 * process environment so a phone tunnel can be re-pointed from the browser.
 */
export function getSeparatorConnection(): ResolvedSeparatorConnection {
  const saved = getStoredSeparatorConnection();
  const env = (name: string) => (process.env[name] || '').trim();

  const pinned = normaliseUrl(PINNED_SEPARATOR_URL);
  if (pinned) {
    return {
      // Everything comes from the deployment's configuration: the phone's Demucs
      // service takes no key and no model, so a value saved by an earlier
      // session (a key typed into the panel, an MDX model name) must not be
      // carried over into a connection it does not belong to.
      url: pinned,
      apiKey: env('AUDIO_SEPARATOR_API_KEY'),
      model: env('AUDIO_SEPARATOR_MODEL'),
      path: env('AUDIO_SEPARATOR_PATH'),
      source: 'pinned',
      updatedAt: saved?.updatedAt,
    };
  }

  if (saved?.url) {
    return {
      url: saved.url,
      apiKey: saved.apiKey,
      // The model is only sent when one is named: a Demucs service rejects an
      // MDX model name, and vice versa.
      model: saved.model,
      path: saved.path,
      source: 'app',
      updatedAt: saved.updatedAt,
    };
  }

  const envUrl = normaliseUrl(env('AUDIO_SEPARATOR_URL'));
  if (envUrl) {
    return {
      url: envUrl,
      apiKey: env('AUDIO_SEPARATOR_API_KEY'),
      model: env('AUDIO_SEPARATOR_MODEL'),
      path: env('AUDIO_SEPARATOR_PATH'),
      source: 'env',
    };
  }

  return { ...emptyConnection(), source: 'none' };
}

/** Wait for any queued mirror upload (used on shutdown). */
export async function flushSeparatorSettings(): Promise<void> {
  if (!stored) return;
  try {
    await getStorage().setState(STATE_KEY, JSON.stringify(stored));
  } catch (err) {
    logger.warn('Failed to mirror the separation service settings to remote storage:', err);
  }
}

/** Remember a new connection and mirror it so a restart does not lose it. */
export async function saveSeparatorConnection(
  input: Partial<SeparatorConnection>
): Promise<SeparatorConnection> {
  const current = getStoredSeparatorConnection() ?? emptyConnection();
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
    logger.warn('Failed to write the separation service settings to disk:', err);
  }

  await flushSeparatorSettings();
  logger.info(`Separation service connection saved (${stored.url || 'not set'})`);
  return { ...stored };
}

/** Drop the website override and fall back to the deployment's env vars. */
export async function clearSeparatorConnection(): Promise<void> {
  stored = null;
  loaded = true;
  try {
    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
  } catch (err) {
    logger.warn('Failed to remove the saved separation service settings:', err);
  }
  try {
    await getStorage().setState(STATE_KEY, '');
  } catch (err) {
    logger.warn('Failed to clear the mirrored separation service settings:', err);
  }
}

/** Load the mirrored settings on boot, before the first job can run. */
export async function hydrateSeparatorSettings(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await getStorage().getState(STATE_KEY);
  } catch (err) {
    logger.warn('Could not read the mirrored separation service settings:', err);
  }

  if (!raw) {
    getStoredSeparatorConnection();
    return;
  }

  try {
    const parsed = normalise(JSON.parse(raw) as Partial<SeparatorConnection>);
    if (parsed.url) {
      stored = parsed;
      loaded = true;
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(parsed, null, 2), 'utf8');
      logger.info(`Recovered the separation service connection: ${parsed.url}`);
      return;
    }
  } catch (err) {
    logger.warn('Failed to parse the mirrored separation service settings:', err);
  }

  getStoredSeparatorConnection();
}
