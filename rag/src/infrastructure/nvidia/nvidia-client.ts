/**
 * Nvidia NIM Utility Client
 *
 * Low-level fetch helpers for NVIDIA NIM embeddings API.
 * No Vercel AI SDK / Next.js dependencies.
 * Consumed by NvidiaEmbeddingProvider.
 *
 * @module infrastructure/nvidia/nvidia-client
 */

import { getNvidiaApiKey, getNvidiaBaseUrl, getNvidiaEmbedModel, getNvidiaSummarizationModel } from '@/config/env';
import { EmbeddingInputType, EmbeddingResponse } from './types';
import { withRetry } from './retry-handler';
import { EmbeddingError, NvidiaApiError, RateLimitError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('NvidiaClient');

// ─── Embeddings ───────────────────────────────────────────────────────────────

/**
 * Generates an embedding vector for the given text using NVIDIA NIM.
 * Wraps the call in retry logic for resilience.
 */
export async function getEmbedding(
  text: string,
  inputType: EmbeddingInputType = 'query'
): Promise<number[]> {
  log.info('Generating embedding', { textLength: text.length, inputType });

  return withRetry(() => fetchEmbedding(text, inputType), {
    operationName: 'embedding',
    maxAttempts: 3,
  });
}

/**
 * Generates embeddings for multiple texts in a single API call.
 */
export async function getEmbeddings(
  texts: string[],
  inputType: EmbeddingInputType = 'passage'
): Promise<number[][]> {
  log.info('Generating batch embeddings', { count: texts.length, inputType });

  return withRetry(() => fetchBatchEmbeddings(texts, inputType), {
    operationName: 'batch-embedding',
    maxAttempts: 3,
  });
}

// ─── Private Implementation ─────────────────────────────────────────────────

async function fetchEmbedding(text: string, inputType: EmbeddingInputType): Promise<number[]> {
  const url = `${getNvidiaBaseUrl()}/embeddings`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getNvidiaApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text,
      model: getNvidiaEmbedModel(),
      input_type: inputType,
      encoding_format: 'float',
      truncate: 'END',
    }),
  });

  if (!response.ok) {
    await handleApiError(response);
  }

  const data = await response.json() as EmbeddingResponse;

  if (!data.data || data.data.length === 0) {
    throw new EmbeddingError('NVIDIA API returned empty embedding data');
  }

  log.debug('Embedding generated', {
    dimensions: data.data[0].embedding.length,
    tokens: data.usage?.total_tokens,
  });

  return data.data[0].embedding;
}

async function fetchBatchEmbeddings(
  texts: string[],
  inputType: EmbeddingInputType
): Promise<number[][]> {
  const url = `${getNvidiaBaseUrl()}/embeddings`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getNvidiaApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: texts,
      model: getNvidiaEmbedModel(),
      input_type: inputType,
      encoding_format: 'float',
      truncate: 'END',
    }),
  });

  if (!response.ok) {
    await handleApiError(response);
  }

  const data = await response.json() as EmbeddingResponse;
  return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

async function handleApiError(response: Response): Promise<never> {
  const status = response.status;

  if (status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
    log.warn('Rate limit hit on NVIDIA API', { retryAfterMs });
    throw new RateLimitError(retryAfterMs);
  }

  let errorBody = '';
  try {
    errorBody = await response.text();
  } catch {
    // ignore
  }

  log.error('NVIDIA API error', { status, body: errorBody.slice(0, 500) });

  throw new NvidiaApiError(
    `NVIDIA API returned ${status}: ${errorBody.slice(0, 200)}`,
    status,
    status >= 500
  );
}
