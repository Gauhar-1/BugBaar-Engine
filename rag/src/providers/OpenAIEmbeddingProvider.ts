/**
 * OpenAIEmbeddingProvider
 *
 * Implements IEmbeddingProvider using the official OpenAI SDK.
 * Supports single and batch embedding generation.
 *
 * @module providers/OpenAIEmbeddingProvider
 */

import OpenAI from 'openai';
import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';
import { getOpenAiApiKey, getOpenAiEmbedModel } from '@/config/env';
import { EmbeddingError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('OpenAIEmbeddingProvider');

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  private client: OpenAI;
  private model: string;

  constructor() {
    this.client = new OpenAI({ apiKey: getOpenAiApiKey() });
    this.model = getOpenAiEmbedModel();
    log.info('OpenAI embedding provider initialized', { model: this.model });
  }

  /**
   * Generates a single embedding for the given text.
   */
  async embed(text: string, inputType: 'query' | 'passage' = 'query'): Promise<number[]> {
    log.info('Generating single embedding', { textLength: text.length, inputType });

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: text,
        encoding_format: 'float',
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new EmbeddingError('OpenAI returned empty embedding data');
      }

      log.debug('Embedding generated', {
        dimensions: embedding.length,
        tokens: response.usage?.total_tokens,
      });

      return embedding;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('OpenAI embedding failed', { error: err.message });
      throw new EmbeddingError(`OpenAI embedding failed: ${err.message}`, err);
    }
  }

  /**
   * Generates embeddings for multiple texts in a single API call.
   * OpenAI natively supports array inputs.
   */
  async embedBatch(texts: string[], inputType: 'query' | 'passage' = 'passage'): Promise<number[][]> {
    log.info('Generating batch embeddings', { count: texts.length, inputType });

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
        encoding_format: 'float',
      });

      // Sort by index to preserve order (OpenAI guarantees order but let's be safe)
      const sorted = response.data.sort((a, b) => a.index - b.index);

      log.debug('Batch embeddings generated', {
        count: sorted.length,
        tokens: response.usage?.total_tokens,
      });

      return sorted.map((item) => item.embedding);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('OpenAI batch embedding failed', { error: err.message });
      throw new EmbeddingError(`OpenAI batch embedding failed: ${err.message}`, err);
    }
  }
}
