import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { getGeminiKeys, getGeminiModels } from './geminiSettings.js';

/**
 * Key + model rotation for the Gemini cleanup.
 *
 * A free AI Studio key runs out of quota long before a day is over, and a model
 * can be refused on its own (a retired preview name, a project without access).
 * Trying one fixed key/model pair therefore means the feature dies the first
 * time a limit is hit, with no path back until the next day.
 *
 * So every request walks a small grid — key 1/model 1, key 1/model 2, key 2/model
 * 1, … — and a pair that answers 429/403 is marked **red** and skipped until its
 * cooldown expires. The first pair that is still green runs the request. The
 * panel shows exactly that grid, so "model 1 is red, it moved to model 2" is
 * visible rather than guessed at.
 *
 * State lives in this process only: the limits are per key and per day, but a
 * restart is rare, and pretending a stale red mark (or a stale green one) is
 * fresher than it is would be worse than starting clean.
 */

/** The REST endpoint is overridable so tests can point at a local stub. */
const API_BASE = (
  process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta'
).replace(/\/+$/, '');

/** How long a refused pair stays red when the API gives no hint. */
const DEFAULT_COOLDOWN_MS = Number(process.env.GEMINI_COOLDOWN_MS || 60_000);
const SERVER_COOLDOWN_MS = Number(process.env.GEMINI_SERVER_COOLDOWN_MS || 20_000);
const MAX_COOLDOWN_MS = 30 * 60_000;

export type GeminiSlotState = 'ready' | 'cooling' | 'invalid';

export interface GeminiKeyView {
  label: string;
  /** Never the key itself — enough to tell two slots apart. */
  masked: string;
  state: GeminiSlotState;
  readyModels: number;
  totalModels: number;
  retryAt: string | null;
  note: string | null;
}

export interface GeminiModelView {
  name: string;
  state: GeminiSlotState;
  readyKeys: number;
  totalKeys: number;
  retryAt: string | null;
  note: string | null;
}

export interface GeminiPoolView {
  configured: boolean;
  source: 'app' | 'env' | 'none';
  keyCount: number;
  models: GeminiModelView[];
  keys: GeminiKeyView[];
  /** The pair the next request would use, or null when every pair is red. */
  active: { keyLabel: string; model: string } | null;
  /** Model list the rotation would use when none is configured on the website. */
  defaultModels: string[];
}

interface PairState {
  state: GeminiSlotState;
  until?: number;
  note?: string;
}

const pairStates = new Map<string, PairState>();

/** Rotation identity for a key: a hash, never the secret itself. */
function keyId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function pairId(key: string, model: string): string {
  return `${keyId(key)}|${model}`;
}

function maskedKey(key: string): string {
  if (key.length <= 10) return '••••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function keyLabel(index: number): string {
  return `Key ${index + 1}`;
}

function now(): number {
  return Date.now();
}

/** Drop expired cooldowns so a recovered pair becomes green again by itself. */
function prune(): void {
  const at = now();
  for (const [id, state] of pairStates) {
    if (state.state === 'cooling' && state.until !== undefined && state.until <= at) {
      pairStates.delete(id);
    }
  }
}

function stateOf(key: string, model: string): PairState {
  return pairStates.get(pairId(key, model)) ?? { state: 'ready' };
}

/** Parse Gemini's `retryDelay` ("31s") when a 429 carries one. */
function retryDelayMs(body: string): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (!match) return null;
  const ms = Math.round(Number(match[1]) * 1000);
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 5_000), MAX_COOLDOWN_MS) : null;
}

function markCooling(key: string, model: string, ms: number, note: string): void {
  pairStates.set(pairId(key, model), { state: 'cooling', until: now() + ms, note });
}

function markInvalid(key: string, model: string, note: string): void {
  pairStates.set(pairId(key, model), { state: 'invalid', note });
}

function markReady(key: string, model: string): void {
  pairStates.delete(pairId(key, model));
}

/** Refused key: it will be refused on every model, so all its slots go red. */
function markKeyInvalid(key: string, models: string[], note: string): void {
  for (const model of models) markInvalid(key, model, note);
}

/** Retired/unavailable model: it is unavailable for every key, so all go red. */
function markModelInvalid(model: string, keys: string[], note: string): void {
  for (const key of keys) markInvalid(key, model, note);
}

/**
 * The grid in the order requests try it: every model of key 1, then of key 2.
 *
 * Key-major is what the studio asked for — "when one key runs out, move to the
 * other key" — and it also keeps the account's quota spread evenly instead of
 * burning key 1's model 2 while model 1 still has room elsewhere.
 */
function rotation(keys: string[], models: string[]): { key: string; keyIndex: number; model: string }[] {
  const order: { key: string; keyIndex: number; model: string }[] = [];
  keys.forEach((key, keyIndex) => {
    for (const model of models) order.push({ key, keyIndex, model });
  });
  return order;
}

/** The first pair that is green, or null when the whole grid is red. */
export function pickGeminiPair(
  keys: string[],
  models: string[]
): { key: string; keyIndex: number; model: string } | null {
  prune();
  for (const slot of rotation(keys, models)) {
    if (stateOf(slot.key, slot.model).state === 'ready') return slot;
  }
  return null;
}

/** What the panel shows: one row per key and one per model, green or red. */
export function describeGeminiPool(): GeminiPoolView {
  prune();
  const { keys, source } = getGeminiKeys();
  const models = getGeminiModels();

  const modelRows: GeminiModelView[] = models.map((model) => {
    const states = keys.map((key) => stateOf(key, model));
    const ready = states.filter((s) => s.state === 'ready').length;
    const cooling = states.filter((s) => s.state === 'cooling');
    const nextRetry = cooling.reduce<number | null>((earliest, s) => {
      if (s.until === undefined) return earliest;
      return earliest === null || s.until < earliest ? s.until : earliest;
    }, null);
    const note =
      states.find((s) => s.state === 'invalid')?.note ??
      cooling.find((s) => s.note)?.note ??
      null;

    return {
      name: model,
      state: keys.length === 0 ? 'invalid' : ready > 0 ? 'ready' : cooling.length > 0 ? 'cooling' : 'invalid',
      readyKeys: ready,
      totalKeys: keys.length,
      retryAt: nextRetry ? new Date(nextRetry).toISOString() : null,
      note,
    };
  });

  const keyRows: GeminiKeyView[] = keys.map((key, index) => {
    const states = models.map((model) => stateOf(key, model));
    const ready = states.filter((s) => s.state === 'ready').length;
    const cooling = states.filter((s) => s.state === 'cooling');
    const nextRetry = cooling.reduce<number | null>((earliest, s) => {
      if (s.until === undefined) return earliest;
      return earliest === null || s.until < earliest ? s.until : earliest;
    }, null);

    return {
      label: keyLabel(index),
      masked: maskedKey(key),
      state: ready > 0 ? 'ready' : cooling.length > 0 ? 'cooling' : 'invalid',
      readyModels: ready,
      totalModels: models.length,
      retryAt: nextRetry ? new Date(nextRetry).toISOString() : null,
      note: states.find((s) => s.state === 'invalid')?.note ?? null,
    };
  });

  const activePair = pickGeminiPair(keys, models);
  const active = activePair
    ? { keyLabel: keyLabel(activePair.keyIndex), model: activePair.model }
    : null;

  return {
    configured: keys.length > 0,
    source,
    keyCount: keys.length,
    models: modelRows,
    keys: keyRows,
    active,
    defaultModels: models,
  };
}

/** No key at all: the feature cannot run until one is added. */
export class GeminiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

/** Every pair is red: the caller should say so, not retry forever. */
export class GeminiExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiExhaustedError';
  }
}

export interface GeminiJsonResult<T> {
  data: T;
  model: string;
  keyLabel: string;
  attempts: number;
}

interface GenerateOptions<T> {
  prompt: string;
  /** Audio sent inline, base64 encoded, with its MIME type. */
  audio?: { base64: string; mimeType: string };
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Turn the parsed JSON into the shape the caller wants, or throw. */
  parse: (value: unknown) => T;
  /** What the request is for, in a log line. */
  label?: string;
}

/**
 * Ask Gemini for strict JSON, rotating through the grid on a refused pair.
 *
 * The loop is bounded by the number of pairs, so a fully red grid fails in one
 * pass instead of spinning. A pair that answers well is left green; the caller
 * gets back which model and which key slot actually served the request, which is
 * what the cleanup report shows the owner.
 */
export async function generateGeminiJson<T>(
  options: GenerateOptions<T>
): Promise<GeminiJsonResult<T>> {
  const { keys, source } = getGeminiKeys();
  const models = getGeminiModels();

  if (!keys.length) {
    throw new GeminiUnavailableError(
      'មិនទាន់មាន Gemini key ទេ។ សូមបញ្ចូល key ក្នុងផ្ទាំង «សម្អាតសំឡេង · Gemini» ឬកំណត់ GEMINI_API_KEYS។'
    );
  }

  const total = keys.length * models.length;
  const failures: string[] = [];
  let attempts = 0;

  for (let step = 0; step < total; step++) {
    const pair = pickGeminiPair(keys, models);
    if (!pair) break;

    attempts++;
    const label = keyLabel(pair.keyIndex);
    // The key travels both ways the REST API documents: as `x-goog-api-key` and
    // as the `key` query parameter. Newer AI Studio keys are accepted through
    // either form, and a proxy that strips unknown headers cannot break the call
    // when the query parameter is also present.
    const url = `${API_BASE}/models/${encodeURIComponent(
      pair.model
    )}:generateContent?key=${encodeURIComponent(pair.key)}`;
    const body: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [
            ...(options.audio
              ? [{ inline_data: { mime_type: options.audio.mimeType, data: options.audio.base64 } }]
              : []),
            { text: options.prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: options.maxOutputTokens ?? 4096,
        responseMimeType: 'application/json',
        // 2.5 models think by default; this is a listening/JSON task and the
        // thinking budget only adds seconds to every chunk.
        ...(pair.model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': pair.key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
    } catch (err: any) {
      const reason = err?.name === 'TimeoutError' ? 'request timed out' : err?.message || String(err);
      markCooling(pair.key, pair.model, SERVER_COOLDOWN_MS, reason);
      failures.push(`${label}/${pair.model}: ${reason}`);
      logger.warn(`Gemini ${label}/${pair.model} failed to answer: ${reason}`);
      continue;
    }

    const text = await response.text();

    if (!response.ok) {
      const detail = summarise(text);
      if (response.status === 429) {
        const wait = retryDelayMs(text) ?? DEFAULT_COOLDOWN_MS;
        markCooling(pair.key, pair.model, wait, `quota (429), retry in ${Math.round(wait / 1000)}s`);
        failures.push(`${label}/${pair.model}: quota exhausted`);
        logger.warn(`Gemini ${label}/${pair.model} hit its quota; cooling for ${Math.round(wait / 1000)}s.`);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        markKeyInvalid(pair.key, models, `key refused (${response.status})`);
        failures.push(`${label}: key refused (${response.status})`);
        logger.warn(`Gemini ${label} was refused (${response.status}); that key is now red.`);
        continue;
      }

      if (response.status === 404) {
        // A 404 can mean "this model name is not available to this project" — or
        // "this key cannot use the Generative Language API at all", which Google
        // also reports as 404 on the model path. Rotating past the second case
        // hides the real reason behind three identical failures, so the answer's
        // own wording decides: a model complaint reds out that model, anything
        // else is surfaced as-is for the owner to act on.
        const modelComplaint =
          /model/i.test(text) && /not found|not supported|unsupported|does not support/i.test(text);
        if (!modelComplaint) {
          throw new Error(
            `Gemini បដិសេធការហៅ (404)${detail ? `: ${detail}` : ''}`
          );
        }
        markModelInvalid(pair.model, keys, `model unavailable (404)`);
        failures.push(`${pair.model}: unavailable (404)`);
        logger.warn(`Gemini model ${pair.model} is not available; that model is now red.`);
        continue;
      }

      if (response.status >= 500) {
        markCooling(pair.key, pair.model, SERVER_COOLDOWN_MS, `service error (${response.status})`);
        failures.push(`${label}/${pair.model}: service error ${response.status}`);
        continue;
      }

      // A 400 here is about the request itself (a bad model name, audio the
      // model refuses). Retrying it on every other pair would just produce the
      // same answer, so it is reported straight away.
      if (/model/i.test(text) && /not found|not supported|invalid/i.test(text)) {
        markModelInvalid(pair.model, keys, `model rejected (400)`);
        failures.push(`${pair.model}: rejected (400)`);
        continue;
      }

      throw new Error(
        `Gemini បដិសេធសំណើនេះ (${response.status})${detail ? `: ${detail}` : ''}`
      );
    }

    // Success: this pair is healthy again.
    markReady(pair.key, pair.model);

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      throw new Error('Gemini ឆ្លើយតបជាទម្រង់ដែលអានមិនបាន។ (Unreadable Gemini response.)');
    }

    const parts: any[] = parsedBody?.candidates?.[0]?.content?.parts ?? [];
    const answer = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();

    if (!answer) {
      const blocked = parsedBody?.promptFeedback?.blockReason;
      throw new Error(
        blocked
          ? `Gemini បានបិទសំណើនេះ (${blocked})។`
          : 'Gemini មិនបានឆ្លើយអ្វីទេ។ (Gemini returned no text.)'
      );
    }

    if (options.label) {
      logger.info(`Gemini served ${options.label} with ${label}/${pair.model} (${source})`);
    }

    return {
      data: options.parse(extractJson(answer)),
      model: pair.model,
      keyLabel: label,
      attempts,
    };
  }

  const detail = failures.slice(-4).join(' · ');
  throw new GeminiExhaustedError(
    `Gemini key/model ទាំងអស់កំពុងស្ថិតក្នុងស្ថានភាពក្រហម (អស់កំណត់ ឬត្រូវបានបដិសេធ)។ សូមរង់ចាំបន្តិច ឬបន្ថែម key ថ្មី។ ${
      detail ? `(${detail})` : ''
    }`
  );
}

/** Trim a provider response down to something that fits in an error line. */
function summarise(body: string): string {
  const match = /"message"\s*:\s*"([^"]{1,300})"/.exec(body);
  if (match) return match[1];
  return body.replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * Pull the JSON object out of a model answer.
 *
 * With `responseMimeType: application/json` the text is already bare JSON, but
 * a model occasionally wraps it in a fence or adds a sentence, and losing a
 * chunk's analysis to that would be silly.
 */
export function extractJson(answer: string): unknown {
  const trimmed = answer.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('Gemini ឆ្លើយតបមិនមែនជា JSON ទេ។ (Gemini did not return JSON.)');
  }
}

/** Test hook / admin: forget every red mark. */
export function resetGeminiPoolState(): void {
  pairStates.clear();
}
