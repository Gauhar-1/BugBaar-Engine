/**
 * BullMQ Client
 *
 * Provides singleton Redis connection (IORedis) and
 * factory functions for typed BullMQ Queue instances.
 *
 * All queues share the same Redis connection pool.
 *
 * @module infrastructure/queue/bullmq-client
 */

import { Queue, QueueOptions } from 'bullmq';
import IORedis from 'ioredis';
import { getRedisUrl } from '@/config/env';
import { INGESTION_QUEUE_NAME, MEMORY_QUEUE_NAME } from '@/config/constants';
import { IngestionJobData, MemoryJobData } from './queue-definitions';
import { createLogger } from '@/lib/logger';

const log = createLogger('BullMQClient');

// ─── Redis Connection Singleton ──────────────────────────────────────────────

let _redisConnection: IORedis | null = null;

/**
 * Returns a singleton IORedis connection.
 * Configures maxRetriesPerRequest=null which is required by BullMQ.
 */
export function getRedisConnection(): IORedis {
  if (_redisConnection) return _redisConnection;

  const redisUrl = getRedisUrl();
  log.info('Creating Redis connection', { url: redisUrl.replace(/:\/\/.*@/, '://***@') });

  _redisConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
  });

  _redisConnection.on('connect', () => log.info('Redis connected'));
  _redisConnection.on('error', (err) => log.error('Redis connection error', { error: err.message }));
  _redisConnection.on('close', () => log.warn('Redis connection closed'));

  return _redisConnection;
}

// ─── Shared Queue Options ─────────────────────────────────────────────────────

const DEFAULT_QUEUE_OPTIONS: Partial<QueueOptions> = {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
};

// ─── Queue Singletons ────────────────────────────────────────────────────────

let _ingestionQueue: Queue<IngestionJobData> | null = null;
let _memoryQueue: Queue<MemoryJobData> | null = null;

/**
 * Returns the singleton document ingestion BullMQ Queue.
 */
export function getIngestionQueue(): Queue<IngestionJobData> {
  if (_ingestionQueue) return _ingestionQueue;

  log.info('Creating ingestion queue', { name: INGESTION_QUEUE_NAME });

  _ingestionQueue = new Queue<IngestionJobData>(INGESTION_QUEUE_NAME, {
    connection: getRedisConnection(),
    ...DEFAULT_QUEUE_OPTIONS,
  });

  return _ingestionQueue;
}

/**
 * Returns the singleton memory summarization BullMQ Queue.
 */
export function getMemoryQueue(): Queue<MemoryJobData> {
  if (_memoryQueue) return _memoryQueue;

  log.info('Creating memory queue', { name: MEMORY_QUEUE_NAME });

  _memoryQueue = new Queue<MemoryJobData>(MEMORY_QUEUE_NAME, {
    connection: getRedisConnection(),
    ...DEFAULT_QUEUE_OPTIONS,
  });

  return _memoryQueue;
}

/**
 * Gracefully closes all queue connections.
 * Call this on process SIGTERM / SIGINT for clean shutdown.
 */
export async function closeQueues(): Promise<void> {
  const closes: Promise<void>[] = [];

  if (_ingestionQueue) closes.push(_ingestionQueue.close());
  if (_memoryQueue) closes.push(_memoryQueue.close());
  if (_redisConnection) closes.push(Promise.resolve(_redisConnection.disconnect()));

  await Promise.allSettled(closes);
  log.info('All queues and Redis connection closed');
}
