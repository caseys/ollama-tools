/**
 * Generic retry utilities for pipeline steps.
 */

// === Sampling Parameters ===

export interface SamplingParams {
  temperature: number;
  top_p: number;
  top_k: number;
  stop?: string[];
}

const RETRY_TEMPS = [0.4, 0.2, 0.6, 0.3, 0.5, 0.1];
const RETRY_TOP_P = [0.8, 0.82, 0.84, 0.86, 0.88, 0.9];
const RETRY_TOP_K = [20, 24, 28, 32, 36, 40];

/**
 * Get sampling params for a given attempt index.
 * Parameters progressively open up: temp oscillates, top_p/top_k increase.
 */
export function getSamplingParams(attempt: number, stop?: string[]): SamplingParams {
  const params: SamplingParams = {
    temperature: RETRY_TEMPS[attempt % RETRY_TEMPS.length] ?? 0.4,
    top_p: RETRY_TOP_P[attempt % RETRY_TOP_P.length] ?? 0.8,
    top_k: RETRY_TOP_K[attempt % RETRY_TOP_K.length] ?? 20,
  };
  if (stop) {
    params.stop = stop;
  }
  return params;
}

// === Basic Retry ===

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

// === Sampling-params-varying retry ===

export interface RetryWithParamsConfig {
  maxAttempts?: number;
  stop?: string[];
  onRetry?: (attempt: number) => void;
}

/**
 * Retry with varying sampling params on each attempt.
 * Temperature oscillates, top_p/top_k progressively increase.
 */
export async function retryWithVaryingParams<T>(
  fn: (params: SamplingParams) => Promise<T | undefined>,
  isEmpty: (result: T | undefined) => boolean,
  config: RetryWithParamsConfig = {}
): Promise<{ result: T | undefined; attempts: number; params: SamplingParams }> {
  const { maxAttempts = 3, stop, onRetry } = config;

  let attempts = 0;
  let lastResult: T | undefined;
  let lastParams = getSamplingParams(0, stop);

  while (attempts < maxAttempts) {
    const params = getSamplingParams(attempts, stop);
    lastParams = params;
    attempts++;

    lastResult = await fn(params);

    if (!isEmpty(lastResult)) {
      return { result: lastResult, attempts, params };
    }

    if (attempts < maxAttempts) {
      onRetry?.(attempts);
    }
  }

  return { result: lastResult, attempts, params: lastParams };
}
