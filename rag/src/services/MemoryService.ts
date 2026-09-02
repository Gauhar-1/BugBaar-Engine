/**
 * MemoryService
 *
 * Orchestrates memory-related operations for the RAG pipeline:
 * - Retrieves user memory vectors for query augmentation
 * - Dispatches memory summarization jobs via BullMQ
 *
 * Replaces the Inngest-based dispatch with a BullMQ Queue.
 *
 * @module services/MemoryService
 */

import { Queue } from 'bullmq';
import { searchUserMemory } from '@/infrastructure/database/memory-repository';
import { getMessageCount } from '@/infrastructure/database/chat-history-repository';
import { MEMORY_TRIGGER_INTERVAL } from '@/config/constants';
import { MemoryJobData } from '@/infrastructure/queue/queue-definitions';
import { createLogger } from '@/lib/logger';

const log = createLogger('MemoryService');

export class MemoryService {
  constructor(private readonly memoryQueue: Queue<MemoryJobData>) {}

  /**
   * Retrieves the user's memory context for the RAG pipeline.
   * Performs a vector search filtered by userId.
   *
   * @param userId - Authenticated user ID
   * @param queryEmbedding - Query embedding for relevance matching
   * @returns Combined memory summary or null if no memory exists
   */
  async retrieveUserMemory(
    userId: string,
    queryEmbedding: number[]
  ): Promise<string | null> {
    try {
      const results = await searchUserMemory(userId, queryEmbedding);

      if (results.length === 0) {
        log.debug('No user memory found', { userId });
        return null;
      }

      const combined = results.map((r) => r.summary).join('\n\n');

      log.info('User memory retrieved', {
        userId,
        resultCount: results.length,
        summaryLength: combined.length,
      });

      return combined;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Failed to retrieve user memory', { userId, error: err.message });
      return null; // Non-critical — graceful degradation
    }
  }

  /**
   * Checks message count and dispatches a memory summarization BullMQ job
   * when the trigger threshold (every MEMORY_TRIGGER_INTERVAL messages) is met.
   *
   * @param userId - Authenticated user ID
   */
  async maybeDispatchMemorySummarization(userId: string): Promise<void> {
    try {
      const count = await getMessageCount(userId);

      if (count > 0 && count % MEMORY_TRIGGER_INTERVAL === 0) {
        log.info('Dispatching memory summarization job', { userId, messageCount: count });

        await this.memoryQueue.add(
          'memory-summarize',
          { userId, messageCount: count },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 },
          }
        );

        log.info('Memory summarization job enqueued', { userId });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // Non-critical — never throw, just log
      log.error('Failed to dispatch memory summarization', { userId, error: err.message });
    }
  }
}
