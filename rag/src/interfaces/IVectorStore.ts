/**
 * IVectorStore Interface
 *
 * Abstraction over any vector database backend (MongoDB Atlas,
 * Pinecone, Qdrant, etc.). Implementations must support both
 * dense vector search and BM25 lexical search.
 *
 * @module interfaces/IVectorStore
 */

import { SearchResult, VectorDocument } from '@/types';

export interface IVectorStore {
  /**
   * Performs ANN dense vector similarity search.
   *
   * @param embedding - Query embedding vector
   * @param limit - Max results to return
   * @param filter - Optional pre-filter conditions (e.g., { type: 'product' })
   */
  vectorSearch(
    embedding: number[],
    limit: number,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]>;

  /**
   * Performs BM25 lexical (text) search over specified fields.
   *
   * @param query - Raw query text
   * @param fields - Field names to search over
   * @param limit - Max results to return
   * @param filter - Optional post-filter conditions
   */
  textSearch(
    query: string,
    fields: string[],
    limit: number,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]>;

  /**
   * Bulk-inserts vectorized documents into the store.
   *
   * @param items - Array of documents with embeddings
   */
  bulkInsert(items: VectorDocument[]): Promise<void>;

  /**
   * Checks if any documents match the given filter.
   * 
   * @param filter - Filter conditions (e.g., { type: 'product' })
   * @returns true if at least one document matches
   */
  hasDocuments(filter: Record<string, unknown>): Promise<boolean>;
}
