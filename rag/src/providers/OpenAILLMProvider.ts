/**
 * OpenAILLMProvider
 *
 * Implements ILLMProvider using the official OpenAI SDK.
 * Provides both standard JSON completion (generate) and
 * token-by-token async-iterable streaming (generateStream).
 *
 * @module providers/OpenAILLMProvider
 */

import OpenAI from 'openai';
import { ILLMProvider } from '@/interfaces/ILLMProvider';
import { Message } from '@/types';
import { getOpenAiApiKey, getOpenAiChatModel } from '@/config/env';
import { CHAT_TEMPERATURE, CHAT_TOP_P, MAX_COMPLETION_TOKENS } from '@/config/constants';
import { createLogger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

const log = createLogger('OpenAILLMProvider');

export class OpenAILLMProvider implements ILLMProvider {
  private client: OpenAI;
  private model: string;

  constructor() {
    this.client = new OpenAI({ apiKey: getOpenAiApiKey() });
    this.model = getOpenAiChatModel();
    log.info('OpenAI LLM provider initialized', { model: this.model });
  }

  /**
   * Generates a complete response in a single blocking API call.
   */
  async generate(systemPrompt: string, messages: Message[], options?: { maxTokens?: number }): Promise<string> {
    log.info('Generating LLM completion', { model: this.model, messageCount: messages.length });

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        ],
        temperature: CHAT_TEMPERATURE,
        top_p: CHAT_TOP_P,
        max_tokens: options?.maxTokens ?? MAX_COMPLETION_TOKENS,
        stream: false,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new AppError('OpenAI returned empty completion', 'LLM_EMPTY_RESPONSE', 502);
      }

      log.info('LLM completion generated', {
        tokens: response.usage?.total_tokens,
        finishReason: response.choices[0]?.finish_reason,
      });

      return content;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('LLM generation failed', { error: err.message });
      throw new AppError(`LLM generation failed: ${err.message}`, 'LLM_ERROR', 502);
    }
  }

  /**
   * Streams a response token-by-token via an async generator.
   * Designed for consumption by SSE (Server-Sent Events) endpoints.
   */
  async *generateStream(systemPrompt: string, messages: Message[], options?: { maxTokens?: number }): AsyncIterable<string> {
    log.info('Starting LLM stream', { model: this.model, messageCount: messages.length });

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        ],
        temperature: CHAT_TEMPERATURE,
        top_p: CHAT_TOP_P,
        max_tokens: options?.maxTokens ?? MAX_COMPLETION_TOKENS,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          yield delta;
        }
      }

      log.info('LLM stream completed');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('LLM stream failed', { error: err.message });
      throw new AppError(`LLM stream failed: ${err.message}`, 'LLM_STREAM_ERROR', 502);
    }
  }
}
