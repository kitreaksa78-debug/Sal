import { ApiError, GoogleGenAI } from '@google/genai';
import { logger } from './logger.js';
import { getGeminiApiKeys } from './aiKeys.js';

/**
 * Gemini requests that survive the free tier.
 *
 * A single free key runs out of quota model by model, so one locked model would
 * stop translation for the rest of the day. Two axes are rotated instead:
 *
 *  - **models** — the model that ran out is skipped and the next one is asked,
 *    best Khmer quality first and the small/fast models last;
 *  - **keys** — when a key is rejected (or every model on it is spent), the next
 *    key starts its own sweep from the best model.
 *
 * The order is deliberate: the user asked for "model 1 exhausted -> use a model
 * that still has quota, key 1 exhausted -> key 2", which is exactly this sweep.
 * Nothing about the caller changes — the same JSON is asked for, one model
 * later.
 */

/**
 * The one Gemini model this site translates with.
 *
 * The owner asked for "the Gemini 2 Flash model, one model only". That family
 * cannot be used any more: every 2.5 model is retired for new accounts and
 * answers 404, measured on both of this project's keys:
 *
 *   gemini-2.5-flash       404  "no longer available to new users. Please update
 *                                your code to use models/gemini-3.8-flash"
 *   gemini-2.5-flash-lite  404  "… please use models/gemini-3.5-flash-lite"
 *   gemini-2.5-pro         404  "… please use models/gemini-3.1-pro-preview"
 *
 * So this holds the Flash model that actually serves this project. Google names
 * gemini-3.8-flash as the first successor, but it answers 503 "high demand"
 * from both of these keys (measured, three tries in a row), which pushes every
 * block into the Groq fallback; gemini-3.5-flash answered 4 of 4 across both
 * keys in 0.7–1.0s, strict `responseSchema` included.
 *
 * One model only, as asked. That single entry is what changes the rotation from
 * a sweep to a key walk: there is no second model to move to, so the two
 * configured keys are what it rotates — key #1 first and key #2 the moment
 * key #1's daily quota is spent, its request is throttled, or the project
 * itself is denied.
 */
export const DEFAULT_GEMINI_MODELS = ['gemini-3.5-flash'];

function parseModelList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

/**
 * The models to try, in order.
 *
 * `GEMINI_TRANSLATION_MODELS` (comma separated) replaces the list entirely.
 * `GEMINI_MODEL` — the single-model variable this app documented first — is
 * moved to the front, with the rest of the free-tier models still behind it as
 * quota fallbacks, so setting it cannot take the rotation away.
 */
export function getGeminiModels(): string[] {
  const explicit = parseModelList(process.env.GEMINI_TRANSLATION_MODELS);
  if (explicit.length > 0) return Array.from(new Set(explicit));

  return Array.from(new Set([...parseModelList(process.env.GEMINI_MODEL), ...DEFAULT_GEMINI_MODELS]));
}

export function isGeminiConfigured(): boolean {
  return getGeminiApiKeys().length > 0;
}

/**
 * Whether at least one configured key can still be asked.
 *
 * Callers use this to skip the provider entirely instead of paying for its sweep.
 * Measured on this project: a Gemini project that was denied access made every
 * call walk the model list and both keys, and the job only reached its other
 * provider after the sweeps and backoff rounds had run out — the slowest part of
 * a translation stage that should take seconds. A provider with nothing left to
 * try is not asked again until a denial cools off (see `keyDeniedUntil`).
 */
export function hasUsableGeminiKey(): boolean {
  const keys = getGeminiApiKeys();
  for (let index = 0; index < keys.length; index++) {
    if (!isKeyDenied(index)) return true;
  }
  return false;
}

/**
 * What the rotation has learned about this process's keys and models.
 *
 * Kept at module scope rather than per request: a key whose project was denied
 * access fails on every call, and a model that spent its daily quota does not
 * get it back within one job — re-discovering either on every block would add a
 * wasted request per block for the whole video.
 */
const spentForToday = new Set<string>();
const spentModelNames = new Set<string>();
const keyRejections = new Map<number, number>();

/**
 * Keys the API rejected outright, with the time each may be tried again.
 *
 * A key whose project has no access fails on every call, so it is put aside — but
 * only for a while. Access can be granted again (a quota bump, a project fix),
 * and a key written off for the life of the process would never notice; the
 * cooldown is long enough that a job never re-pays the discovery, short enough
 * that a fixed account is picked up without a redeploy.
 */
const keyDeniedUntil = new Map<number, number>();
const KEY_DENIAL_COOLDOWN_MS = Number(process.env.GEMINI_KEY_DENIAL_MS || '900000');

/** Whether `keyIndex` is still inside its denial cooldown. */
function isKeyDenied(keyIndex: number): boolean {
  const until = keyDeniedUntil.get(keyIndex);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    keyDeniedUntil.delete(keyIndex);
    return false;
  }
  return true;
}

function denyKey(keyIndex: number): void {
  keyDeniedUntil.set(keyIndex, Date.now() + KEY_DENIAL_COOLDOWN_MS);
}

/**
 * Pairs that failed a moment ago, with the time they may be asked again.
 *
 * Module scope, unlike the per-call state it replaces, because translation blocks
 * now run concurrently: the free-tier flashes regularly answer 503 "high demand"
 * for whole minutes, and when every in-flight block rediscovers that on its own
 * the walk through the dead models costs more wall time than the concurrency
 * saves. One block pays for the discovery, the others go straight to a live model.
 */
const throttledUntil = new Map<string, number>();

/** How long a model that answered 503 (or hit a per-minute limit) sits out. */
const THROTTLE_COOLDOWN_MS = Number(process.env.GEMINI_THROTTLE_COOLDOWN_MS || '60000');

/**
 * How long one model call may take before the rotation moves on.
 *
 * A free-tier endpoint that stalls instead of answering keeps the block waiting
 * for as long as the socket stays open — one production job lost 76 seconds to a
 * single call that never returned — and while it waits the sweep cannot reach a
 * model that would have answered in a second.
 */
const GEMINI_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || '20000');

/**
 * How long one call may spend walking models before it gives up.
 *
 * The rotation only helps while a model answers; when a whole free tier is
 * returning "high demand" and "exceeded your current quota" the walk itself
 * becomes the slowest part of the job — a measured sweep of the default list
 * spent 52 seconds inside one stalled model alone, and the caller had no way to
 * move on. The budget bounds that: after this long the call reports failure and
 * the caller can use its other configured provider (Groq) instead of waiting
 * through another round of retries.
 *
 * With one model and two keys this has to hold two real attempts: the first key
 * may spend its whole 20s call ceiling on a stalled request, and the second key
 * still gets a usable call after it.
 */
const GEMINI_SWEEP_BUDGET_MS = Number(process.env.GEMINI_SWEEP_BUDGET_MS || '30000');

/**
 * The shortest request deadline the Gemini API accepts.
 *
 * It rejects anything below ten seconds with `INVALID_ARGUMENT` — "Manually set
 * deadline 4s is too short. Minimum allowed deadline is 10s." — so a sweep that
 * squeezed its last call into whatever the budget had left (four seconds, say)
 * collected a 400 that reads like a malformed request rather than a timeout, and
 * the rotation counted it as a model that cannot take the schema. Stopping while
 * ten seconds remain costs nothing: a call that short had no chance of
 * answering a translation block anyway.
 */
const GEMINI_MIN_CALL_TIMEOUT_MS = Number(process.env.GEMINI_MIN_CALL_TIMEOUT_MS || '10000');

/**
 * The model that answered last, tried first from then on. Without it every block
 * starts at the top of the list and walks the same unavailable models again.
 */
let preferredModel: string | null = null;

/**
 * One SDK client per key: each instance keeps its own connection pool, and a
 * rotation that rebuilt them per request would pay for a new pool every block.
 */
const clients = new Map<string, GoogleGenAI>();

function clientFor(apiKey: string): GoogleGenAI {
  let client = clients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    clients.set(apiKey, client);
  }
  return client;
}

/** Error carrying the HTTP status so callers can react to a specific failure. */
export class GeminiError extends Error {
  public readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

export interface GeminiJsonRequest {
  systemInstruction: string;
  userPrompt: string;
  /** JSON schema for the answer (`Type.*` from the SDK is accepted as-is). */
  responseSchema: Record<string, unknown>;
  temperature?: number;
  operationName: string;
  /** Extra full sweeps after every key/model pair came back empty-handed. */
  maxAttempts?: number;
}

export interface GeminiJsonResult {
  content: string;
  totalTokens: number;
  /** Which model answered, and which key (1-based). The key itself is never logged. */
  model: string;
  keyNumber: number;
  /** Models skipped on the way here because their quota was already spent. */
  skippedModels: string[];
}

/** How a failure should steer the rotation. */
type FailureKind = 'quota' | 'key' | 'model' | 'transient' | 'fatal';

function classifyFailure(
  err: unknown,
  operationName: string
): { kind: FailureKind; error: GeminiError } {
  const status = err instanceof ApiError ? err.status : 0;
  const message = err instanceof Error ? err.message : String(err);
  const text = `${status} ${message}`;

  const error = new GeminiError(
    `Gemini ${operationName} failed${status ? ` (${status})` : ''}: ${message.slice(0, 300)}`,
    status
  );

  if (
    status === 401 ||
    status === 403 ||
    /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|unauthenticated|invalid.*api key/i.test(text)
  ) {
    return { kind: 'key', error };
  }

  if (status === 404 || /not found|not supported for|does not support/i.test(text)) {
    return { kind: 'model', error };
  }

  if (status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota|rate limit/i.test(text)) {
    return { kind: 'quota', error };
  }

  // 400 is a rejected request, not a missing model: a schema that fails here
  // fails on every model, so it is only treated as fatal after a couple of
  // models have refused it (a model that simply cannot take a schema is the far
  // more common case, and moving on is the right answer for it).
  if (status === 400) return { kind: 'model', error };

  return { kind: 'transient', error };
}

/**
 * Whether the quota behind a 429 is gone until tomorrow rather than for the next
 * minute. A daily allowance does not come back inside one job, so those models
 * stay out of the rotation for the rest of the process; a per-minute limit just
 * moves to the next model and is retried in the next sweep.
 */
function isDailyExhaustion(error: GeminiError): boolean {
  return /per day|per-day|daily|free.?tier|RequestsPerDay|requests per day/i.test(error.message);
}

/**
 * Ask a Gemini model for a JSON answer, rotating models and keys.
 *
 * Returns the first good answer together with the model that produced it, so the
 * caller can log which one the job actually used.
 */
export async function geminiGenerateJson(request: GeminiJsonRequest): Promise<GeminiJsonResult> {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) {
    throw new GeminiError('GEMINI_API_KEY is not configured.', 0);
  }

  // Nothing left to ask: fail here rather than walk the list and the backoff for
  // a provider whose every key has already been rejected.
  if (!hasUsableGeminiKey()) {
    throw new GeminiError(
      `Gemini ${request.operationName}: every configured key has been rejected — not sweeping ${getGeminiModels().length} model(s) again.`,
      403
    );
  }

  const models = getGeminiModels();
  const maxAttempts = Math.max(1, request.maxAttempts ?? 2);

  // The model that answered last is asked first: while the newest flashes are
  // returning 503, starting at the top of the list costs seconds on every block.
  const modelOrder =
    preferredModel && models.includes(preferredModel)
      ? [preferredModel, ...models.filter((model) => model !== preferredModel)]
      : models;

  let lastError: GeminiError | null = null;
  let schemaRejections = 0;
  let backoffMs = 5_000;
  /** Hard stop for the whole walk; see GEMINI_SWEEP_BUDGET_MS. */
  const sweepDeadline = Date.now() + GEMINI_SWEEP_BUDGET_MS;
  /** Pairs this call walked past, reported so the rotation stays visible in logs. */
  let skippedPairs = 0;

  /** A pair that failed seconds ago is not worth asking again yet. */
  const isThrottled = (pair: string): boolean => {
    const until = throttledUntil.get(pair);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      throttledUntil.delete(pair);
      return false;
    }
    return true;
  };

  const throttlePair = (pair: string): void => {
    throttledUntil.set(pair, Date.now() + THROTTLE_COOLDOWN_MS);
  };

  for (let round = 1; round <= maxAttempts; round++) {
    // A new sweep is the deliberate second chance: every cooldown is expired here.
    if (round > 1) throttledUntil.clear();

    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      if (isKeyDenied(keyIndex)) continue;
      const key = keys[keyIndex];
      // 1-based everywhere it is mentioned; the key itself is never logged.
      const keyNumber = keyIndex + 1;

      for (const model of modelOrder) {
        const pair = `${keyNumber}:${model}`;
        if (spentForToday.has(pair)) {
          skippedPairs++;
          continue;
        }
        if (isThrottled(pair)) {
          skippedPairs++;
          continue;
        }

        // Out of time for this call: report what went wrong so the caller can
        // fall back to its other provider, rather than grinding through the
        // rest of the list (and a second sweep) first. The budget has to hold
        // one call the API will actually accept — see
        // GEMINI_MIN_CALL_TIMEOUT_MS — so the walk stops one call early instead
        // of spending its last seconds on a request that can only be rejected.
        const remainingMs = sweepDeadline - Date.now();
        if (remainingMs < GEMINI_MIN_CALL_TIMEOUT_MS) {
          logger.warn(
            `Gemini ${request.operationName}: giving up after ${Math.round(
              GEMINI_SWEEP_BUDGET_MS / 1000
            )}s — only ${Math.max(0, Math.round(remainingMs / 1000))}s of the budget left, too little for one call; ${skippedPairs} option(s) unavailable or throttled so far.`
          );
          throw (
            lastError ??
            new GeminiError(
              `Gemini ${request.operationName} could not be answered within ${Math.round(
                GEMINI_SWEEP_BUDGET_MS / 1000
              )}s (${models.length} models × ${keys.length} keys).`,
              0
            )
          );
        }

        try {
          // One call may never outlive the whole walk's budget, and never goes
          // below the API's minimum deadline. The deadline is only checked
          // between calls, so a call that started at second 29 with a
          // 20-second ceiling used to hold the job until second 49 — measured
          // on this project's own keys, the caller waited through exactly that
          // before it could fall back to its other provider.
          const callTimeoutMs = Math.max(
            GEMINI_MIN_CALL_TIMEOUT_MS,
            Math.min(GEMINI_REQUEST_TIMEOUT_MS, remainingMs)
          );
          const response = await clientFor(key).models.generateContent({
            model,
            contents: request.userPrompt,
            config: {
              systemInstruction: request.systemInstruction,
              temperature: request.temperature ?? 0.3,
              responseMimeType: 'application/json',
              responseSchema: request.responseSchema as never,
              // Bounded per call; the abort signal is the hard stop in case the
              // SDK's own timeout is not applied to this request.
              httpOptions: { timeout: callTimeoutMs },
              abortSignal: AbortSignal.timeout(callTimeoutMs + 5_000),
            },
          });

          const content = response.text?.trim() || '';
          if (!content) {
            lastError = new GeminiError(
              `Gemini ${request.operationName} answered with nothing (${model}).`,
              0
            );
            logger.warn(
              `Gemini ${request.operationName}: ${model} returned an empty answer, trying the next one.`
            );
            throttlePair(pair);
            continue;
          }

          // Remember what worked: the next block starts with this model instead of
          // rediscovering which of the models are unavailable.
          preferredModel = model;

          if (skippedPairs > 0 || round > 1) {
            logger.info(
              `Gemini ${request.operationName}: answered by ${model} (key #${keyNumber}) after skipping ${skippedPairs} spent or throttled option(s).`
            );
          }

          return {
            content,
            totalTokens: Number(response.usageMetadata?.totalTokenCount) || 0,
            model,
            keyNumber,
            skippedModels: [...spentModelNames],
          };
        } catch (err) {
          const { kind, error } = classifyFailure(err, request.operationName);
          lastError = error;

          if (kind === 'key') {
            const rejections = (keyRejections.get(keyIndex) ?? 0) + 1;
            keyRejections.set(keyIndex, rejections);
            spentForToday.add(pair);

            if (rejections >= 2) {
              denyKey(keyIndex);
              logger.warn(
                `Gemini ${request.operationName}: key #${keyNumber} was rejected twice (${
                  error.status || 'no status'
                }), switching to the next key.`
              );
              break;
            }

            logger.warn(
              `Gemini ${request.operationName}: key #${keyNumber} rejected ${model} (${
                error.status || 'no status'
              }), trying another model on the same key.`
            );
            continue;
          }

          if (kind === 'quota') {
            const daily = isDailyExhaustion(error);
            if (daily) {
              spentForToday.add(pair);
              spentModelNames.add(model);
            } else {
              throttlePair(pair);
            }
            logger.warn(
              `Gemini ${request.operationName}: ${model} on key #${keyNumber} is out of quota${
                daily ? ' for today' : ' for now'
              }, trying the next model.`
            );
            continue;
          }

          if (kind === 'model') {
            if (error.status === 400 && ++schemaRejections >= 3) {
              logger.error(
                `Gemini ${request.operationName}: several models refused the request, stopping. ${error.message}`
              );
              throw error;
            }
            spentForToday.add(pair);
            logger.warn(
              `Gemini ${request.operationName}: ${model} cannot take this request (${
                error.status || 'no status'
              }), trying the next model.`
            );
            continue;
          }

          if (kind === 'fatal') throw error;

          logger.warn(
            `Gemini ${request.operationName}: ${model} hit a temporary error, trying the next option. ${error.message}`
          );
          throttlePair(pair);
        }
      }
    }

    // Every model on every key has been tried in this sweep. Waiting for another
    // one is only worth the job's time while some key can still be asked: with
    // every key rejected, the next sweep asks exactly the same nothing.
    if (round < maxAttempts && !hasUsableGeminiKey()) {
      logger.warn(
        `Gemini ${request.operationName}: every configured key is rejected, not waiting for another sweep.`
      );
      break;
    }

    if (round < maxAttempts) {
      // A second sweep is only worth starting while there is time for it;
      // sleeping past the deadline just makes the caller wait for nothing.
      const sleepMs = Math.min(backoffMs, sweepDeadline - Date.now());
      if (sleepMs < 1_000) {
        logger.warn(
          `Gemini ${request.operationName}: out of time for another sweep, reporting the failure.`
        );
        break;
      }
      logger.warn(
        `Gemini ${request.operationName}: every configured model and key is spent or throttled, waiting ${Math.round(
          sleepMs / 1000
        )}s before sweep ${round + 1}/${maxAttempts}.`
      );
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  throw (
    lastError ??
    new GeminiError(
      `Gemini ${request.operationName} failed on every configured model (${models.length}) and key (${keys.length}).`,
      0
    )
  );
}
