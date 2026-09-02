/**
 * Semantic Cache Repository (MongoDB Atlas Vector Search)
 *
 * Provides a vector-similarity cache layer for the chat API route.
 * Checks for semantically similar past queries whose answers can be replayed.
 *
 * Secondary verification uses a lightweight LLM call (direct fetch) to confirm
 * semantic equivalence — replaces the Vercel AI SDK generateText call.
 *
 * @module infrastructure/database/cache-repository
 */

import { getDatabase } from './mongodb-client';
import { getNvidiaApiKey, getNvidiaBaseUrl, getNvidiaSummarizationModel } from '@/config/env';
import {
  SEMANTIC_CACHE_COLLECTION,
  SEMANTIC_CACHE_VECTOR_INDEX,
  SEMANTIC_CACHE_HIT_THRESHOLD,
  VECTOR_FIELD_PATH,
  VECTOR_NUM_CANDIDATES,
} from '@/config/constants';
import { createLogger } from '@/lib/logger';
import { Document } from 'mongodb';

const log = createLogger('SemanticCache');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SemanticCacheDocument {
  queryText: string;
  embedding: number[];
  answerText: string;
  createdAt: Date;
}

export interface CacheHit {
  hit: true;
  answer: string;
  score: number;
}

export interface CacheMiss {
  hit: false;
}

export type CacheResult = CacheHit | CacheMiss;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Checks the semantic cache for a query with sufficient embedding similarity.
 * Falls back gracefully on any error (never breaks the main pipeline).
 */
export async function checkCache(queryText: string, queryEmbedding: number[]): Promise<CacheResult> {
  try {
    const db = await getDatabase();
    const collection = db.collection<SemanticCacheDocument>(SEMANTIC_CACHE_COLLECTION);

    const pipeline: Document[] = [
      {
        $vectorSearch: {
          index: SEMANTIC_CACHE_VECTOR_INDEX,
          path: VECTOR_FIELD_PATH,
          queryVector: queryEmbedding,
          numCandidates: VECTOR_NUM_CANDIDATES,
          limit: 1,
        },
      },
      {
        $project: {
          _id: 0,
          queryText: 1,
          answerText: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    const results = await collection
      .aggregate<{ queryText: string; answerText: string; score: number }>(pipeline)
      .toArray();

    if (results.length === 0) {
      log.debug('Semantic cache: no results returned');
      return { hit: false };
    }

    const top = results[0];

    log.info('Semantic cache query result', {
      score: top.score.toFixed(4),
      threshold: SEMANTIC_CACHE_HIT_THRESHOLD,
      isHit: top.score >= SEMANTIC_CACHE_HIT_THRESHOLD,
    });

    if (top.score >= SEMANTIC_CACHE_HIT_THRESHOLD && top.answerText) {
      // Secondary semantic verification via lightweight LLM
      const isVerified = await verifySemanticEquivalence(queryText, top.queryText);

      log.info('Secondary verification complete', { verified: isVerified });

      if (isVerified) {
        return { hit: true, answer: top.answerText, score: top.score };
      }

      log.debug('Semantic cache MISS — secondary verification rejected the candidate');
    }

    return { hit: false };
  } catch (error) {
    log.error('Semantic cache check failed', { error: (error as Error).message });
    return { hit: false };
  }
}

/**
 * Saves a query, embedding, and answer to the semantic cache.
 * Designed for fire-and-forget usage — catches all errors internally.
 */
export async function saveToCache(
  queryText: string,
  queryEmbedding: number[],
  answerText: string
): Promise<void> {
  try {
    const db = await getDatabase();
    const collection = db.collection<SemanticCacheDocument>(SEMANTIC_CACHE_COLLECTION);

    await collection.insertOne({
      queryText,
      embedding: queryEmbedding,
      answerText,
      createdAt: new Date(),
    });

    log.info('Semantic cache entry saved', {
      queryLength: queryText.length,
      answerLength: answerText.length,
    });
  } catch (error) {
    log.error('Semantic cache save failed', { error: (error as Error).message });
  }
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

/**
 * Uses a lightweight LLM call to verify two queries are semantically equivalent.
 * Direct fetch replaces the Vercel AI SDK generateText dependency.
 */
async function verifySemanticEquivalence(query1: string, query2: string): Promise<boolean> {
  try {
    const response = await fetch(`${getNvidiaBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getNvidiaApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getNvidiaSummarizationModel(),
        messages: [
          {
            role: 'user',
            content: `Do these two queries ask for the exact same underlying information? Answer strictly YES or NO.\nQuery 1: "${query1}"\nQuery 2: "${query2}"`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      }),
    });

    if (!response.ok) return false;

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim().toUpperCase() ?? '';
    return text.includes('YES');
  } catch {
    return false;
  }
}
