import { logger } from './logger.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Groq keys, in priority order. Extra keys are optional and let requests rotate
 * past a key that was revoked or rate limited (Groq's free tier is tight).
 */
export function getGroqApiKeys(): string[] {
  const candidates = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY2,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY3,
    process.env.GROQ_API_KEY_3,
  ];

  const keys = candidates
    .map((key) => key?.trim())
    .filter((key): key is string => Boolean(key));

  return Array.from(new Set(keys));
}

export function isGroqConfigured(): boolean {
  return getGroqApiKeys().length > 0;
}

/** Error carrying the HTTP status so callers can react to specific failures. */
export class GroqError extends Error {
  public readonly status: number;
  /** Server-provided wait hint (the `retry-after` header) for 429/5xx responses. */
  public readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call a Groq OpenAI-compatible endpoint, moving to the next configured key when
 * the current one is rejected (401), rate limited (429) or hits a server error.
 */
export async function groqFetch(
  pathname: string,
  init: RequestInit,
  operationName: string
): Promise<Response> {
  const keys = getGroqApiKeys();
  if (keys.length === 0) {
    throw new Error('GROQ_API_KEY is not configured.');
  }

  let lastError: Error | null = null;

  for (let i = 0; i < keys.length; i++) {
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      Authorization: `Bearer ${keys[i]}`,
    };

    const response = await fetch(`${GROQ_BASE_URL}${pathname}`, { ...init, headers });

    if (response.ok) {
      return response;
    }

    const body = await response.text();
    const retryAfterSeconds = Number(response.headers.get('retry-after'));
    lastError = new GroqError(
      `Groq ${operationName} failed (${response.status}): ${body.slice(0, 300)}`,
      response.status,
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : undefined
    );

    const isRetryableWithAnotherKey =
      response.status === 401 || response.status === 429 || response.status >= 500;

    if (!isRetryableWithAnotherKey) break;

    if (i < keys.length - 1) {
      logger.warn(
        `Groq ${operationName}: key #${i + 1} returned ${response.status}, retrying with next key`
      );
    }
  }

  throw lastError ?? new Error(`Groq ${operationName} failed.`);
}

export interface GroqChatJsonRequest {
  model: string;
  systemInstruction: string;
  userPrompt: string;
  temperature?: number;
  operationName: string;
  maxAttempts?: number;
  /**
   * Strict JSON schema for the answer. Models that reject schemas automatically
   * retry once in basic JSON mode, so this is safe to pass for any model.
   */
  schema?: { name: string; schema: Record<string, unknown> };
  /**
   * Reasoning models bill hidden reasoning tokens as output, and those tokens
   * count against the per-minute budget. Lowering the effort for a mechanical
   * task like translation cuts both latency and token spend substantially.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Optional list of fallback models. When the primary model is rate-limited (429),
   * the system automatically tries the next model in the list until one succeeds
   * or all models are exhausted.
   */
  fallbackModels?: string[];
}

/**
 * Ask a Groq chat model for a JSON answer, absorbing the two failure modes that
 * used to kill long videos: models without structured-output support, and the
 * free tier's per-minute token ceiling (HTTP 429).
 *
 * On 429/5xx the call waits for the server's `retry-after` hint (or a growing
 * backoff) and tries again, so a busy minute no longer fails the whole job.
 */
export interface GroqChatJsonResult {
  content: string;
  /** Tokens the model actually billed, used to pace the next request. */
  totalTokens: number;
}

export async function groqChatJson(request: GroqChatJsonRequest): Promise<GroqChatJsonResult> {
  const {
    model,
    systemInstruction,
    userPrompt,
    temperature = 0.3,
    operationName,
  } = request;
  const maxAttempts = request.maxAttempts ?? 4;
  const fallbackModels = request.fallbackModels ?? [];
  const allModels = [model, ...fallbackModels];

  // Track which models have been tried and failed with 429
  const triedModels = new Set<string>();
  let currentModelIndex = 0;
  let currentModel = allModels[currentModelIndex];

  const send = (responseFormat: unknown, targetModel: string) =>
    groqFetch(
      '/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: targetModel,
          temperature,
          response_format: responseFormat,
          ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userPrompt },
          ],
        }),
      },
      operationName
    );

  let responseFormat: unknown = request.schema
    ? {
        type: 'json_schema',
        json_schema: {
          name: request.schema.name,
          strict: true,
          schema: request.schema.schema,
        },
      }
    : { type: 'json_object' };
  let usedJsonObjectFallback = !request.schema;

  let attempt = 0;
  let backoffMs = 2000;

  while (true) {
    attempt++;

    let response: Response;
    try {
      response = await send(responseFormat, currentModel);
    } catch (err) {
      // Not every Groq model supports structured outputs; retry once in basic JSON mode.
      if (err instanceof GroqError && err.status === 400 && !usedJsonObjectFallback) {
        usedJsonObjectFallback = true;
        responseFormat = { type: 'json_object' };
        logger.warn(
          `Groq ${operationName}: model ${currentModel} rejected the JSON schema, retrying with basic JSON mode.`
        );
        continue;
      }

      const status = err instanceof GroqError ? err.status : 0;
      
      // Handle rate limiting (429) with model fallback
      if (status === 429) {
        triedModels.add(currentModel);
        
        // Try next model in the fallback list
        if (currentModelIndex < allModels.length - 1) {
          currentModelIndex++;
          currentModel = allModels[currentModelIndex];
          logger.warn(
            `Groq ${operationName}: model ${allModels[currentModelIndex - 1]} rate-limited (429), falling back to ${currentModel}`
          );
          // Reset attempt counter for the new model
          attempt = 1;
          backoffMs = 2000;
          continue;
        }
        
        // All models exhausted for this attempt
        if (attempt < maxAttempts) {
          const waitMs = Math.min(
            err instanceof GroqError && err.retryAfterMs ? err.retryAfterMs : backoffMs,
            65_000
          );
          logger.warn(
            `Groq ${operationName}: all models rate-limited, waiting ${Math.round(
              waitMs / 1000
            )}s before retry ${attempt + 1}/${maxAttempts}.`
          );
          await sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, 65_000);
          // Reset to primary model for next attempt
          currentModelIndex = 0;
          currentModel = allModels[currentModelIndex];
          continue;
        }
      }

      const retryable = status === 429 || status >= 500 || status === 0;
      if (!retryable || attempt >= maxAttempts) throw err;

      const waitMs = Math.min(
        err instanceof GroqError && err.retryAfterMs ? err.retryAfterMs : backoffMs,
        65_000
      );
      logger.warn(
        `Groq ${operationName} failed with ${status || 'a network error'}; waiting ${Math.round(
          waitMs / 1000
        )}s before attempt ${attempt + 1}/${maxAttempts}.`
      );
      await sleep(waitMs);
      backoffMs = Math.min(backoffMs * 2, 65_000);
      continue;
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    return {
      content: data.choices?.[0]?.message?.content?.trim() || '',
      totalTokens: Number(data.usage?.total_tokens) || 0,
    };
  }
}
