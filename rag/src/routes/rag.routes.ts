/**
 * RAG Routes
 *
 * Express Router binding RAGController methods to their
 * respective HTTP endpoints under the /rag prefix.
 *
 * Mounted in app.ts as: app.use('/rag', ragRouter)
 *
 * Routes:
 *   POST /rag/ingest          — Document ingestion via Cloudinary + BullMQ
 *   POST /rag/retrieve        — Hybrid search without LLM generation
 *   POST /rag/chat            — Full RAG pipeline → JSON completion
 *   POST /rag/chat/stream     — Full RAG pipeline → SSE streaming
 *
 * @module routes/rag.routes
 */

import { Router } from 'express';
import { RAGController, uploadMiddleware } from '@/controllers/rag.controller';
import { RAGPipelineService } from '@/services/RAGPipelineService';
import { HybridRetrievalService } from '@/services/HybridRetrievalService';
import { SecurityGuardrailService } from '@/services/SecurityGuardrailService';
import { PromptBuilderService } from '@/services/PromptBuilderService';
import { MongoVectorStore } from '@/providers/MongoVectorStore';
import { CohereReranker } from '@/providers/CohereReranker';
import { OpenAILLMProvider } from '@/providers/OpenAILLMProvider';
import { OpenAIEmbeddingProvider } from '@/providers/OpenAIEmbeddingProvider';
import { NvidiaEmbeddingProvider } from '@/providers/NvidiaEmbeddingProvider';
import { NvidiaLLMProvider } from '@/providers/NvidiaLLMProvider';
import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';
import { ILLMProvider } from '@/interfaces/ILLMProvider';
import { getDatabase } from '@/infrastructure/database/mongodb-client';
import { getEmbeddingProvider } from '@/config/env';

// ─── Dependency Wiring ────────────────────────────────────────────────────────
// This is the composition root — concrete implementations are wired here.
// All downstream classes only depend on interfaces.

function buildEmbeddingProvider(): IEmbeddingProvider {
  const provider = getEmbeddingProvider();
  return provider === 'openai' ? new OpenAIEmbeddingProvider() : new NvidiaEmbeddingProvider();
}

function buildLLMProvider(): ILLMProvider {
  const provider = getEmbeddingProvider();
  return provider === 'openai' ? new OpenAILLMProvider() : new NvidiaLLMProvider();
}

const embeddingProvider = buildEmbeddingProvider();
const vectorStore = new MongoVectorStore(getDatabase);
const reranker = new CohereReranker();
const llmProvider = buildLLMProvider();
const guardrail = new SecurityGuardrailService();
const promptBuilder = new PromptBuilderService();

const hybridRetrieval = new HybridRetrievalService(vectorStore, embeddingProvider, reranker);

const ragPipeline = new RAGPipelineService(
  embeddingProvider,
  hybridRetrieval,
  llmProvider,
  guardrail,
  promptBuilder
);

const controller = new RAGController(ragPipeline, hybridRetrieval, embeddingProvider);

// ─── Router ───────────────────────────────────────────────────────────────────

const ragRouter = Router();

/**
 * POST /rag/ingest
 * Accepts multipart/form-data with a 'file' field (PDF or TXT, max 50MB).
 * Returns { jobId, filename, status: 'queued' } with HTTP 202.
 */
ragRouter.post('/ingest', uploadMiddleware.single('file'), controller.ingest);

/**
 * POST /rag/retrieve
 * Body: { query: string, filters?: {...}, limit?: number }
 * Returns ranked products and document chunks without LLM generation.
 */
ragRouter.post('/retrieve', controller.retrieve);

/**
 * POST /rag/chat
 * Body: { messages: Message[], threadId?: string, userId?: string }
 * Returns: { answer: string, context: {...}, durationMs: number }
 */
ragRouter.post('/chat', controller.chat);

/**
 * POST /rag/chat/stream
 * Body: { messages: Message[], threadId?: string, userId?: string }
 * Returns: Server-Sent Events stream
 *   data: {"type":"token","delta":"..."}\n\n
 *   data: {"type":"done","metadata":{...}}\n\n
 *   data: [DONE]\n\n
 */
ragRouter.post('/chat/stream', controller.stream);

export { ragRouter };
