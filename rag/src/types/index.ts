/**
 * Domain Types — Single Source of Truth
 *
 * All shared TypeScript interfaces for the RAG pipeline domain model.
 * Infrastructure-agnostic and framework-agnostic.
 *
 * @module types/index
 */

// ─── Chat Message Types ──────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

// ─── Product Domain Types ────────────────────────────────────────────────────

export interface Product {
  id: string;
  sku?: string;
  name: string;
  description: string;
  category: string;
  subcategory: string;
  brand: string;
  price: number;
  currency: string;
  colors: string[];
  sizes: string[];
  material: string;
  gender: 'men' | 'women' | 'unisex';
  imageUrl: string;
  inStock: boolean;
  rating: number;
  reviewCount: number;
  tags: string[];
}

export interface ProductSearchResult extends Product {
  /** Combined RRF score (vector + lexical fusion) */
  score: number;
}

// ─── Document Search Types ───────────────────────────────────────────────────

export interface DocumentSearchResult {
  id: string;
  /** Vectorized content (summary for child chunks, full text otherwise) */
  text: string;
  /** Full raw Markdown for parent-child chunks */
  parentContent?: string;
  chunkType: string;
  headingPath: string[];
  score: number;
  metadata: {
    filename: string;
    chunkId: number;
    hasTable: boolean;
    hasImage: boolean;
    isChildSummary: boolean;
  };
}

// ─── Generic Vector Store Result ─────────────────────────────────────────────

/** Unified result type returned by IVectorStore implementations */
export interface SearchResult {
  id: string;
  score: number;
  type: 'product' | 'document';
  /** Raw MongoDB document fields */
  payload: Record<string, unknown>;
}

/** Document format expected by IVectorStore.bulkInsert() */
export interface VectorDocument {
  type: 'product' | 'document';
  embedding: number[];
  [key: string]: unknown;
}

// ─── Reranker Types ──────────────────────────────────────────────────────────

export interface RerankResult {
  /** Original index in the candidates array */
  index: number;
  /** Relevance score assigned by the reranker */
  relevanceScore: number;
}

// ─── Security Guardrail Types ─────────────────────────────────────────────────

export interface ValidationResult {
  safe: boolean;
  reason?: string;
}

// ─── User Memory Types ───────────────────────────────────────────────────────

export interface UserMemory {
  userId: string;
  summary: string;
  lastUpdated: Date;
}

// ─── RAG Pipeline Types ──────────────────────────────────────────────────────

/** Retrieved context object passed between pipeline stages */
export interface RetrievedContext {
  products: ProductSearchResult[];
  documents: DocumentSearchResult[];
  userMemory: string | null;
}

/** Full internal context object after pipeline execution */
export interface RAGContext {
  userQuery: string;
  queryEmbedding: number[];
  retrievedProducts: ProductSearchResult[];
  retrievedDocuments: DocumentSearchResult[];
  userMemory: string | null;
  systemPrompt: string;
}

// ─── Express API Request / Response Types ────────────────────────────────────

export interface IngestRequest {
  /** Original filename (auto-extracted from multipart metadata) */
  filename?: string;
}

export interface RetrieveRequest {
  /** User query string */
  query: string;
  /** Optional pre-filters for product vector search */
  filters?: {
    category?: string;
    subcategory?: string;
    gender?: 'men' | 'women' | 'unisex';
    brand?: string;
    inStock?: boolean;
    minPrice?: number;
    maxPrice?: number;
  };
  /** Max items to return — defaults to VECTOR_SEARCH_LIMIT */
  limit?: number;
}

export interface RetrieveResponse {
  products: ProductSearchResult[];
  documents: DocumentSearchResult[];
  queryEmbeddingDimensions: number;
  durationMs: number;
}

export interface ChatRequest {
  /** Full conversation history including current user message at end */
  messages: Message[];
  /** Per-conversation thread UUID for session isolation */
  threadId?: string;
  /** Authenticated user ID (injected server-side, never from client) */
  userId?: string;
}

export interface ChatResponse {
  answer: string;
  context: {
    retrievedProducts: ProductSearchResult[];
    retrievedDocuments: DocumentSearchResult[];
    hasUserMemory: boolean;
    totalResults: number;
  };
  durationMs: number;
}

// ─── Ingestion Types ─────────────────────────────────────────────────────────

export interface IngestionResult {
  filename: string;
  chunksProcessed: number;
  tokensEstimated: number;
}

// ─── Data Seeding Types ──────────────────────────────────────────────────────

export interface ProductSeedData {
  sku?: string;
  name: string;
  description: string;
  category: string;
  subcategory: string;
  brand: string;
  price: number;
  currency: string;
  colors: string[];
  sizes: string[];
  material: string;
  gender: 'men' | 'women' | 'unisex';
  imageUrl: string;
  inStock: boolean;
  rating: number;
  reviewCount: number;
  tags: string[];
}
