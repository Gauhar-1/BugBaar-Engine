/**
 * ISummarizationProvider Interface
 *
 * Abstraction over LLM-based summarization for document ingestion.
 * Used exclusively by the Ingestion Worker to generate contextual
 * descriptions for complex structures like tables or images, improving
 * retrieval accuracy.
 *
 * @module interfaces/ISummarizationProvider
 */
export interface ISummarizationProvider {
  /**
   * Generates a concise summary description for a specific document chunk.
   *
   * @param content - The raw content to summarize (e.g., markdown table or raw text)
   * @param chunkType - The semantic type of the chunk to guide the LLM's prompt
   * @returns A Promise resolving to the generated summary string. If generation fails or returns empty, implementations should invoke a fallback strategy.
   */
  generateChunkSummary(
    content: string,
    chunkType: 'table' | 'image_description'
  ): Promise<string>;
}