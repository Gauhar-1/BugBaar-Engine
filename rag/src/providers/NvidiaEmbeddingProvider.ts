/**
 * NvidiaEmbeddingProvider
 *
 * Implements IEmbeddingProvider using the NVIDIA NIM API via direct fetch.
 * Preserves the original retry logic and rate-limit handling from the
 * existing nvidia-client.ts.
 *
 * @module providers/NvidiaEmbeddingProvider
 */

import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';
import { getNvidiaApiKey, getNvidiaBaseUrl, getNvidiaEmbedModel } from '@/config/env';
import { EmbeddingError, RateLimitError, NvidiaApiError } from '@/lib/errors';
import { withRetry } from '@/infrastructure/nvidia/retry-handler';
import { createLogger } from '@/lib/logger';

const log = createLogger('NvidiaEmbeddingProvider');

interface NvidiaEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens: number };
}

export class NvidiaEmbeddingProvider implements IEmbeddingProvider {
  constructor() {
    log.info('NVIDIA NIM embedding provider initialized', { model: getNvidiaEmbedModel() });
  }

  /**
   * Generates a single embedding via NVIDIA NIM.
   */
  async embed(text: string, inputType: 'query' | 'passage' = 'query'): Promise<number[]> {
    log.info('Generating single NVIDIA embedding', { textLength: text.length, inputType });

    return withRetry(() => this.fetchSingle(text, inputType), {
      operationName: 'nvidia-embed',
      maxAttempts: 3,
    });
  }

  /**
   * Generates batch embeddings via NVIDIA NIM.
   */
  async embedBatch(texts: string[], inputType: 'query' | 'passage' = 'passage'): Promise<number[][]> {
    log.info('Generating NVIDIA batch embeddings', { count: texts.length, inputType });

    return withRetry(() => this.fetchBatch(texts, inputType), {
      operationName: 'nvidia-embed-batch',
      maxAttempts: 3,
    });
  }

  // ─── Private Implementation ─────────────────────────────────────────────────

  private async fetchSingle(text: string, inputType: string): Promise<number[]> {
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
      await this.handleApiError(response);
    }

    const data = await response.json() as NvidiaEmbeddingResponse;

    if (!data.data || data.data.length === 0) {
      throw new EmbeddingError('NVIDIA API returned empty embedding data');
    }

    log.debug('NVIDIA embedding generated', {
      dimensions: data.data[0].embedding.length,
      tokens: data.usage?.total_tokens,
    });

    return data.data[0].embedding;
  }

  private async fetchBatch(texts: string[], inputType: string): Promise<number[][]> {
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
      await this.handleApiError(response);
    }

    const data = await response.json() as NvidiaEmbeddingResponse;

    return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }

  private async handleApiError(response: Response): Promise<never> {
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
      log.warn('NVIDIA rate limit hit', { retryAfterMs });
      throw new RateLimitError(retryAfterMs);
    }

    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      // ignore body read error
    }

    log.error('NVIDIA API error', { status: response.status, body: errorBody.slice(0, 500) });

    throw new NvidiaApiError(
      `NVIDIA API returned ${response.status}: ${errorBody.slice(0, 200)}`,
      response.status,
      response.status >= 500
    );
  }
}
