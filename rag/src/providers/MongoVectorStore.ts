/**
 * MongoVectorStore
 *
 * Implements IVectorStore over MongoDB Atlas, providing:
 * - Dense $vectorSearch (ANN cosine similarity)
 * - Lexical $search (BM25 text search)
 * - Bulk insert via insertMany
 *
 * RRF merge logic lives in HybridRetrievalService, not here.
 *
 * @module providers/MongoVectorStore
 */

import { Db, Document } from 'mongodb';
import { IVectorStore } from '@/interfaces/IVectorStore';
import { SearchResult, VectorDocument } from '@/types';
import {
  UNIFIED_NODES_COLLECTION,
  UNIFIED_VECTOR_INDEX,
  VECTOR_FIELD_PATH,
  VECTOR_NUM_CANDIDATES,
} from '@/config/constants';
import { createLogger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';

const log = createLogger('MongoVectorStore');

export class MongoVectorStore implements IVectorStore {
  constructor(private readonly getDb: () => Promise<Db>) {}

  /**
   * Executes an ANN vector similarity search using MongoDB Atlas $vectorSearch.
   */
  async vectorSearch(
    embedding: number[],
    limit: number,
    filter: Record<string, unknown> = {}
  ): Promise<SearchResult[]> {
    try {
      const db = await this.getDb();
      const collection = db.collection(UNIFIED_NODES_COLLECTION);

      log.info('Executing vector search', { limit, filter });

      const pipeline: Document[] = [
        {
          $vectorSearch: {
            index: UNIFIED_VECTOR_INDEX,
            path: VECTOR_FIELD_PATH,
            queryVector: embedding,
            numCandidates: VECTOR_NUM_CANDIDATES,
            limit: limit * 2, // over-fetch for RRF merge upstream
            filter,
          },
        },
        {
          $project: {
            _id: 1,
            type: 1,
            score: { $meta: 'vectorSearchScore' },
            // All other fields for downstream mapping
            name: 1, description: 1, category: 1, subcategory: 1, brand: 1,
            price: 1, currency: 1, colors: 1, sizes: 1, material: 1, gender: 1,
            imageUrl: 1, inStock: 1, rating: 1, reviewCount: 1, sku: 1, tags: 1,
            text: 1, parentContent: 1, chunkType: 1, headingPath: 1, metadata: 1,
          },
        },
      ];

      const results = await collection.aggregate<any>(pipeline).toArray();

      log.info('Vector search completed', { resultCount: results.length });

      return results.map((doc) => ({
        id: doc._id.toString(),
        score: doc.score ?? 0,
        type: doc.type as 'product' | 'document',
        payload: doc,
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Vector search failed', { error: err.message });
      throw new DatabaseError(`Vector search failed: ${err.message}`, err);
    }
  }

  /**
   * Executes a BM25 lexical text search using MongoDB Atlas $search.
   */
  async textSearch(
    query: string,
    fields: string[],
    limit: number,
    filter: Record<string, unknown> = {}
  ): Promise<SearchResult[]> {
    try {
      const db = await this.getDb();
      const collection = db.collection(UNIFIED_NODES_COLLECTION);

      log.info('Executing text search', { query, fields, limit });

      const pipeline: Document[] = [
        {
          $search: {
            index: 'product_text_index',
            text: {
              query,
              path: fields,
              fuzzy: { maxEdits: 1 },
            },
          },
        },
        { $match: filter },
        { $limit: limit * 2 },
        {
          $project: {
            _id: 1,
            type: 1,
            score: { $meta: 'searchScore' },
            name: 1, description: 1, category: 1, subcategory: 1, brand: 1,
            price: 1, currency: 1, colors: 1, sizes: 1, material: 1, gender: 1,
            imageUrl: 1, inStock: 1, rating: 1, reviewCount: 1, sku: 1, tags: 1,
            text: 1, parentContent: 1, chunkType: 1, headingPath: 1, metadata: 1,
          },
        },
      ];

      const results = await collection.aggregate<any>(pipeline).toArray();

      log.info('Text search completed', { resultCount: results.length });

      return results.map((doc) => ({
        id: doc._id.toString(),
        score: doc.score ?? 0,
        type: doc.type as 'product' | 'document',
        payload: doc,
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Text search failed', { error: err.message });
      throw new DatabaseError(`Text search failed: ${err.message}`, err);
    }
  }

  /**
   * Bulk-inserts an array of vectorized documents into the unified collection.
   */
  async bulkInsert(items: VectorDocument[]): Promise<void> {
    if (!items.length) return;

    try {
      const db = await this.getDb();
      const collection = db.collection(UNIFIED_NODES_COLLECTION);

      log.info('Bulk inserting documents', { count: items.length });

      await collection.insertMany(items as Document[], { ordered: false });

      log.info('Bulk insert completed', { count: items.length });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Bulk insert failed', { error: err.message });
      throw new DatabaseError(`Bulk insert failed: ${err.message}`, err);
    }
  }

  /**
   * Checks if any documents match the given filter.
   */
  async hasDocuments(filter: Record<string, unknown>): Promise<boolean> {
    try {
      const db = await this.getDb();
      const collection = db.collection(UNIFIED_NODES_COLLECTION);
      const result = await collection.findOne(filter, { projection: { _id: 1 } });
      return result !== null;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('hasDocuments check failed', { error: err.message });
      return false; // Safely fail open or closed depending on preference; returning false prevents search
    }
  }
}
