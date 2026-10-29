import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getStorage } from './storage.js';

/**
 * The Gemini credentials behind «សម្អាតសំឡេង» (the voice cleanup studio).
 *
 * The owner usually has more than one AI Studio key, because the free daily
 * quota is small and runs out mid-day. Rotating between them is the difference
 * between "the feature stops at noon" and "the feature keeps working", so the
 * app stores the whole list rather than a single key.
 *
 * Where the list can come from — the first one that is set wins:
 *
 *  1. what the owner typed into the clean studio's panel (`/api/config/gemini`),
 *     saved here and mirrored to object storage so it survives a restart;
 *  2. the deployment's own environment (`GEMINI_API_KEYS`, one or more keys
 *     separated by commas, spaces or new lines).
 *
 * Keys are never sent back to a browser: the panel only ever sees a mask and
 * the rotation state of each slot.
 */
export interface GeminiSettings {
  keys: string[];
  /** Models to try, in order. Empty means the built-in list. */
  models: string[];
  updatedAt?: string;
}

/**
 * The models tried in this order.
 *
 * `flash` first (best audio understanding), `flash-lite` next because it has a
 * separate, larger free daily allowance, and 2.0 flash last as a third quota.
 * All three accept audio input, which is what the cleanup needs.
 */
export const DEFAULT_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
];

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'gemini.json');
const STATE_KEY = 'gemini.json';

const MAX_KEYS = 10;
const MAX_MODELS = 6;

let stored: GeminiSettings | null = null;
let loaded = false;

/** Split whatever was pasted — one key per line, or comma/space separated. */
function splitList(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A pasted key, cleaned.
 *
 * A copy out of AI Studio can carry the surrounding quotes, a `key=` prefix or
 * the label above it. Only the token itself is stored, so two pastes of the same
 * key are recognised as the same slot instead of spending the quota twice.
 */
export function normaliseGeminiKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(?:api[_\s-]?key|key|x-goog-api-key)\s*[:=]\s*/i, '')
    .trim();
}

/** Every key in a request body, cleaned and de-duplicated, order preserved. */
export function normaliseGeminiKeys(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? splitList(input) : [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of raw) {
    const key = normaliseGeminiKey(item);
    if (!key || key.length < 8) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= MAX_KEYS) break;
  }
  return keys;
}

export function normaliseGeminiModelsInput(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? splitList(input) : [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim().toLowerCase().replace(/^models\//, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    models.push(name);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function readLocalFile(): GeminiSettings | null {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<GeminiSettings>;
    const keys = normaliseGeminiKeys(parsed.keys);
    if (!keys.length) return null;
    return { keys, models: normaliseGeminiModelsInput(parsed.models), updatedAt: parsed.updatedAt };
  } catch (err) {
    logger.warn('Could not read the saved Gemini settings:', err);
    return null;
  }
}

function envKeys(): string[] {
  const single = normaliseGeminiKey(process.env.GEMINI_API_KEY || '');
  const many = normaliseGeminiKeys(process.env.GEMINI_API_KEYS || '');
  const all = normaliseGeminiKeys([single, ...many]);
  return all;
}

function envModels(): string[] {
  return normaliseGeminiModelsInput(process.env.GEMINI_MODELS || '');
}

/** What the owner saved from the clean studio, or null when there is none. */
export function getStoredGeminiSettings(): GeminiSettings | null {
  if (!loaded) {
    stored = readLocalFile();
    loaded = true;
  }
  return stored ? { keys: [...stored.keys], models: [...stored.models] } : null;
}

/** The keys the pipeline should use, and where they came from. */
export function getGeminiKeys(): { keys: string[]; source: 'app' | 'env' | 'none' } {
  const saved = getStoredGeminiSettings();
  if (saved?.keys.length) return { keys: saved.keys, source: 'app' };

  const fromEnv = envKeys();
  if (fromEnv.length) return { keys: fromEnv, source: 'env' };

  return { keys: [], source: 'none' };
}

/** The models to try, in order: the owner's list when set, else the default. */
export function getGeminiModels(): string[] {
  const saved = getStoredGeminiSettings();
  if (saved?.models.length) return saved.models;

  const fromEnv = envModels();
  if (fromEnv.length) return fromEnv;

  return [...DEFAULT_GEMINI_MODELS];
}

/** Persist and mirror the list so a restart does not lose the credentials. */
export async function saveGeminiSettings(input: {
  keys?: unknown;
  models?: unknown;
}): Promise<GeminiSettings> {
  const current = getStoredGeminiSettings();
  // An empty key list means "keep the keys already saved", the same rule the
  // stem panel uses for its token: reordering models must not wipe credentials.
  const keys =
    input.keys === undefined ? current?.keys ?? [] : normaliseGeminiKeys(input.keys);
  const models =
    input.models === undefined ? current?.models ?? [] : normaliseGeminiModelsInput(input.models);

  stored = { keys, models, updatedAt: new Date().toISOString() };
  loaded = true;

  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(stored, null, 2), 'utf8');
  } catch (err) {
    logger.warn('Failed to write the Gemini settings to disk:', err);
  }

  try {
    await getStorage().setState(STATE_KEY, JSON.stringify(stored));
  } catch (err) {
    logger.warn('Failed to mirror the Gemini settings to remote storage:', err);
  }

  logger.info(`Gemini settings saved (${keys.length} key(s), ${models.length || 'default'} model(s))`);
  return { keys: [...keys], models: [...models], updatedAt: stored.updatedAt };
}

/** Forget the website list and fall back to the deployment's env vars. */
export async function clearGeminiSettings(): Promise<void> {
  stored = null;
  loaded = true;
  try {
    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
  } catch (err) {
    logger.warn('Failed to remove the saved Gemini settings:', err);
  }
  try {
    await getStorage().setState(STATE_KEY, '');
  } catch (err) {
    logger.warn('Failed to clear the mirrored Gemini settings:', err);
  }
}

/** Load the mirrored list on boot, before the first cleanup job can run. */
export async function hydrateGeminiSettings(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await getStorage().getState(STATE_KEY);
  } catch (err) {
    logger.warn('Could not read the mirrored Gemini settings:', err);
  }

  if (!raw) {
    getStoredGeminiSettings();
    return;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<GeminiSettings>;
    const keys = normaliseGeminiKeys(parsed.keys);
    if (keys.length) {
      stored = {
        keys,
        models: normaliseGeminiModelsInput(parsed.models),
        updatedAt: parsed.updatedAt,
      };
      loaded = true;
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(stored, null, 2), 'utf8');
      logger.info(`Recovered ${keys.length} Gemini key(s) from remote storage`);
      return;
    }
  } catch (err) {
    logger.warn('Failed to parse the mirrored Gemini settings:', err);
  }

  getStoredGeminiSettings();
}
