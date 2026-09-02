/**
 * CohereReranker
 *
 * Implements IReranker using the Cohere rerank API.
 * Falls back gracefully to original ordering on API failure.
 *
 * @module providers/CohereReranker
 */

import { CohereClient } from 'cohere-ai';
import { IReranker } from '@/interfaces/IReranker';
import { RerankResult } from '@/types';
import { getCohereApiKey, getCohereRerankModel } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('CohereReranker');

export class CohereReranker implements IReranker {
  private client: CohereClient;
  private model: string;

  constructor() {
    this.client = new CohereClient({ token: getCohereApiKey() });
    this.model = getCohereRerankModel();
    log.info('Cohere reranker initialized', { model: this.model });
  }

  /**
   * Reranks candidate texts against a query using Cohere's cross-encoder model.
   * Falls back to original order on failure (graceful degradation).
   */
  async rerank(query: string, candidates: string[], topN: number): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    log.info('Reranking candidates', {
      query: query.slice(0, 80),
      candidateCount: candidates.length,
      topN,
    });

    try {
      const response = await this.client.rerank({
        model: this.model,
        query,
        documents: candidates,
        topN: Math.min(topN, candidates.length),
      });

      const results: RerankResult[] = response.results.map((r) => ({
        index: r.index,
        relevanceScore: r.relevanceScore,
      }));

      log.info('Reranking completed', { returnedCount: results.length });

      return results;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Cohere reranking failed — falling back to original order', {
        error: err.message,
      });

      // Graceful fallback: return original order with neutral scores
      return candidates.slice(0, topN).map((_, index) => ({
        index,
        relevanceScore: 1.0 - index * 0.01, // synthetic descending score
      }));
    }
  }
}
