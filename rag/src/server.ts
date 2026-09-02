/**
 * Server Entry Point
 *
 * Bootstraps the Express application, connects to dependencies,
 * and starts listening on the configured port.
 *
 * Run with: npm run dev (ts-node-dev) or npm start (compiled JS)
 *
 * @module server
 */

import 'dotenv/config';
import { createApp } from './app';
import { getDatabase } from '@/infrastructure/database/mongodb-client';
import { getRedisConnection } from '@/infrastructure/queue/bullmq-client';
import { closeDatabase } from '@/infrastructure/database/mongodb-client';
import { closeQueues } from '@/infrastructure/queue/bullmq-client';
import { getPort } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('Server');

async function main(): Promise<void> {
  // ── Pre-flight: Verify connections ─────────────────────────────────────────
  log.info('Verifying database connection');
  await getDatabase(); // Will throw if MongoDB is unreachable
  log.info('MongoDB connection verified');

  // ── Pre-flight: Verify Redis (non-fatal — only ingest needs it) ──────────
  try {
    log.info('Verifying Redis connection');
    const redis = getRedisConnection();
    await redis.ping();
    log.info('Redis connection verified');
  } catch (redisError) {
    log.warn(
      'Redis is not available — BullMQ queue (POST /rag/ingest) will not work. ' +
      'RAG chat and retrieval endpoints remain fully operational. ' +
      'Start Redis to enable document ingestion.',
      { error: (redisError as Error).message }
    );
  }

  // ── Start Express ─────────────────────────────────────────────────────────
  const app = createApp();
  const port = getPort();

  const server = app.listen(port, () => {
    log.info(`BugBaar RAG Engine listening on port ${port}`, {
      port,
      env: process.env.NODE_ENV ?? 'development',
    });
  });

  // ── Graceful Shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal} — initiating graceful shutdown`);

    server.close(async () => {
      try {
        await closeDatabase();
        await closeQueues();
        log.info('Server shut down cleanly');
        process.exit(0);
      } catch (error) {
        log.error('Error during shutdown', { error: (error as Error).message });
        process.exit(1);
      }
    });

    // Force exit if graceful shutdown hangs
    setTimeout(() => {
      log.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
