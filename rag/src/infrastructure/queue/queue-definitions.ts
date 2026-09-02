/**
 * BullMQ Queue Definitions
 *
 * Typed job data interfaces and queue name constants
 * for all BullMQ queues in the RAG engine.
 *
 * @module infrastructure/queue/queue-definitions
 */

import { INGESTION_QUEUE_NAME, MEMORY_QUEUE_NAME } from '@/config/constants';

// Re-export queue name constants for use in workers and producers
export { INGESTION_QUEUE_NAME, MEMORY_QUEUE_NAME };

// ─── Ingestion Queue ─────────────────────────────────────────────────────────

/**
 * Job data for the document ingestion queue.
 * Produced by: POST /rag/ingest
 * Consumed by: ingestion.worker.ts
 */
export interface IngestionJobData {
  /** MongoDB ObjectId string used to track job status */
  jobId: string;
  /** Cloudinary public_id for the uploaded file */
  secureUrl: string;
  /** Original filename of the uploaded document */
  filename: string;
  /** MIME type ('application/pdf' | 'text/plain') */
  mimeType: string;
  /** File size in bytes */
  fileSizeBytes: number;
}

/**
 * Progress data emitted during ingestion job processing.
 */
export interface IngestionJobProgress {
  stage: string;
  current?: number;
  total?: number;
}

// ─── Memory Queue ────────────────────────────────────────────────────────────

/**
 * Job data for the memory summarization queue.
 * Produced by: MemoryService.maybeDispatchMemorySummarization()
 * Consumed by: memory.worker.ts
 */
export interface MemoryJobData {
  /** Authenticated user ID */
  userId: string;
  /** Total message count that triggered the summarization */
  messageCount: number;
}
