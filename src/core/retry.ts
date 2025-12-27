/**
 * Generic retry utilities for pipeline steps.
 */

export interface RetryConfig {
  maxAttempts: number;
  delayMs?: number;
  onRetry?: (attempt: number, reason: string) => void;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  delayMs: 0,
};

/**
 * Retry a function until it succeeds or max attempts reached.
 * Caller controls retry condition via shouldRetry predicate.
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  config: Partial<RetryConfig> = {}
): Promise<{ result: T; attempts: number }> {
  const { maxAttempts, delayMs, onRetry } = { ...DEFAULT_CONFIG, ...config };

  let attempts = 0;
  let lastResult: T;

  while (attempts < maxAttempts) {
    attempts++;
    lastResult = await fn();

    if (!shouldRetry(lastResult)) {
      return { result: lastResult, attempts };
    }

    if (attempts < maxAttempts) {
      onRetry?.(attempts, "retry condition met");
      if (delayMs && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  return { result: lastResult!, attempts };
}

/**
 * Retry on empty result.
 * @param fn - async function that may return null/empty
 * @param isEmpty - predicate to check if result is empty
 * @param config - retry configuration
 */
export async function retryOnEmpty<T>(
  fn: () => Promise<T | null>,
  isEmpty: (result: T | null) => boolean,
  config: Partial<RetryConfig> = {}
): Promise<{ result: T | null; attempts: number }> {
  return runWithRetry(fn, isEmpty, config);
}

/**
 * Retry on thrown error.
 * Catches errors and retries, returning the last error if all attempts fail.
 */
export async function retryOnError<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<{ result: T | undefined; attempts: number; error?: Error }> {
  const { maxAttempts, delayMs, onRetry } = { ...DEFAULT_CONFIG, ...config };

  let attempts = 0;
  let lastError: Error | undefined;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const result = await fn();
      return { result, attempts };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempts < maxAttempts) {
        onRetry?.(attempts, lastError.message);
        if (delayMs && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  const result: { result: T | undefined; attempts: number; error?: Error } = {
    result: undefined,
    attempts,
  };
  if (lastError) {
    result.error = lastError;
  }
  return result;
}
