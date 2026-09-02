/**
 * Document Repository
 * 
 * Data access layer for document chunks, providing bulk inserts
 * and vector search with parent-child retrieval support.
 * 
 * For child summary chunks, the search returns `parentContent`
 * (the full raw table/image) for LLM grounding while matching
 * against the shorter, vectorized summary.
 * 
 * @module infrastructure/database/document-repository
 */

import { getDatabase } from './mongodb-client';
import { UnifiedNode, DocumentNode } from './types';
import { DocumentSearchResult } from '@/core/types';
import { ObjectId } from 'mongodb';
import {
  UNIFIED_NODES_COLLECTION,
  UNIFIED_VECTOR_INDEX,
  VECTOR_FIELD_PATH,
  VECTOR_NUM_CANDIDATES,
  DOCUMENT_SEARCH_LIMIT,
} from '@/config/constants';
import { createLogger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { Document } from 'mongodb';

const log = createLogger('DocumentRepository');

/**
 * Safely inserts a batch of document chunks into the database.
 * Supports both regular text chunks and parent-child chunks.
 * 
 * @param chunks - Array of DocumentChunk objects to insert
 * @throws {DatabaseError} If the bulk insert operation fails
 */
export type InsertDocumentChunk = Omit<DocumentNode, '_id' | 'type'> & { _id?: ObjectId };

export async function bulkInsertChunks(chunks: InsertDocumentChunk[]): Promise<void> {
  if (!chunks.length) return;

  try {
    const db = await getDatabase();
    const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);
    
    log.info('Bulk inserting document chunks', {
      count: chunks.length,
      childSummaries: chunks.filter(c => c.metadata.isChildSummary).length,
      tables: chunks.filter(c => c.chunkType === 'table').length,
    });

    const documentsToInsert: DocumentNode[] = chunks.map(chunk => ({
      ...chunk,
      _id: chunk._id || new ObjectId(),
      type: 'document'
    }));
    
    await collection.insertMany(documentsToInsert, { ordered: false });
    
    log.info('Successfully inserted document chunks', { count: chunks.length });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Bulk insert failed', { error: err.message });
    throw new DatabaseError(`Failed to insert document chunks: ${err.message}`, err);
  }
}

/**
 * Performs a vector similarity search on the document chunks collection.
 * 
 * Returns chunks ranked by similarity. For child summary chunks,
 * includes the `parentContent` field containing the full raw content.
 * 
 * @param queryEmbedding - The embedding vector of the user's query
 * @param limit - Maximum number of results to return
 * @returns Array of document chunks ranked by similarity score
 * 
 * @throws {DatabaseError} If the aggregation pipeline fails
 */
export async function searchDocumentChunks(
  queryEmbedding: number[],
  limit: number = DOCUMENT_SEARCH_LIMIT
): Promise<DocumentSearchResult[]> {
  try {
    const db = await getDatabase();
    const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);

    log.info('Executing document vector search', {
      embeddingLength: queryEmbedding.length,
      limit,
    });

    const pipeline: Document[] = [
      {
        $vectorSearch: {
          index: UNIFIED_VECTOR_INDEX,
          path: VECTOR_FIELD_PATH,
          queryVector: queryEmbedding,
          numCandidates: VECTOR_NUM_CANDIDATES,
          limit,
          filter: { type: 'document' },
        },
      },
      {
        $project: {
          _id: 1,
          text: 1,
          parentContent: 1,
          chunkType: 1,
          headingPath: 1,
          metadata: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    const fetchPromise = collection.aggregate<any>(pipeline).toArray();

    const timeoutPromise = new Promise<any[]>((_, reject) => {
      setTimeout(() => reject(new Error('Database query timed out after 4000ms')), 4000);
    });

    let results: any[];
    try {
      results = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.warn('Document vector search circuit breaker tripped', { error: err.message });
      return [];
    }

    const mappedResults: DocumentSearchResult[] = results.map(doc => {
      return {
        id: doc._id.toString(),
        text: doc.text,
        parentContent: doc.parentContent,
        chunkType: doc.chunkType,
        headingPath: doc.headingPath,
        metadata: doc.metadata,
        score: doc.score,
      };
    });

    log.info('Document vector search completed', {
      resultCount: mappedResults.length,
      topScore: mappedResults[0]?.score ?? 0,
      parentChildResults: mappedResults.filter(r => r.metadata?.isChildSummary).length,
    });

    return mappedResults;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Document vector search failed', { error: err.message });
    throw new DatabaseError(`Document vector search failed: ${err.message}`, err);
  }
}

/**
 * Deletes document chunks associated with specific filenames.
 * Used for cleanup of incomplete or failed ingestion jobs.
 * 
 * @param filenames - Array of original filenames to match against `metadata.filename`
 */
export async function deleteDocumentsByFilenames(filenames: string[]): Promise<void> {
  if (!filenames.length) return;
  try {
    const db = await getDatabase();
    const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);
    
    log.info('Deleting documents by filenames', { count: filenames.length });
    const result = await collection.deleteMany({ 
      type: 'document',
      'metadata.filename': { $in: filenames } 
    });
    
    log.debug('Documents deleted successfully', { deletedCount: result.deletedCount });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to delete documents by filenames', { error: err.message });
    throw new DatabaseError(`Failed to delete documents: ${err.message}`, err);
  }
}
