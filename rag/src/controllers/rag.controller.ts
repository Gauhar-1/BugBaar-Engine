/**
 * RAG Controller
 *
 * Express controller exposing 4 endpoints:
 * - POST /ingest    — Upload doc → Cloudinary → BullMQ job
 * - POST /retrieve  — Hybrid search → ranked context (no LLM)
 * - POST /chat      — Full RAG pipeline → JSON response
 * - POST /chat/stream — Full RAG pipeline → SSE streaming
 *
 * All methods use Zod for input validation and call next(error) on failure.
 *
 * @module controllers/rag.controller
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { RAGPipelineService } from '@/services/RAGPipelineService';
import { HybridRetrievalService } from '@/services/HybridRetrievalService';
import { CloudinaryStorage } from '@/infrastructure/storage/CloudinaryStorage';
import { getIngestionQueue } from '@/infrastructure/queue/bullmq-client';
import { createJob } from '@/infrastructure/database/job-repository';
import { ValidationError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { ChatRequest, RetrieveRequest } from '@/types';
import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';

const log = createLogger('RAGController');

// ─── Zod Validation Schemas ──────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
});

const ChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(50),
  threadId: z.string().uuid().optional(),
  userId: z.string().optional(),
});

const RetrieveRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  filters: z
    .object({
      category: z.string().optional(),
      subcategory: z.string().optional(),
      gender: z.enum(['men', 'women', 'unisex']).optional(),
      brand: z.string().optional(),
      inStock: z.boolean().optional(),
      minPrice: z.number().positive().optional(),
      maxPrice: z.number().positive().optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// ─── Multer Configuration ─────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = ['application/pdf', 'text/plain'];
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(), // Buffer in RAM — streamed to Cloudinary
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ValidationError(`Unsupported file type: ${file.mimetype}. Accepted: PDF, TXT`));
    }
  },
});

// ─── Controller Class ─────────────────────────────────────────────────────────

export class RAGController {
  private storage: CloudinaryStorage;

  constructor(
    private readonly ragPipeline: RAGPipelineService,
    private readonly hybridRetrieval: HybridRetrievalService,
    private readonly embeddingProvider: IEmbeddingProvider
  ) {
    this.storage = new CloudinaryStorage();
  }

  /**
   * POST /ingest
   *
   * Accepts a multipart file upload, stores it in Cloudinary,
   * creates a job record in MongoDB, and enqueues a BullMQ ingestion job.
   *
   * Response: { jobId, filename, status: 'queued' }
   */
  ingest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        throw new ValidationError('No file uploaded. Use multipart/form-data with field name "file".');
      }

      const { originalname, mimetype, buffer, size } = req.file;
      const jobId = uuidv4();

      log.info('Ingest request received', { filename: originalname, mimeType: mimetype, size });

      // ── Upload to Cloudinary ──────────────────────────────────────────────
      const uploadResult = await this.storage.uploadBuffer(buffer, originalname);

      log.info('File uploaded to Cloudinary', {
        publicId: uploadResult.publicId,
        bytes: uploadResult.bytes,
        secureUrl: uploadResult.secureUrl,
      });

      // ── Create job record in MongoDB ──────────────────────────────────────
      await createJob({
        _id: jobId,
        filename: originalname,
        mimeType: mimetype,
        fileSizeBytes: size,
        secureUrl: uploadResult.secureUrl,
        status: 'pending',
        progress: 'Queued for processing',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // ── Enqueue BullMQ job ────────────────────────────────────────────────
      const ingestionQueue = getIngestionQueue();
      await ingestionQueue.add(
        'ingest-document',
        {
          jobId,
          filename: originalname,
          mimeType: mimetype,
          fileSizeBytes: size,
          secureUrl: uploadResult.secureUrl,
          },
        {
          jobId, // Use our jobId as BullMQ job ID for traceability
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        }
      );

      log.info('Ingestion job enqueued', { jobId, filename: originalname });

      res.status(202).json({
        jobId,
        filename: originalname,
        status: 'queued',
        message: `Document accepted for processing. Poll /ingest/status/${jobId} for updates.`,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /retrieve
   *
   * Runs hybrid retrieval and returns ranked context without LLM generation.
   * Useful for debugging retrieval quality or building custom pipelines.
   *
   * Body: RetrieveRequest
   * Response: RetrieveResponse
   */
  retrieve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = RetrieveRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid request: ${parsed.error.errors.map((e) => e.message).join(', ')}`
        );
      }

      const { query, filters, limit } = parsed.data as RetrieveRequest;
      const startTime = Date.now();

      log.info('Retrieve request received', { query: query.slice(0, 80) });

      // ── Embed query ───────────────────────────────────────────────────────
      const queryEmbedding = await this.embeddingProvider.embed(query, 'query');

      // ── Hybrid retrieval ──────────────────────────────────────────────────
      const context = await this.hybridRetrieval.retrieve(query, queryEmbedding, {
        productLimit: limit,
        productFilter: filters
          ? {
              ...(filters.category && { category: filters.category }),
              ...(filters.subcategory && { subcategory: filters.subcategory }),
              ...(filters.gender && { gender: filters.gender }),
              ...(filters.brand && { brand: filters.brand }),
              ...(filters.inStock !== undefined && { inStock: filters.inStock }),
              ...(filters.minPrice !== undefined && { price: { $gte: filters.minPrice } }),
              ...(filters.maxPrice !== undefined && { price: { $lte: filters.maxPrice } }),
            }
          : {},
      });

      res.json({
        products: context.products,
        documents: context.documents,
        queryEmbeddingDimensions: queryEmbedding.length,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /chat
   *
   * Runs the full RAG pipeline and returns a complete JSON response.
   *
   * Body: ChatRequest
   * Response: ChatResponse
   */
  chat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid request: ${parsed.error.errors.map((e) => e.message).join(', ')}`
        );
      }

      const chatReq = parsed.data as ChatRequest;
      log.info('Chat request received', {
        messageCount: chatReq.messages.length,
        threadId: chatReq.threadId,
      });

      const result = await this.ragPipeline.execute(chatReq);

      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /chat/stream
   *
   * Runs the full RAG pipeline and streams the response token-by-token
   * using Server-Sent Events (SSE).
   *
   * SSE Event format:
   *   data: {"type":"token","delta":"<text>"}\n\n
   *   data: {"type":"done","metadata":{...}}\n\n
   *   data: [DONE]\n\n
   */
  stream = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid request: ${parsed.error.errors.map((e) => e.message).join(', ')}`
        );
      }

      const chatReq = parsed.data as ChatRequest;
      log.info('Stream request received', { messageCount: chatReq.messages.length });

      // ── Set SSE headers ───────────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      // ── Stream RAG pipeline ───────────────────────────────────────────────
      try {
        for await (const event of this.ragPipeline.stream(chatReq)) {
          const data = JSON.stringify(event);
          res.write(`data: ${data}\n\n`);

          // Flush immediately for real-time delivery
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        }
      } catch (streamError) {
        // Send error event before closing stream
        const errorData = JSON.stringify({
          type: 'error',
          error: (streamError as Error).message,
        });
        res.write(`data: ${errorData}\n\n`);
      }

      // Terminate SSE stream
      res.write('data: [DONE]\n\n');
      res.end();

      log.info('Stream completed');
    } catch (error) {
      // Headers not sent yet — pass to error middleware
      if (!res.headersSent) {
        next(error);
      } else {
        log.error('Stream error after headers sent', { error: (error as Error).message });
        res.end();
      }
    }
  };
}
