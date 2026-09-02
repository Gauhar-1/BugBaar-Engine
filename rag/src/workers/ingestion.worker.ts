/**
 * Ingestion Worker (BullMQ)
 *
 * Replaces the Inngest documentIngestionFunction with a BullMQ Worker.
 * Processes documents asynchronously through the full ingestion pipeline:
 *
 * Pipeline: Download from Cloudinary → Parse → Chunk → Summarize → Embed → Store → Mark Complete
 *
 * Uses job.updateProgress() for granular status reporting.
 * Each stage is wrapped in try/catch with proper error propagation.
 *
 * @module workers/ingestion.worker
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '@/infrastructure/queue/bullmq-client';
import { INGESTION_QUEUE_NAME } from '@/infrastructure/queue/queue-definitions';
import { IngestionJobData, IngestionJobProgress } from '@/infrastructure/queue/queue-definitions';
import { updateJobStatus } from '@/infrastructure/database/job-repository';
import { CloudinaryStorage } from '@/infrastructure/storage/CloudinaryStorage';
import { IngestionService } from '@/services/IngestionService';
import { SummarizationService, getSummarizationProvider } from '@/services/SummarizationService';
import { OpenAIEmbeddingProvider } from '@/providers/OpenAIEmbeddingProvider';
import { NvidiaEmbeddingProvider } from '@/providers/NvidiaEmbeddingProvider';
import { getEmbeddingProvider } from '@/config/env';
import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';
import { createLogger } from '@/lib/logger';

const log = createLogger('IngestionWorker');

const storage = new CloudinaryStorage();

// Factory decides the provider based on .env
const llmProvider = getSummarizationProvider(); 

//  Pass it into the service
const summarizationService = new SummarizationService(llmProvider);

/**
 * Selects the configured embedding provider.
 */
function createEmbeddingProvider(): IEmbeddingProvider {
  const provider = getEmbeddingProvider();
  return provider === 'openai'
    ? new OpenAIEmbeddingProvider()
    : new NvidiaEmbeddingProvider();
}

/**
 * The BullMQ worker processor function.
 * Instantiates IngestionService fresh per job to avoid state bleed.
 */
async function processIngestionJob(job: Job<IngestionJobData>): Promise<void> {
  const { jobId, secureUrl, filename, mimeType, fileSizeBytes } = job.data;

  log.info('Ingestion job started', { jobId, filename, fileSizeBytes });

  // ── Stage 1: Download from Cloudinary ──────────────────────────────────────
  await job.updateProgress({ stage: 'Downloading from Cloudinary' } satisfies IngestionJobProgress);
  await updateJobStatus(jobId, 'processing', { progress: 'Downloading from Cloudinary' });

  log.info('Downloading file from Cloudinary', { jobId });
  const response = await fetch(secureUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file from Cloudinary: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  log.info('File downloaded', { jobId, sizeBytes: buffer.length });

  // ── Stages 2–5: Run IngestionService pipeline ──────────────────────────────
  const embeddingProvider = createEmbeddingProvider();

  const ingestionService = new IngestionService(
    embeddingProvider,
    summarizationService,
    async (progress: IngestionJobProgress) => {
      await job.updateProgress(progress);
      await updateJobStatus(jobId, 'processing', {
        progress: progress.total
          ? `${progress.stage} (${progress.current}/${progress.total})`
          : progress.stage,
      });
    }
  );

  const result = await ingestionService.process(buffer, filename, mimeType);

  // ── Stage 6: Mark Complete ─────────────────────────────────────────────────
  await job.updateProgress({ stage: 'Completed' } satisfies IngestionJobProgress);
  await updateJobStatus(jobId, 'completed', {
    progress: 'Indexed successfully',
    result,
  });

  log.info('Ingestion job completed', { jobId, ...result });
}

/**
 * Creates and starts the BullMQ ingestion worker.
 * Returns the Worker instance for lifecycle management.
 */
export function createIngestionWorker(): Worker<IngestionJobData> {
  log.info('Starting ingestion worker', { queue: INGESTION_QUEUE_NAME });

  const worker = new Worker<IngestionJobData>(
    INGESTION_QUEUE_NAME,
    processIngestionJob,
    {
      connection: getRedisConnection(),
      concurrency: 3, // Process up to 3 documents simultaneously
      lockDuration: 300000, // 5 minutes (to allow LlamaParse to finish without stalling)
    }
  );

  worker.on('completed', (job) => {
    log.info('Job completed', { jobId: job.data.jobId, filename: job.data.filename });
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    log.error('Job failed permanently', {
      jobId: job.data.jobId,
      filename: job.data.filename,
      error: err.message,
      attemptsMade: job.attemptsMade,
    });

    // Best-effort final status update
    try {
      await updateJobStatus(job.data.jobId, 'failed', {
        error: `Ingestion failed after ${job.attemptsMade} attempts: ${err.message}`,
        progress: 'Failed',
      });
    } catch {
      // Non-critical — status DB update failure shouldn't cascade
    }
  });

  worker.on('progress', (job, progress) => {
    log.debug('Job progress', { jobId: job.data.jobId, progress });
  });

  return worker;
}
