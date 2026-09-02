/**
 * Queue Infrastructure Types
 *
 * Type definitions for job records tracked in MongoDB.
 *
 * @module infrastructure/queue/types
 */

export type IngestionJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Job record stored in the ingestion_jobs MongoDB collection.
 * Tracks the lifecycle of async document ingestion pipelines.
 */
export interface IngestionJob {
  /** String UUID for the job (used as MongoDB _id) */
  _id: string;
  /** Original filename of the uploaded document */
  filename: string;
  /** MIME type of the uploaded file */
  mimeType: string;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Cloudinary public_id for the stored file */
  secureUrl: string;
  /** Current job lifecycle status */
  status: IngestionJobStatus;
  /** Human-readable progress description */
  progress?: string;
  /** Result data on successful completion */
  result?: {
    chunksProcessed: number;
    tokensEstimated: number;
  };
  /** Error message on failure */
  error?: string;
  /** ISO timestamp of job creation */
  createdAt: Date;
  /** ISO timestamp of last status update */
  updatedAt: Date;
}
