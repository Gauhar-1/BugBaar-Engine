/**
 * Product Repository
 * 
 * Data access layer for product documents, providing vector search
 * and standard CRUD operations via MongoDB Atlas.
 * 
 * @module infrastructure/database/product-repository
 */

import { getDatabase } from './mongodb-client';
import { UnifiedNode, ProductFilter } from './types';
import { Product, ProductSearchResult } from '@/core/types';
import {
  UNIFIED_NODES_COLLECTION,
  UNIFIED_VECTOR_INDEX,
  VECTOR_FIELD_PATH,
  VECTOR_NUM_CANDIDATES,
  VECTOR_SEARCH_LIMIT,
} from '@/config/constants';
import { createLogger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { Document } from 'mongodb';

const log = createLogger('ProductRepository');

/**
 * Performs a hybrid search on the products collection combining vector similarity
 * and lexical text search using MongoDB Atlas, merged via Reciprocal Rank Fusion.
 * 
 * @param queryText - The user's original search query text
 * @param queryEmbedding - The embedding vector of the user's query
 * @param limit - Maximum number of results to return (default: 10)
 * @param filter - Optional pre-filter criteria to narrow search space
 * @returns Array of products ranked by RRF combined score
 * 
 * @throws {DatabaseError} If the aggregation pipeline fails
 */
export async function hybridSearch(
  queryText: string,
  queryEmbedding: number[],
  limit: number = VECTOR_SEARCH_LIMIT,
  filter?: ProductFilter
): Promise<ProductSearchResult[]> {
  try {
    const db = await getDatabase();
    const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);

    log.info('Executing hybrid search', {
      queryText,
      embeddingLength: queryEmbedding.length,
      limit,
      hasFilter: !!filter,
    });

    const filterConditions = filter ? buildFilterConditions(filter) : {};
    filterConditions.type = 'product';

    // Build the $vectorSearch stage
    const vectorSearchStage: Document = {
      $vectorSearch: {
        index: UNIFIED_VECTOR_INDEX,
        path: VECTOR_FIELD_PATH,
        queryVector: queryEmbedding,
        numCandidates: VECTOR_NUM_CANDIDATES,
        limit: limit * 2, // over-fetch for RRF
        filter: filterConditions,
      },
    };

    // Build the $search stage for lexical match
    const lexicalSearchStage: Document = {
      $search: {
        index: 'product_text_index', // Assuming inverted text index name
        text: {
          query: queryText,
          path: ['name', 'brand', 'category', 'subcategory', 'tags'],
          fuzzy: { maxEdits: 1 },
        }
      }
    };

    const commonProjectStage = {
      $project: {
        _id: 1,
        name: 1,
        description: 1,
        category: 1,
        subcategory: 1,
        brand: 1,
        price: 1,
        currency: 1,
        colors: 1,
        sizes: 1,
        material: 1,
        gender: 1,
        imageUrl: 1,
        inStock: 1,
        rating: 1,
        reviewCount: 1,
        sku: 1,
        tags: 1,
        score: { $meta: 'searchScore' }, // lexical sets searchScore
        vectorScore: { $meta: 'vectorSearchScore' }, // vector sets vectorSearchScore
      },
    };

    const vectorPipeline: Document[] = [
      vectorSearchStage,
      commonProjectStage,
    ];

    const lexicalPipeline: Document[] = [
      lexicalSearchStage,
      { $match: filterConditions },
      { $limit: limit * 2 },
      commonProjectStage,
    ];

    // Execute both in parallel with a 4000ms circuit breaker timeout
    const fetchPromise = Promise.all([
      collection.aggregate<any>(vectorPipeline).toArray(),
      collection.aggregate<any>(lexicalPipeline).toArray()
    ]);

    const timeoutPromise = new Promise<[any[], any[]]>((_, reject) => {
      setTimeout(() => reject(new Error('Database query timed out after 4000ms')), 4000);
    });

    let vectorResults: any[];
    let lexicalResults: any[];

    try {
      [vectorResults, lexicalResults] = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.warn('Hybrid search circuit breaker tripped', { error: err.message, queryText });
      return [];
    }

    // Apply Reciprocal Rank Fusion (RRF)
    const rrfMap = new Map<string, any>();
    const RRF_CONSTANT = 60;

    // Score vector results
    vectorResults.forEach((doc, rank) => {
      const id = doc._id.toString();
      const score = 1 / (RRF_CONSTANT + rank + 1);
      rrfMap.set(id, { ...doc, score, rrfScore: score });
    });

    // Score lexical results and merge
    lexicalResults.forEach((doc, rank) => {
      const id = doc._id.toString();
      const score = 1 / (RRF_CONSTANT + rank + 1);
      if (rrfMap.has(id)) {
        const existing = rrfMap.get(id);
        existing.rrfScore += score;
        existing.score = existing.rrfScore; // Store combined score in standard score field
      } else {
        rrfMap.set(id, { ...doc, score, rrfScore: score });
      }
    });

    // Sort by combined RRF score descending and limit
    const mergedResults = Array.from(rrfMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit)
      .map(doc => {
        const { _id, score } = doc;
        return {
          id: _id.toString(),
          name: doc.name,
          description: doc.description,
          category: doc.category,
          subcategory: doc.subcategory,
          brand: doc.brand,
          price: doc.price,
          currency: doc.currency,
          colors: doc.colors,
          sizes: doc.sizes,
          material: doc.material,
          gender: doc.gender,
          imageUrl: doc.imageUrl,
          inStock: doc.inStock,
          rating: doc.rating,
          reviewCount: doc.reviewCount,
          sku: doc.sku,
          tags: doc.tags,
          score
        } as ProductSearchResult;
      });

    log.info('Hybrid search completed', {
      mergedResultCount: mergedResults.length,
      topScore: mergedResults[0]?.score ?? 0,
    });

    return mergedResults;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Hybrid search failed', { error: err.message });
    throw new DatabaseError(`Hybrid search failed: ${err.message}`, err);
  }
}

/**
 * Retrieves a single product by its string ID.
 * 
 * @param id - The product's MongoDB ObjectId as a string
 * @returns The product document or null if not found
 */
export async function getProductById(
  id: string
): Promise<Product | null> {
  try {
    const { ObjectId } = await import('mongodb');
    const db = await getDatabase();
    const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);
    const doc = await collection.findOne({ _id: new ObjectId(id), type: 'product' });
    if (!doc) return null;
    const { _id, type, embedding, ...rest } = doc;
    return { id: _id.toString(), ...rest } as Product;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to fetch product by ID', { id, error: err.message });
    throw new DatabaseError(`Failed to fetch product: ${err.message}`, err);
  }
}

/**
 * Returns the total count of products in the collection.
 */
export async function getProductCount(): Promise<number> {
  const db = await getDatabase();
  const collection = db.collection<UnifiedNode>(UNIFIED_NODES_COLLECTION);
  return collection.countDocuments({ type: 'product' });
}

// ─── Private Helpers ────────────────────────────────────────────────────────

/**
 * Constructs a MongoDB filter document from a ProductFilter.
 * Used for pre-filtering in $vectorSearch.
 */
function buildFilterConditions(filter: ProductFilter): Document {
  const conditions: Document = {};

  if (filter.category) conditions.category = filter.category;
  if (filter.subcategory) conditions.subcategory = filter.subcategory;
  if (filter.gender) conditions.gender = filter.gender;
  if (filter.brand) conditions.brand = filter.brand;
  if (filter.inStock !== undefined) conditions.inStock = filter.inStock;

  if (filter.minPrice !== undefined || filter.maxPrice !== undefined) {
    conditions.price = {};
    if (filter.minPrice !== undefined) conditions.price.$gte = filter.minPrice;
    if (filter.maxPrice !== undefined) conditions.price.$lte = filter.maxPrice;
  }

  return conditions;
}
