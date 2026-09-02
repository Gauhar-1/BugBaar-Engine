/**
 * NVIDIA NIM LLM Provider
 *
 * Implements ILLMProvider for the NVIDIA NIM API.
 * Uses the fetch API to generate completions and Server-Sent Events (SSE)
 * for streaming tokens.
 *
 * @module providers/NvidiaLLMProvider
 */

import { getNvidiaApiKey, getNvidiaBaseUrl, getNvidiaChatModel } from '@/config/env';
import { ILLMProvider } from '@/interfaces/ILLMProvider';
import { Message } from '@/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('NvidiaLLMProvider');

export class NvidiaLLMProvider implements ILLMProvider {
  async generate(systemPrompt: string, messages: Message[], options?: { maxTokens?: number }): Promise<string> {
    log.info('Generating NVIDIA chat completion', { messageCount: messages.length });

    const startTime = Date.now();
    const baseUrl = getNvidiaBaseUrl();
    const apiKey = getNvidiaApiKey();
    const model = getNvidiaChatModel();

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.2,
        max_tokens: options?.maxTokens ?? 1024,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`NVIDIA API error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';

    log.debug('NVIDIA completion generated', {
      durationMs: Date.now() - startTime,
      tokens: data.usage?.total_tokens,
    });

    return content;
  }

  async *generateStream(systemPrompt: string, messages: Message[], options?: { maxTokens?: number }): AsyncIterable<string> {
    log.info('Starting NVIDIA streaming chat completion', { messageCount: messages.length });

    const baseUrl = getNvidiaBaseUrl();
    const apiKey = getNvidiaApiKey();
    const model = getNvidiaChatModel();

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.2,
        max_tokens: options?.maxTokens ?? 1024,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`NVIDIA Streaming API error: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error('NVIDIA API response has no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep the incomplete line in the buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            try {
              const data = JSON.parse(dataStr);
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (err) {
              log.warn('Failed to parse NVIDIA SSE data stream chunk', { dataStr });
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
