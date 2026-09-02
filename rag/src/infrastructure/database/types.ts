/**
 * MongoDB Database Types
 * 
 * Type definitions specific to the MongoDB data layer,
 * including document schemas, filter types, and the new
 * parent-child chunking schema and user memory types.
 * 
 * @module infrastructure/database/types
 */

import { ObjectId } from 'mongodb';

import { Product, DocumentSearchResult, UserMemory } from '@/core/types';

// ─── Unified Node Types ─────────────────────────────────────────────────────

export type BaseUnifiedNode = {
  _id: ObjectId;
  embedding: number[]; // 2048-dimensional
};

export type ProductNode = BaseUnifiedNode & { type: 'product' } & Omit<Product, 'id'>;
export type DocumentNode = BaseUnifiedNode & { type: 'document' } & Omit<DocumentSearchResult, 'id' | 'score'>;
export type MemoryNode = BaseUnifiedNode & { type: 'memory' } & UserMemory;

export type UnifiedNode = ProductNode | DocumentNode | MemoryNode;

// Search Results (extending nodes with score)
export type ProductSearchDocument = ProductNode & { score: number };
export type DocumentSearchChunk = DocumentNode & { score: number };
export type UserMemorySearchResult = MemoryNode & { score: number };

// Filters
export interface ProductFilter {
  category?: string;
  subcategory?: string;
  gender?: 'men' | 'women' | 'unisex';
  minPrice?: number;
  maxPrice?: number;
  brand?: string;
  inStock?: boolean;
}

// ─── Chat History Types ─────────────────────────────────────────────────────

/**
 * A single message stored in the chat_history collection.
 */
export interface ChatHistoryMessage {
  _id: ObjectId;
  /** Supabase-verified user ID — set server-side, never trusted from client */
  userId: string;
  /** Per-conversation thread UUID — scoped under userId for isolation */
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}
