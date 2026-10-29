import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { getGeminiKeys, getGeminiModels } from './geminiSettings.js';

/**
 * Key + model rotation for the Gemini cleanup.
 *
 * A free AI Studio key runs out of quota long before a day is over, and a model
 * name can stop being served to a project at any time (Google retired the 2.5
 * family for new projects and points new code at the 3.x names). Trying one
 * fixed key/model pair therefore means the feature dies the first time either
 * happens, with no path back.
 *
 * So every request walks a small grid — key 1/model 1, key 1/model 2, key 2/model
 * 1, … — and a pair that answers 429/403 is marked **red** and skipped until its
 * cooldown expires. When the whole grid is red because the *names* are stale,
 * `ListModels` is asked for what this key can actually call, and the request is
 * retried against those. That is what keeps the studio working a year from now
 * without anyone editing a constant.
 *
 * State lives in this process only: a restart is rare, and pretending a stale
 * red mark (or a stale green one) is fresher than it is would be worse than
 * starting clean.
 */

/** The REST endpoint is overridable so tests can point at a local stub. */
const API_BASE = (
  process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta'
).replace(/\/+$/, '');

/** How long a refused pair stays red when the API gives no hint. */
const DEFAULT_COOLDOWN_MS = Number(process.env.GEMINI_COOLDOWN_MS || 60_000);
const SERVER_COOLDOWN_MS = Number(process.env.GEMINI_SERVER_COOLDOWN_MS || 20_000);
/**
 * How long a pair is parked after it stopped answering altogether.
 *
 * This is not a quota refusal: the request was sent and nothing came back, so
 * every later request would pay the same timeout again. A deployment can have
 * one model name that hangs while the next name on the list answers in seconds,
 * and paying the timeout once per part of every job is exactly what made a
 * cleanup look frozen. It is parked long enough that a later job starts on a
 * model that works, and it comes back on its own if that was a one-off.
 */
const TIMEOUT_COOLDOWN_MS = Number(process.env.GEMINI_TIMEOUT_COOLDOWN_MS || 10 * 60_000);
const MAX_COOLDOWN_MS = 30 * 60_000;
/** How many usable model names `ListModels` may contribute. */
const MAX_DISCOVERED = 4;

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
  /** Names that came from `ListModels`, not from the configured list. */
  discovered?: boolean;
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

/** Model names learned from `ListModels`, best first. */
let discoveredModels: string[] = [];

/** The model that answered most recently; tried first on the next request. */
let lastGoodModel = '';

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

/** Configured names first, then whatever `ListModels` taught us. */
export function allGeminiModels(): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [...getGeminiModels(), ...discoveredModels]) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * The grid in the order requests try it: every model of key 1, then of key 2.
 *
 * Key-major is what the studio asked for — "when one key runs out, move to the
 * other key" — and it also spreads one account's quota instead of burning key
 * 1's second model while key 2 still has room.
 */
function rotation(
  keys: string[],
  models: string[]
): { key: string; keyIndex: number; model: string }[] {
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

/** Roughly how good a model is for this job, lower being better. */
function modelRank(name: string): number {
  if (/flash/.test(name) && !/lite|image|tts|live|audio|transcribe/.test(name)) return 0;
  if (/flash-lite/.test(name)) return 1;
  if (/pro/.test(name)) return 2;
  return 3;
}

/**
 * Ask the service which models this key may call.
 *
 * Model names are retired; a hardcoded list rots. This is the recovery path: it
 * keeps only names that support `generateContent` and are not image/TTS/Live
 * models, puts Flash first, and remembers them for the rest of the process so
 * the panel can show what actually runs.
 */
export async function discoverGeminiModels(
  keys: string[],
  exclude: string[] = []
): Promise<string[]> {
  const skip = new Set(exclude);

  for (const key of keys) {
    try {
      const response = await fetch(
        `${API_BASE}/models?pageSize=200&key=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(20_000) }
      );
      if (!response.ok) continue;

      const data: any = await response.json();
      const names: string[] = (Array.isArray(data?.models) ? data.models : [])
        .filter((model: any) =>
          Array.isArray(model?.supportedGenerationMethods)
            ? model.supportedGenerationMethods.includes('generateContent')
            : false
        )
        .map((model: any) => String(model?.name || '').replace(/^models\//, ''))
        .filter((name: string) => Boolean(name) && !skip.has(name))
        .filter(
          (name: string) =>
            !/image|tts|live|transcribe|embedding|aqa|veo|imagen|nano-banana|omni/i.test(name)
        );

      const ranked = names.sort((a, b) => modelRank(a) - modelRank(b)).slice(0, MAX_DISCOVERED);
      if (ranked.length) {
        discoveredModels = ranked;
        logger.info(`Gemini models available to this key: ${ranked.join(', ')}`);
        return ranked;
      }
    } catch (err: any) {
      logger.warn(`Could not list Gemini models: ${err?.message || err}`);
    }
  }

  return [];
}

/** What the panel shows: one row per key and one per model, green or red. */
export function describeGeminiPool(): GeminiPoolView {
  prune();
  const { keys, source } = getGeminiKeys();
  const models = allGeminiModels();

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
      state:
        keys.length === 0 ? 'invalid' : ready > 0 ? 'ready' : cooling.length > 0 ? 'cooling' : 'invalid',
      readyKeys: ready,
      totalKeys: keys.length,
      retryAt: nextRetry ? new Date(nextRetry).toISOString() : null,
      note,
      ...(discoveredModels.includes(model) ? { discovered: true } : {}),
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

interface GridResult<T> {
  result?: GeminiJsonResult<T>;
  failures: string[];
  /** True when at least one pair was refused because of its model name. */
  modelProblem: boolean;
}

/**
 * One pass over the grid, in rotation order.
 *
 * Every failure is recorded so an exhausted run can explain itself, and every
 * 429/403 paints the pair red so the *next* request starts further along.
 */
async function runGrid<T>(
  options: GenerateOptions<T>,
  keys: string[],
  models: string[]
): Promise<GridResult<T>> {
  const failures: string[] = [];
  let attempts = 0;
  let modelProblem = false;

  // The model that answered last time goes first: a deployment whose first
  // configured name never answers would otherwise make every cleanup begin by
  // waiting out that timeout.
  const ordered =
    lastGoodModel && models.includes(lastGoodModel)
      ? [lastGoodModel, ...models.filter((name) => name !== lastGoodModel)]
      : models;

  const total = keys.length * ordered.length;
  for (let step = 0; step < total; step++) {
    const pair = pickGeminiPair(keys, ordered);
    if (!pair) break;

    attempts++;
    const label = keyLabel(pair.keyIndex);
    // The key travels both ways the REST API documents: as `x-goog-api-key` and
    // as the `key` query parameter, so a proxy that strips unknown headers
    // cannot break the call.
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
      markCooling(
        pair.key,
        pair.model,
        err?.name === 'TimeoutError' ? TIMEOUT_COOLDOWN_MS : SERVER_COOLDOWN_MS,
        reason
      );
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

      if (response.status === 404 || isRetiredModel(text)) {
        // A 404 on a model path means either "this name is retired/not for this
        // project" (Google's wording: "no longer available to new users") or
        // "this key cannot use the API at all", which Google also reports as
        // 404. The answer's own wording decides: a model complaint reds out that
        // model and lets the grid move on; anything else is surfaced as-is.
        if (isRetiredModel(text) || /model/i.test(text)) {
          markModelInvalid(pair.model, keys, `unavailable: ${detail.slice(0, 120)}`);
          failures.push(`${pair.model}: unavailable (${response.status})`);
          modelProblem = true;
          logger.warn(`Gemini model ${pair.model} is not available (${response.status}); that model is now red.`);
          continue;
        }
        throw new Error(`Gemini បដិសេធការហៅ (${response.status})${detail ? `: ${detail}` : ''}`);
      }

      if (response.status >= 500) {
        markCooling(pair.key, pair.model, SERVER_COOLDOWN_MS, `service error (${response.status})`);
        failures.push(`${label}/${pair.model}: service error ${response.status}`);
        continue;
      }

      // Any other 400 is about the request itself (audio the model refuses, a
      // malformed body). Retrying it elsewhere would repeat the same answer.
      throw new Error(
        `Gemini បដិសេធសំណើនេះ (${response.status})${detail ? `: ${detail}` : ''}`
      );
    }

    // Success: this pair is healthy again, and it earns the first attempt of the
    // next request too.
    markReady(pair.key, pair.model);
    lastGoodModel = pair.model;

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
      logger.info(`Gemini served ${options.label} with ${label}/${pair.model}`);
    }

    return {
      result: {
        data: options.parse(extractJson(answer)),
        model: pair.model,
        keyLabel: label,
        attempts,
      },
      failures,
      modelProblem,
    };
  }

  return { failures, modelProblem };
}

/**
 * Ask Gemini for strict JSON, rotating through the grid on a refused pair.
 *
 * Two rounds at most: the configured names, then — only if the failures were
 * about the names themselves — whatever `ListModels` says this key can call. A
 * grid that is red purely on quota does not pay for a discovery call.
 */
export async function generateGeminiJson<T>(
  options: GenerateOptions<T>
): Promise<GeminiJsonResult<T>> {
  const { keys } = getGeminiKeys();

  if (!keys.length) {
    throw new GeminiUnavailableError(
      'មិនទាន់មាន Gemini key ទេ។ សូមបញ្ចូល key ក្នុងផ្ទាំង «សម្អាតសំឡេង · Gemini» ឬកំណត់ GEMINI_API_KEYS។'
    );
  }

  const configured = getGeminiModels();
  const first = await runGrid(options, keys, allGeminiModels());
  if (first.result) return first.result;

  if (first.modelProblem) {
    const before = allGeminiModels();
    const discovered = await discoverGeminiModels(keys, before);
    if (discovered.length) {
      const retry = await runGrid(options, keys, allGeminiModels());
      if (retry.result) return retry.result;
      throw new GeminiExhaustedError(exhaustedMessage([...first.failures, ...retry.failures]));
    }
  }

  throw new GeminiExhaustedError(exhaustedMessage(first.failures, configured));
}

function exhaustedMessage(failures: string[], models: string[] = []): string {
  const detail = failures.slice(-4).join(' · ');
  return `Gemini key/model ទាំងអស់កំពុងស្ថិតក្នុងស្ថានភាពក្រហម (អស់កំណត់ ឬត្រូវបានបដិសេធ)។ សូមរង់ចាំបន្តិច ឬបន្ថែម key ថ្មី។ ${
    models.length ? `[models: ${models.join(', ')}] ` : ''
  }${detail ? `(${detail})` : ''}`;
}

/** Google's own wording for a model that a new project may not call. */
function isRetiredModel(body: string): boolean {
  return /no longer available|not available to new users|update your code to use|not found for api version|is not supported for generatecontent/i.test(
    body
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
 * With `responseMimeType: application/json` the text is already bare JSON, but a
 * model occasionally wraps it in a fence or adds a sentence, and losing a whole
 * chunk's analysis to that would be silly.
 */
/**
 * Recover the finished spans from an answer that was cut off mid-list.
 *
 * `maxOutputTokens` is a hard stop, so a long list of spans ends mid-object —
 * `[{...},{...},{"start":12.` — and the whole answer stops being parseable,
 * which used to throw away every span in that part. Each **complete** `{…}`
 * entry is kept instead (a truncated tail simply does not match), so the model's
 * finished work is worth a partial cleanup rather than a failed job.
 */
function salvageSpans(text: string): unknown | null {
  const objects = text.match(/\{[^{}]*\}/g);
  if (!objects) return null;
  const spans = objects.filter((item) => /"start"/.test(item) && /"end"/.test(item));
  if (!spans.length) return null;

  try {
    return {
      voice: !/"voice"\s*:\s*false/.test(text),
      speechFraction: 1,
      noise: JSON.parse(`[${spans.join(',')}]`),
    };
  } catch {
    return null;
  }
}

export function extractJson(answer: string): unknown {
  const trimmed = answer.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        const salvaged = salvageSpans(candidate);
        if (salvaged) {
          logger.warn('Gemini answer was cut off; keeping the spans it did finish.');
          return salvaged;
        }
      }
    }
    throw new Error('Gemini ឆ្លើយតបមិនមែនជា JSON ទេ។ (Gemini did not return JSON.)');
  }
}

/** Test hook / admin: forget every red mark and learned model name. */
export function resetGeminiPoolState(): void {
  pairStates.clear();
  discoveredModels = [];
  lastGoodModel = '';
}
