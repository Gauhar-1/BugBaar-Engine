import { getOpenAiApiKey, getOpenAiSummarizationModel } from '@/config/env';
import { ISummarizationProvider } from '@/interfaces/ISummarizationProvider';
import { createLogger } from '@/lib/logger';
import OpenAI from 'openai';

const log = createLogger('OpenAISummarizationProvider');

export class OpenAISummarizationProvider implements ISummarizationProvider {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: getOpenAiApiKey() });
  }

  async generateChunkSummary(
    content: string,
    chunkType: 'table' | 'image_description'
  ): Promise<string> {
    log.info('Generating chunk summary with OpenAI', { chunkType, contentLength: content.length });

    const prompt = this.buildPrompt(content, chunkType);

    try {
      const response = await this.openai.chat.completions.create({
        model: getOpenAiSummarizationModel(),
        messages: [
          {
            role: 'system',
            content:
              'You are a precise document summarizer. Generate concise, searchable summaries. Focus on key information that a user might search for.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 200,
      });

      const summary = response.choices[0]?.message?.content?.trim();

      if (!summary) {
        log.warn('Empty summary returned — using fallback');
        return this.createFallback(content, chunkType);
      }

      log.debug('Summary generated', { summaryLength: summary.length });
      return summary;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Summarization failed — using fallback', { error: err.message });
      return this.createFallback(content, chunkType);
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private buildPrompt(content: string, chunkType: 'table' | 'image_description'): string {
    if (chunkType === 'table') {
      return `Summarize the following Markdown table in 1-3 sentences. Describe what the table contains, its key columns, and notable data points.\n\nTABLE:\n${content}\n\nSUMMARY:`;
    }
    return `Summarize the following image description in 1-2 sentences. Focus on what the image depicts.\n\nIMAGE DESCRIPTION:\n${content}\n\nSUMMARY:`;
  }

  private createFallback(content: string, chunkType: 'table' | 'image_description'): string {
    const prefix = chunkType === 'table' ? 'Table containing:' : 'Image:';
    const firstLine = content.split('\n').find((l) => l.trim().length > 0) || content;
    const truncated = firstLine.slice(0, 150).trim();
    return `${prefix} ${truncated}${firstLine.length > 150 ? '...' : ''}`;
  }
}
