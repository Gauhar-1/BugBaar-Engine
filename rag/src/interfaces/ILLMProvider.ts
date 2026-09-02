/**
 * ILLMProvider Interface
 *
 * Abstraction over any LLM completion API (OpenAI, NVIDIA NIM,
 * Anthropic, etc.). Provides both standard JSON completion
 * and async-iterable streaming.
 *
 * @module interfaces/ILLMProvider
 */

import { Message } from '@/types';

export interface ILLMProvider {
  /**
   * Generates a complete text response in a single API call.
   *
   * @param systemPrompt - System instructions injected as the first message
   * @param messages - Conversation history (user + assistant turns)
   * @param options - Optional configuration parameters for generation
   * @returns The complete generated text as a string
   */
  generate(systemPrompt: string, messages: Message[], options?: { maxTokens?: number }): Promise<string>;

  /**
   * Streams a text response token-by-token via an async generator.
   * Intended for SSE (Server-Sent Events) streaming endpoints.
   *
   * @param systemPrompt - System instructions injected as the first message
   * @param messages - Conversation history (user + assistant turns)
   * @param options - Optional configuration parameters for generation
   * @yields Individual text chunks/tokens as they are received
   *
   * @example
   * ```ts
   * for await (const chunk of llm.generateStream(sys, msgs)) {
   *   res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
   * }
   * ```
   */
  generateStream(systemPrompt: string, messages: Message[], options?: { maxTokens?: number }): AsyncIterable<string>;
}
