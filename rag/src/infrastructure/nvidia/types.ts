/**
 * Nvidia NIM API Types
 * 
 * Type definitions for Nvidia NIM API requests and responses.
 * 
 * @module infrastructure/nvidia/types
 */

/**
 * Embedding input type — determines how the model treats the input.
 * - 'query': For user search queries (optimized for retrieval)
 * - 'passage': For documents being indexed (optimized for storage)
 */
export type EmbeddingInputType = 'query' | 'passage';

/**
 * Request body for the Nvidia embeddings endpoint.
 */
export interface EmbeddingRequest {
  input: string | string[];
  model: string;
  input_type: EmbeddingInputType;
  encoding_format?: 'float' | 'base64';
  truncate?: 'NONE' | 'START' | 'END';
}

/**
 * Individual embedding result from the API response.
 */
export interface EmbeddingData {
  object: 'embedding';
  index: number;
  embedding: number[];
}

/**
 * Full response from the Nvidia embeddings endpoint.
 */
export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
