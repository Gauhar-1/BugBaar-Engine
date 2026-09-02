/**
 * IEmbeddingProvider Interface
 *
 * Abstraction over any embedding model (OpenAI, NVIDIA NIM,
 * Cohere, etc.). Decouples business logic from provider SDKs.
 *
 * @module interfaces/IEmbeddingProvider
 */

export interface IEmbeddingProvider {
  /**
   * Generates a single embedding vector for the given text.
   *
   * @param text - Input text to embed
   * @param inputType - Semantic hint: 'query' for user queries, 'passage' for documents
   * @returns Embedding vector as a number array
   */
  embed(text: string, inputType?: 'query' | 'passage'): Promise<number[]>;

  /**
   * Generates embeddings for multiple texts in a single or batched API call.
   *
   * @param texts - Array of input texts
   * @param inputType - Semantic hint applied to all texts in the batch
   * @returns Array of embedding vectors, order-preserved
   */
  embedBatch(texts: string[], inputType?: 'query' | 'passage'): Promise<number[][]>;
}
