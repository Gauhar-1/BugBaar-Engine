/**
 * HybridRetrievalService
 *
 * Orchestrates the hybrid retrieval pipeline:
 * 1. Runs dense vector search and BM25 text search in PARALLEL (Promise.all)
 * 2. Merges results using Reciprocal Rank Fusion: score = 1 / (RRF_CONSTANT + rank)
 * 3. Invokes IReranker on the top RRF candidates
 * 4. Maps raw SearchResults back to typed ProductSearchResult / DocumentSearchResult
 *
 * @module services/HybridRetrievalService
 */

import { IVectorStore } from '@/interfaces/IVectorStore';
import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';
import { IReranker } from '@/interfaces/IReranker';
import {
  ProductSearchResult,
  DocumentSearchResult,
  SearchResult,
  RetrievedContext,
} from '@/types';
import {
  RRF_CONSTANT,
  RERANK_TOP_N,
  VECTOR_SEARCH_LIMIT,
  DOCUMENT_SEARCH_LIMIT,
} from '@/config/constants';
import { createLogger } from '@/lib/logger';

const log = createLogger('HybridRetrievalService');

export interface HybridRetrievalOptions {
  productLimit?: number;
  documentLimit?: number;
  productFilter?: Record<string, unknown>;
  includeDocuments?: boolean;
  includeProducts?: boolean;
}

export class HybridRetrievalService {
  constructor(
    private readonly vectorStore: IVectorStore,
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly reranker: IReranker
  ) {}

  /**
   * Runs the full hybrid retrieval pipeline:
   * parallel search → RRF merge → reranking → typed mapping.
   *
   * @param query - Raw user query text
   * @param queryEmbedding - Pre-computed embedding (avoids redundant API call)
   * @param options - Retrieval configuration
   */
  async retrieve(
    query: string,
    queryEmbedding: number[],
    options: HybridRetrievalOptions = {}
  ): Promise<RetrievedContext> {
    const {
      productLimit = VECTOR_SEARCH_LIMIT,
      documentLimit = DOCUMENT_SEARCH_LIMIT,
      productFilter = {},
      includeDocuments = true,
      includeProducts = true,
    } = options;

    const startTime = Date.now();
    log.info('Starting hybrid retrieval', { query: query.slice(0, 80), includeProducts, includeDocuments });

    // ── Stage 1: Fast Existence Checks ──────────────────────────────────────
    const [hasProducts, hasDocuments] = await Promise.all([
      includeProducts ? this.vectorStore.hasDocuments({ type: 'product' }) : Promise.resolve(false),
      includeDocuments ? this.vectorStore.hasDocuments({ type: 'document' }) : Promise.resolve(false),
    ]);

    // ── Stage 2: Parallel Retrieval ─────────────────────────────────────────
    const productVectorFilter = { ...productFilter, type: 'product' };
    const documentVectorFilter = { type: 'document' };
    const productTextFields = ['name', 'brand', 'category', 'subcategory', 'tags'];

    const [productVectorResults, productTextResults, documentVectorResults] = await Promise.all([
      hasProducts
        ? this.vectorStore.vectorSearch(queryEmbedding, productLimit, productVectorFilter).catch((e) => {
            log.error('Product vector search failed', { error: (e as Error).message });
            return [] as SearchResult[];
          })
        : Promise.resolve([] as SearchResult[]),

      hasProducts
        ? this.vectorStore.textSearch(query, productTextFields, productLimit, productVectorFilter).catch((e) => {
            log.error('Product text search failed', { error: (e as Error).message });
            return [] as SearchResult[];
          })
        : Promise.resolve([] as SearchResult[]),

      hasDocuments
        ? this.vectorStore.vectorSearch(queryEmbedding, documentLimit, documentVectorFilter).catch((e) => {
            log.error('Document vector search failed', { error: (e as Error).message });
            return [] as SearchResult[];
          })
        : Promise.resolve([] as SearchResult[]),
    ]);

    log.info('Parallel retrieval completed', {
      productVector: productVectorResults.length,
      productText: productTextResults.length,
      documentVector: documentVectorResults.length,
      durationMs: Date.now() - startTime,
    });

    // ── Stage 2: Reciprocal Rank Fusion (RRF) ───────────────────────────────
    const productRRF = this.applyRRF(productVectorResults, productTextResults, productLimit);
    const documentRRF = this.applyRRF(documentVectorResults, [], documentLimit);

    log.info('RRF merge completed', {
      productCandidates: productRRF.length,
      documentCandidates: documentRRF.length,
    });

    // ── Stage 3: Reranking ──────────────────────────────────────────────────
    const allCandidates = [
      ...productRRF.map((r) => ({ ...r, source: 'product' as const })),
      ...documentRRF.map((r) => ({ ...r, source: 'document' as const })),
    ];

    let rerankedProducts: ProductSearchResult[];
    let rerankedDocuments: DocumentSearchResult[];

    if (allCandidates.length > 0) {
      const candidateTexts = allCandidates.map((c) =>
        c.source === 'product'
          ? `${(c.payload as any).name ?? ''} - ${(c.payload as any).brand ?? ''}. ${(c.payload as any).description ?? ''}`
          : (c.payload as any).text ?? ''
      );

      const rerankResults = await this.reranker.rerank(query, candidateTexts, RERANK_TOP_N);

      rerankedProducts = rerankResults
        .filter((r) => allCandidates[r.index]?.source === 'product')
        .map((r) => this.mapToProductSearchResult(allCandidates[r.index]));

      rerankedDocuments = rerankResults
        .filter((r) => allCandidates[r.index]?.source === 'document')
        .map((r) => this.mapToDocumentSearchResult(allCandidates[r.index]));
    } else {
      rerankedProducts = productRRF.map((r) => this.mapToProductSearchResult(r));
      rerankedDocuments = documentRRF.map((r) => this.mapToDocumentSearchResult(r));
    }

    log.info('Hybrid retrieval pipeline completed', {
      products: rerankedProducts.length,
      documents: rerankedDocuments.length,
      totalDurationMs: Date.now() - startTime,
    });

    return {
      products: rerankedProducts,
      documents: rerankedDocuments,
      userMemory: null, // userMemory is injected by RAGPipelineService
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Applies Reciprocal Rank Fusion to merge two ranked lists.
   * Formula: score = 1 / (RRF_CONSTANT + rank)
   * Documents appearing in both lists get scores summed.
   */
  private applyRRF(
    listA: SearchResult[],
    listB: SearchResult[],
    limit: number
  ): SearchResult[] {
    const rrfMap = new Map<string, SearchResult & { rrfScore: number }>();

    const scoreList = (list: SearchResult[]) => {
      list.forEach((doc, rank) => {
        const score = 1 / (RRF_CONSTANT + rank + 1);
        const existing = rrfMap.get(doc.id);
        if (existing) {
          existing.rrfScore += score;
          existing.score = existing.rrfScore;
        } else {
          rrfMap.set(doc.id, { ...doc, rrfScore: score, score });
        }
      });
    };

    scoreList(listA);
    scoreList(listB);

    return Array.from(rrfMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit);
  }

  private mapToProductSearchResult(result: SearchResult): ProductSearchResult {
    const p = result.payload as any;
    return {
      id: result.id,
      score: result.score,
      sku: p.sku,
      name: p.name ?? '',
      description: p.description ?? '',
      category: p.category ?? '',
      subcategory: p.subcategory ?? '',
      brand: p.brand ?? '',
      price: p.price ?? 0,
      currency: p.currency ?? 'USD',
      colors: p.colors ?? [],
      sizes: p.sizes ?? [],
      material: p.material ?? '',
      gender: p.gender ?? 'unisex',
      imageUrl: p.imageUrl ?? '',
      inStock: p.inStock ?? false,
      rating: p.rating ?? 0,
      reviewCount: p.reviewCount ?? 0,
      tags: p.tags ?? [],
    };
  }

  private mapToDocumentSearchResult(result: SearchResult): DocumentSearchResult {
    const d = result.payload as any;
    return {
      id: result.id,
      score: result.score,
      text: d.text ?? '',
      parentContent: d.parentContent,
      chunkType: d.chunkType ?? 'text',
      headingPath: d.headingPath ?? [],
      metadata: d.metadata ?? {
        filename: 'unknown',
        chunkId: 0,
        hasTable: false,
        hasImage: false,
        isChildSummary: false,
      },
    };
  }
}
