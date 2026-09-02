/**
 * Memory Worker (BullMQ)
 *
 * Replaces the Inngest memory summarization function.
 * Reads recent chat history for a user, generates a summary
 * using a fast LLM, and upserts it into the memory vector store.
 *
 * @module workers/memory.worker
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '@/infrastructure/queue/bullmq-client';
import { MEMORY_QUEUE_NAME, MemoryJobData } from '@/infrastructure/queue/queue-definitions';
import { getRecentMessagesByUser } from '@/infrastructure/database/chat-history-repository';
import { upsertUserMemory } from '@/infrastructure/database/memory-repository';
import { OpenAIEmbeddingProvider } from '@/providers/OpenAIEmbeddingProvider';
import { NvidiaEmbeddingProvider } from '@/providers/NvidiaEmbeddingProvider';
import { getEmbeddingProvider, getNvidiaApiKey, getNvidiaBaseUrl, getNvidiaSummarizationModel } from '@/config/env';
import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';
import { createLogger } from '@/lib/logger';

const log = createLogger('MemoryWorker');

function createEmbeddingProvider(): IEmbeddingProvider {
  const provider = getEmbeddingProvider();
  return provider === 'openai' ? new OpenAIEmbeddingProvider() : new NvidiaEmbeddingProvider();
}

/**
 * Summarizes recent chat history for a user using a lightweight LLM.
 */
async function summarizeChatHistory(history: Array<{ role: string; content: string }>): Promise<string> {
  const formattedHistory = history
    .slice(-20) // Last 20 messages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  const response = await fetch(`${getNvidiaBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getNvidiaApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getNvidiaSummarizationModel(),
      messages: [
        {
          role: 'system',
          content:
            'Extract and summarize the user\'s preferences, style choices, sizes, budget, and any stated likes/dislikes from this conversation. Output a concise 3-5 sentence summary for use as future context.',
        },
        {
          role: 'user',
          content: `Conversation history:\n${formattedHistory}\n\nSummarize the user's preferences:`,
        },
      ],
      temperature: 0.3,
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    throw new Error(`Summarization API failed: ${response.status}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

/**
 * The BullMQ memory worker processor.
 */
async function processMemoryJob(job: Job<MemoryJobData>): Promise<void> {
  const { userId, messageCount } = job.data;

  log.info('Memory summarization job started', { userId, messageCount });

  // ── Retrieve recent chat history ─────────────────────────────────────────
  const history = await getRecentMessagesByUser(userId);
  if (!history || history.length === 0) {
    log.info('No chat history found — skipping memory update', { userId });
    return;
  }

  // ── Generate memory summary ───────────────────────────────────────────────
  const summary = await summarizeChatHistory(history);
  if (!summary) {
    log.warn('Empty summary generated — skipping upsert', { userId });
    return;
  }

  log.info('Memory summary generated', { userId, summaryLength: summary.length });

  // ── Embed the summary ─────────────────────────────────────────────────────
  const embeddingProvider = createEmbeddingProvider();
  const embedding = await embeddingProvider.embed(summary, 'passage');

  // ── Upsert to memory vector store ─────────────────────────────────────────
  await upsertUserMemory(userId, summary, embedding, messageCount);

  log.info('Memory summarization job completed', { userId });
}

/**
 * Creates and starts the BullMQ memory worker.
 */
export function createMemoryWorker(): Worker<MemoryJobData> {
  log.info('Starting memory worker', { queue: MEMORY_QUEUE_NAME });

  const worker = new Worker<MemoryJobData>(
    MEMORY_QUEUE_NAME,
    processMemoryJob,
    {
      connection: getRedisConnection(),
      concurrency: 5,
    }
  );

  worker.on('completed', (job) => {
    log.info('Memory job completed', { userId: job.data.userId });
  });

  worker.on('failed', (job, err) => {
    log.error('Memory job failed', {
      userId: job?.data.userId,
      error: err.message,
      attemptsMade: job?.attemptsMade,
    });
  });

  return worker;
}
