/**
 * Retry Handler with Exponential Backoff
 * 
 * Generic retry utility designed for rate-limited APIs.
 * Implements exponential backoff with jitter, specifically
 * handling HTTP 429 responses from the Nvidia NIM API.
 * 
 * @module infrastructure/nvidia/retry-handler
 */

import {
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_BACKOFF_FACTOR,
  RETRY_MAX_DELAY_MS,
} from '@/config/constants';
import { MaxRetriesExhaustedError, RateLimitError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('RetryHandler');

/**
 * Configuration options for the retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffFactor?: number;
  /** Maximum delay cap in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Optional label for logging context */
  operationName?: string;
}

/**
 * Executes an async function with exponential backoff retry logic.
 * 
 * Specifically designed to handle:
 * - HTTP 429 (Rate Limit) errors with Retry-After header support
 * - Transient network failures
 * - Server errors (5xx)
 * 
 * @param fn - The async function to execute and potentially retry
 * @param options - Retry configuration
 * @returns The result of the successful function execution
 * 
 * @throws {MaxRetriesExhaustedError} When all retry attempts are exhausted
 * 
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => callNvidiaApi(payload),
 *   { operationName: 'embedding', maxAttempts: 3 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = RETRY_MAX_ATTEMPTS,
    baseDelayMs = RETRY_BASE_DELAY_MS,
    backoffFactor = RETRY_BACKOFF_FACTOR,
    maxDelayMs = RETRY_MAX_DELAY_MS,
    operationName = 'operation',
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if the error is retryable
      if (!isRetryable(error) || attempt === maxAttempts) {
        if (attempt === maxAttempts) {
          log.error(`${operationName} failed after ${maxAttempts} attempts`, {
            error: lastError.message,
            attempts: maxAttempts,
          });
          throw new MaxRetriesExhaustedError(maxAttempts, lastError);
        }
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = calculateDelay(
        attempt,
        baseDelayMs,
        backoffFactor,
        maxDelayMs,
        error
      );

      log.warn(`${operationName} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`, {
        error: lastError.message,
        attempt,
        delay,
      });

      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new MaxRetriesExhaustedError(maxAttempts, lastError);
}

// ─── Private Helpers ────────────────────────────────────────────────────────

/**
 * Determines if an error is retryable.
 * Retryable: 429 (rate limit), 5xx (server errors), network errors.
 * Not retryable: 4xx (client errors except 429), validation errors.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;

  if (error && typeof error === 'object') {
    const statusCode = (error as Record<string, unknown>).statusCode ??
      (error as Record<string, unknown>).status;

    if (typeof statusCode === 'number') {
      // Retry on 429 (rate limit) and 5xx (server errors)
      return statusCode === 429 || statusCode >= 500;
    }

    // Retry on network errors (no status code)
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') {
      return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code);
    }
  }

  return false;
}

/**
 * Calculates the retry delay using exponential backoff with jitter.
 * Respects Retry-After header if present on rate limit errors.
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  backoffFactor: number,
  maxDelayMs: number,
  error: unknown
): number {
  // Respect Retry-After from rate limit errors
  if (error instanceof RateLimitError && error.retryAfterMs) {
    return Math.min(error.retryAfterMs, maxDelayMs);
  }

  // Exponential backoff: base * factor^(attempt-1)
  const exponentialDelay = baseDelayMs * Math.pow(backoffFactor, attempt - 1);

  // Add jitter (±25%) to prevent thundering herd
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);

  return Math.min(Math.floor(exponentialDelay + jitter), maxDelayMs);
}

/**
 * Promise-based sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
