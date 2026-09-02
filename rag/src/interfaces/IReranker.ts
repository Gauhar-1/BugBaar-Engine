/**
 * IReranker Interface
 *
 * Abstraction over cross-encoder reranking models (Cohere, Jina, etc.).
 * Takes a query and candidate documents, returns them sorted by relevance.
 *
 * @module interfaces/IReranker
 */

import { RerankResult } from '@/types';

export interface IReranker {
  /**
   * Reranks a list of candidate documents against a query.
   *
   * @param query - The original user query
   * @param candidates - Array of text strings to rank
   * @param topN - Number of top results to return
   * @returns Array of RerankResult sorted by relevance (most relevant first)
   */
  rerank(query: string, candidates: string[], topN: number): Promise<RerankResult[]>;
}
