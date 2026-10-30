import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { normaliseServiceKey, normaliseServiceUrl } from '../utils/serviceConnection.js';
import { getStorage } from './storage.js';

/**
 * Where the voice conversion runs.
 *
 * Two ways to get the Khmer words back in the original singer's timbre:
 *
 *  1. a **Voice Convert API** the owner opened themselves — the same
 *     `SERVICE=1 sh colab-start.sh` cell the stem card uses, running Amphion on
 *     a free Colab GPU behind a Cloudflare tunnel. Nothing is charged, because
 *     the model runs on hardware the owner already has. That is this file;
 *  2. a hosted inference API (Replicate) paid for with the deployment's
 *     `REPLICATE_API_TOKEN`.
 *
 * The connection is read from two places. The first one that is set wins:
 *
 *  1. what the app owner typed into the website (`/api/config/voice-clone`) —
 *     saved here and mirrored to object storage, so it survives a restart;
 *  2. the deployment's own `VOICE_CLONE_SERVICE_URL` environment variable.
 *
 * The website value wins over the environment on purpose: a tunnel URL changes
 * every time the session is reopened, and the owner should be able to paste the
 * new one without a redeploy. With neither set, `voiceClone.ts` falls back to
 * the hosted API.
 */
export interface VoiceCloneConnection {
  /** Base URL of the service, e.g. `https://xxxx.trycloudflare.com`. */
  url: string;
  /** Bearer token the service expects, when it has one. */
  apiKey: string;
  updatedAt?: string;
}

export interface ResolvedVoiceCloneConnection {
  url: string;
  apiKey: string;
  /** Where the resolved values came from: the website, the env, or nowhere. */
  source: 'app' | 'env' | 'none';
  updatedAt?: string;
}

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'voice-clone.json');
const STATE_KEY = 'voice-clone.json';

let stored: VoiceCloneConnection | null = null;
let loaded = false;

function emptyConnection(): VoiceCloneConnection {
  return { url: '', apiKey: '' };
}

/**
 * One spelling per connection.
 *
 * The URL and the key arrive as whatever Colab printed (see
 * `utils/serviceConnection`), so they are cleaned here rather than at each call
 * site — a value saved once is stored the way every later request expects it.
 */
function normalise(input: Partial<VoiceCloneConnection>): VoiceCloneConnection {
  return {
    url: normaliseServiceUrl(input.url),
    apiKey: normaliseServiceKey(input.apiKey),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

function readLocalFile(): VoiceCloneConnection | null {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<VoiceCloneConnection>;
    const connection = normalise(parsed);
    return connection.url ? connection : null;
  } catch (err) {
    logger.warn('Could not read the saved voice conversion service settings:', err);
    return null;
  }
}

/** The value the owner saved from the website, or null when there is none. */
export function getStoredVoiceCloneConnection(): VoiceCloneConnection | null {
  if (!loaded) {
    stored = readLocalFile();
    loaded = true;
  }
  return stored ? { ...stored } : null;
}

/**
 * The connection the conversion should actually use. Saved settings win over
 * the process environment so a Colab tunnel can be re-pointed from the browser.
 */
export function getVoiceCloneConnection(): ResolvedVoiceCloneConnection {
  const saved = getStoredVoiceCloneConnection();
  const envUrl = normaliseServiceUrl(process.env.VOICE_CLONE_SERVICE_URL || '');

  if (saved?.url) {
    return {
      url: saved.url,
      apiKey: saved.apiKey,
      source: 'app',
      updatedAt: saved.updatedAt,
    };
  }

  if (envUrl) {
    return {
      url: envUrl,
      apiKey: normaliseServiceKey(process.env.VOICE_CLONE_SERVICE_API_KEY || ''),
      source: 'env',
    };
  }

  return { url: '', apiKey: '', source: 'none' };
}

/** Wait for any queued mirror upload (used on shutdown). */
export async function flushVoiceCloneSettings(): Promise<void> {
  if (!stored) return;
  try {
    await getStorage().setState(STATE_KEY, JSON.stringify(stored));
  } catch (err) {
    logger.warn('Failed to mirror the voice conversion service settings to remote storage:', err);
  }
}

/** Remember a new connection and mirror it so a restart does not lose it. */
export async function saveVoiceCloneConnection(
  input: Partial<VoiceCloneConnection>
): Promise<VoiceCloneConnection> {
  const current = getStoredVoiceCloneConnection() ?? emptyConnection();
  // An empty key field means "keep the one already saved": re-pointing a new
  // tunnel URL must not blank out the key the owner typed last time.
  const typedKey = normaliseServiceKey(input.apiKey);
  const apiKey = typedKey === '' ? current.apiKey : typedKey;

  stored = {
    ...normalise({ ...current, ...input, apiKey }),
    updatedAt: new Date().toISOString(),
  };
  loaded = true;

  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(stored, null, 2), 'utf8');
  } catch (err) {
    logger.warn('Failed to write the voice conversion service settings to disk:', err);
  }

  await flushVoiceCloneSettings();
  logger.info(`Voice conversion service connection saved (${stored.url || 'not set'})`);
  return { ...stored };
}

/** Drop the website override and fall back to the deployment's env vars. */
export async function clearVoiceCloneConnection(): Promise<void> {
  stored = null;
  loaded = true;
  try {
    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
  } catch (err) {
    logger.warn('Failed to remove the saved voice conversion service settings:', err);
  }
  try {
    await getStorage().setState(STATE_KEY, '');
  } catch (err) {
    logger.warn('Failed to clear the mirrored voice conversion service settings:', err);
  }
}

/** Load the mirrored settings on boot, before the first job can run. */
export async function hydrateVoiceCloneSettings(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await getStorage().getState(STATE_KEY);
  } catch (err) {
    logger.warn('Could not read the mirrored voice conversion service settings:', err);
  }

  if (!raw) {
    getStoredVoiceCloneConnection();
    return;
  }

  try {
    const parsed = normalise(JSON.parse(raw) as Partial<VoiceCloneConnection>);
    if (parsed.url) {
      stored = parsed;
      loaded = true;
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(parsed, null, 2), 'utf8');
      logger.info(`Recovered the voice conversion service connection: ${parsed.url}`);
      return;
    }
  } catch (err) {
    logger.warn('Could not parse the mirrored voice conversion service settings:', err);
  }

  getStoredVoiceCloneConnection();
}
