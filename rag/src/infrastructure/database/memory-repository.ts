/**
 * Memory Repository
 * 
 * Data access layer for the user_memory_vectors collection.
 * Stores and retrieves vectorized user preference summaries
 * for long-term memory in the RAG pipeline.
 * 
 * @module infrastructure/database/memory-repository
 */

import { getDatabase } from './mongodb-client';
import { UnifiedNode, MemoryNode } from './types';
import { UserMemory } from '@/core/types';
import {
  UNIFIED_NODES_COLLECTION,
  UNIFIED_VECTOR_INDEX,
  VECTOR_FIELD_PATH,
  VECTOR_NUM_CANDIDATES,
  MEMORY_SEARCH_LIMIT,
} from '@/config/constants';
import { createLogger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { ObjectId, Document } from 'mongodb';

const log = createLogger('MemoryRepository');

/**
 * Upserts a user memory summary into the database.
 * If a memory for this user already exists, it is replaced.
 * 
 * @param userId - The Supabase-verified user ID
 * @param summary - Natural language summary of user traits
 * @param embedding - Vectorized embedding of the summary
 * @param messageCount - Number of messages analyzed
 */
export async function upsertUserMemory(
  userId: string,
  summary: string,
  embedding: number[],
  messageCount: number
): Promise<void> {
  try {
    const db = await getDatabase();
    const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);

    log.info('Upserting user memory', { userId, summaryLength: summary.length });

    await collection.updateOne(
      { userId, type: 'memory' },
      {
        $set: {
          summary,
          embedding,
          lastUpdated: new Date(),
        },
        $setOnInsert: {
          _id: new ObjectId(),
          type: 'memory',
        },
      },
      { upsert: true }
    );

    log.info('User memory upserted successfully', { userId });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to upsert user memory', { userId, error: err.message });
    throw new DatabaseError(`Failed to upsert user memory: ${err.message}`, err);
  }
}

/**
 * Performs a vector similarity search on user memory.
 * Filters by userId to only retrieve memories for the current user.
 * 
 * @param userId - The Supabase-verified user ID
 * @param queryEmbedding - The query embedding vector
 * @param limit - Maximum number of results
 * @returns Array of matching memory documents
 */
export async function searchUserMemory(
  userId: string,
  queryEmbedding: number[],
  limit: number = MEMORY_SEARCH_LIMIT
): Promise<UserMemory[]> {
  try {
    const db = await getDatabase();
    const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);

    log.info('Searching user memory', { userId, limit });

    const pipeline: Document[] = [
      {
        $vectorSearch: {
          index: UNIFIED_VECTOR_INDEX,
          path: VECTOR_FIELD_PATH,
          queryVector: queryEmbedding,
          numCandidates: VECTOR_NUM_CANDIDATES,
          limit,
          filter: { userId, type: 'memory' },
        },
      },
      {
        $project: {
          _id: 1,
          userId: 1,
          summary: 1,
          lastUpdated: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    const results = await collection.aggregate<any>(pipeline).toArray();

    const mappedResults: UserMemory[] = results.map(doc => ({
      userId: doc.userId,
      summary: doc.summary,
      lastUpdated: doc.lastUpdated,
    }));

    log.info('User memory search completed', {
      userId,
      resultCount: mappedResults.length,
      topScore: results[0]?.score ?? 0,
    });

    return mappedResults;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('User memory search failed', { userId, error: err.message });
    // Gracefully return empty — memory is non-critical
    return [];
  }
}

/**
 * Retrieves user memory by user ID (non-vector, exact match).
 * Used by the memory worker to check if memory already exists.
 * 
 * @param userId - The Supabase-verified user ID
 * @returns The memory document or null
 */
export async function getUserMemoryByUser(
  userId: string
): Promise<UserMemory | null> {
  try {
    const db = await getDatabase();
    const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);
    const doc = await collection.findOne({ userId, type: 'memory' }) as MemoryNode | null;
    if (!doc) return null;
    return {
      userId: doc.userId,
      summary: doc.summary,
      lastUpdated: doc.lastUpdated,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to fetch user memory', { userId, error: err.message });
    return null;
  }
}
