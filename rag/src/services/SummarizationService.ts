/**
 * SummarizationService
 *
 * Generates concise summaries for complex document chunks (tables, image descriptions).
 * Uses dependency injection to receive a specific summarization provider.
 *
 * @module services/SummarizationService
 */

import { ISummarizationProvider } from '@/interfaces/ISummarizationProvider';
import { getEnvConfig } from '@/config/env';
import { NvidiaSummarizationProvider } from '@/providers/NvidiaSummarizationProvider';
import { OpenAISummarizationProvider } from '@/providers/OpenAISummarizationProvider';
import { createLogger } from '@/lib/logger';

const log = createLogger('SummarizationService');

export class SummarizationService {
  constructor(private readonly provider: ISummarizationProvider) {}

  async generateChunkSummary(
    content: string,
    chunkType: 'table' | 'image_description'
  ): Promise<string> {
    return this.provider.generateChunkSummary(content, chunkType);
  }
}

/**
 * Factory function to select the correct provider based on EMBEDDING_PROVIDER
 */
export function getSummarizationProvider(): ISummarizationProvider {
  const provider = getEnvConfig().EMBEDDING_PROVIDER?.toLowerCase();

  switch (provider) {
    case 'nvidia':
      log.info('Selected NVIDIA as Summarization Provider');
      return new NvidiaSummarizationProvider();
    case 'openai':
      log.info('Selected OpenAI as Summarization Provider');
      return new OpenAISummarizationProvider();
    default:
      log.warn(`Unknown provider '${provider}', defaulting to OpenAI`);
      return new OpenAISummarizationProvider();
  }
}
