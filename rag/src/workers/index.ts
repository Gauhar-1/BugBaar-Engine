/**
 * Workers Entry Point
 *
 * Starts all BullMQ workers in a single process.
 * Run this separately from the main API server:
 *   npm run worker
 *
 * @module workers/index
 */

import 'dotenv/config';
import { createIngestionWorker } from './ingestion.worker';
import { createMemoryWorker } from './memory.worker';
import { closeQueues } from '@/infrastructure/queue/bullmq-client';
import { closeDatabase } from '@/infrastructure/database/mongodb-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('WorkerProcess');

async function main(): Promise<void> {
  log.info('Starting BullMQ workers');

  const ingestionWorker = createIngestionWorker();
  const memoryWorker = createMemoryWorker();

  log.info('All workers started successfully');

  // ── Graceful Shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal} — shutting down workers gracefully`);

    try {
      await Promise.allSettled([
        ingestionWorker.close(),
        memoryWorker.close(),
      ]);
      await closeQueues();
      await closeDatabase();
      log.info('All workers shut down cleanly');
      process.exit(0);
    } catch (error) {
      log.error('Error during worker shutdown', { error: (error as Error).message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Failed to start workers:', error);
  process.exit(1);
});
