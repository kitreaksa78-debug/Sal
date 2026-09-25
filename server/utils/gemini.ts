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
 * Model order when nothing overrides it. The newest flash models translate
 * Khmer well and have the most generous free quota; the pro models are stronger
 * but spend their small allowance quickly, so they sit behind the flashes; the
 * lite models are the last resort before giving up.
 */
export const DEFAULT_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-3.1-pro-preview',
  'gemini-pro-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
];

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
 * What the rotation has learned about this process's keys and models.
 *
 * Kept at module scope rather than per request: a key whose project was denied
 * access fails on every call, and a model that spent its daily quota does not
 * get it back within one job — re-discovering either on every block would add a
 * wasted request per block for the whole video.
 */
const spentForToday = new Set<string>();
const spentModelNames = new Set<string>();
const deniedKeys = new Set<number>();
const keyRejections = new Map<number, number>();

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

  const models = getGeminiModels();
  const maxAttempts = Math.max(1, request.maxAttempts ?? 2);

  /** Pairs spent for the day: no point asking them again inside this process. */
  /** Pairs that only hit a per-minute limit; retried on the next sweep. */
  let throttledPairs = new Set<string>();

  let lastError: GeminiError | null = null;
  let schemaRejections = 0;
  let backoffMs = 5_000;

  for (let round = 1; round <= maxAttempts; round++) {
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      if (deniedKeys.has(keyIndex)) continue;
      const key = keys[keyIndex];
      // 1-based everywhere it is mentioned; the key itself is never logged.
      const keyNumber = keyIndex + 1;

      for (const model of models) {
        const pair = `${keyNumber}:${model}`;
        if (spentForToday.has(pair)) continue;
        if (throttledPairs.has(pair)) continue;

        try {
          const response = await clientFor(key).models.generateContent({
            model,
            contents: request.userPrompt,
            config: {
              systemInstruction: request.systemInstruction,
              temperature: request.temperature ?? 0.3,
              responseMimeType: 'application/json',
              responseSchema: request.responseSchema as never,
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
            throttledPairs.add(pair);
            continue;
          }

          if (spentForToday.size > 0 || throttledPairs.size > 0 || round > 1) {
            logger.info(
              `Gemini ${request.operationName}: answered by ${model} (key #${keyNumber}) after rotating past ${
                spentForToday.size + throttledPairs.size
              } exhausted option(s).`
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
              deniedKeys.add(keyIndex);
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
              throttledPairs.add(pair);
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
          throttledPairs.add(pair);
        }
      }
    }

    // Every model on every key has been tried in this sweep.
    if (round < maxAttempts) {
      logger.warn(
        `Gemini ${request.operationName}: every configured model and key is spent or throttled, waiting ${Math.round(
          backoffMs / 1000
        )}s before sweep ${round + 1}/${maxAttempts}.`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
      // A per-minute limit may lift by the next sweep; a daily one never does.
      throttledPairs = new Set();
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
