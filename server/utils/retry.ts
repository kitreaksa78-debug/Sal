import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  operationName?: string;
  shouldRetry?: (error: any) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelay = options.initialDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 8000;
  const factor = options.factor ?? 2;
  const operationName = options.operationName ?? 'Operation';

  let attempt = 1;
  let delay = initialDelay;

  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt >= maxAttempts;

      // Check if error is transient / retryable
      const status = error?.status || error?.statusCode || error?.response?.status;
      const isRateLimit = status === 429 || /rate limit|resource exhausted|too many requests/i.test(error?.message || '');
      const isServerTransient = status >= 500 && status < 600;
      const isNetworkTimeout = /timeout|econnreset|econnrefused|etimedout|socket hang up/i.test(error?.message || '');
      
      const customShouldRetry = options.shouldRetry ? options.shouldRetry(error) : true;
      const retryable = customShouldRetry && (isRateLimit || isServerTransient || isNetworkTimeout || !status);

      if (isLastAttempt || !retryable) {
        logger.error(`[Retry] ${operationName} failed permanently on attempt ${attempt}/${maxAttempts}: ${error?.message || error}`);
        throw error;
      }

      logger.warn(`[Retry] ${operationName} failed (attempt ${attempt}/${maxAttempts}). Retrying in ${delay}ms... Error: ${error?.message || error}`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      delay = Math.min(delay * factor, maxDelay);
      attempt++;
    }
  }
}
