/**
 * RAGPipelineService
 *
 * Orchestrates the complete RAG pipeline:
 * 1. Security validation (injection detection)
 * 2. Query embedding
 * 3. Hybrid retrieval (vector + BM25 + RRF + reranking)
 * 4. User memory retrieval (optional)
 * 5. Context sandboxing (XML untrusted_context)
 * 6. Prompt construction
 * 7. LLM completion (blocking or streaming)
 *
 * @module services/RAGPipelineService
 */

import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';
import { ILLMProvider } from '@/interfaces/ILLMProvider';
import { ISecurityGuardrail } from '@/interfaces/ISecurityGuardrail';
import { HybridRetrievalService, HybridRetrievalOptions } from '@/services/HybridRetrievalService';
import { PromptBuilderService } from '@/services/PromptBuilderService';
import {
  ChatRequest,
  ChatResponse,
  RAGContext,
  ProductSearchResult,
  DocumentSearchResult,
} from '@/types';
import { EmbeddingError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('RAGPipelineService');

export interface RAGPipelineOptions extends HybridRetrievalOptions {
  intent?: string;
  subDomain?: string;
  maxTokens?: number;
}

export class RAGPipelineService {
  constructor(
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly hybridRetrieval: HybridRetrievalService,
    private readonly llmProvider: ILLMProvider,
    private readonly guardrail: ISecurityGuardrail,
    private readonly promptBuilder: PromptBuilderService,
    /** Optional: inject user memory lookup function */
    private readonly getMemory?: (userId: string, embedding: number[]) => Promise<string | null>
  ) {}

  /**
   * Executes the full RAG pipeline and returns a JSON response.
   */
  async execute(
    request: ChatRequest,
    options: RAGPipelineOptions = {}
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    const userQuery = this.extractUserQuery(request.messages);

    log.info('RAG pipeline starting', {
      query: userQuery.slice(0, 80),
      userId: request.userId,
      threadId: request.threadId,
    });

    // ── Stage 1: Security Validation ────────────────────────────────────────
    const validationResult = this.guardrail.validate(userQuery);
    if (!validationResult.safe) {
      log.warn('Query blocked by security guardrail', { reason: validationResult.reason });
      return {
        answer: `I'm unable to process that request. ${validationResult.reason ?? 'Please rephrase your query.'}`,
        context: { retrievedProducts: [], retrievedDocuments: [], hasUserMemory: false, totalResults: 0 },
        durationMs: Date.now() - startTime,
      };
    }

    // ── Stage 2: Query Embedding ─────────────────────────────────────────────
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddingProvider.embed(userQuery, 'query');
      log.info('Query embedding generated', { dimensions: queryEmbedding.length });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new EmbeddingError(`Failed to embed query: ${err.message}`, err);
    }

    // ── Stage 3: Hybrid Retrieval ────────────────────────────────────────────
    const retrievalContext = await this.hybridRetrieval.retrieve(userQuery, queryEmbedding, options);

    // ── Stage 4: User Memory (optional) ─────────────────────────────────────
    let userMemory: string | null = null;
    if (request.userId && this.getMemory) {
      try {
        userMemory = await this.getMemory(request.userId, queryEmbedding);
      } catch (error) {
        log.warn('User memory retrieval failed (non-critical)', {
          error: (error as Error).message,
        });
      }
    }

    // ── Stage 5: Context Sandboxing ──────────────────────────────────────────
    const rawContext = this.buildRawContext(retrievalContext.products, retrievalContext.documents);
    const sandboxedContext = rawContext ? this.guardrail.sandboxContext(rawContext) : '';

    // ── Stage 6: Prompt Construction ─────────────────────────────────────────
    const systemPrompt = this.promptBuilder.buildSystemPrompt(
      retrievalContext.products,
      retrievalContext.documents,
      userMemory,
      { intent: options.intent, subDomain: options.subDomain }
    );
    const messages = this.promptBuilder.buildMessages(request.messages, userQuery);

    // ── Stage 7: LLM Completion ──────────────────────────────────────────────
    const answer = await this.llmProvider.generate(systemPrompt, messages, { maxTokens: options.maxTokens });

    const durationMs = Date.now() - startTime;
    log.info('RAG pipeline completed', {
      durationMs,
      products: retrievalContext.products.length,
      documents: retrievalContext.documents.length,
    });

    return {
      answer,
      context: {
        retrievedProducts: retrievalContext.products,
        retrievedDocuments: retrievalContext.documents,
        hasUserMemory: !!userMemory,
        totalResults: retrievalContext.products.length + retrievalContext.documents.length,
      },
      durationMs,
    };
  }

  /**
   * Executes the RAG pipeline and streams the response token-by-token.
   * Returns an AsyncIterable suitable for SSE streaming.
   *
   * Yields:
   * - Chunks of type 'token' with text delta
   * - Final chunk of type 'done' with metadata
   */
  async *stream(
    request: ChatRequest,
    options: RAGPipelineOptions = {}
  ): AsyncIterable<{ type: 'token'; delta: string } | { type: 'done'; metadata: ChatResponse['context'] }> {
    const startTime = Date.now();
    const userQuery = this.extractUserQuery(request.messages);

    log.info('RAG stream pipeline starting', { query: userQuery.slice(0, 80) });

    // ── Stage 1: Security Validation ────────────────────────────────────────
    const validationResult = this.guardrail.validate(userQuery);
    if (!validationResult.safe) {
      yield { type: 'token', delta: `Security validation failed: ${validationResult.reason ?? 'Please rephrase.'}` };
      yield { type: 'done', metadata: { retrievedProducts: [], retrievedDocuments: [], hasUserMemory: false, totalResults: 0 } };
      return;
    }

    // ── Stage 2: Embedding ───────────────────────────────────────────────────
    const queryEmbedding = await this.embeddingProvider.embed(userQuery, 'query');

    // ── Stage 3: Retrieval ───────────────────────────────────────────────────
    const retrievalContext = await this.hybridRetrieval.retrieve(userQuery, queryEmbedding, options);

    // ── Stage 4: User Memory ─────────────────────────────────────────────────
    let userMemory: string | null = null;
    if (request.userId && this.getMemory) {
      try {
        userMemory = await this.getMemory(request.userId, queryEmbedding);
      } catch {
        // non-critical
      }
    }

    // ── Stage 5: Prompt ──────────────────────────────────────────────────────
    const systemPrompt = this.promptBuilder.buildSystemPrompt(
      retrievalContext.products,
      retrievalContext.documents,
      userMemory,
      { intent: options.intent, subDomain: options.subDomain }
    );
    const messages = this.promptBuilder.buildMessages(request.messages, userQuery);

    // ── Stage 6: Stream LLM Response ─────────────────────────────────────────
    for await (const chunk of this.llmProvider.generateStream(systemPrompt, messages, { maxTokens: options.maxTokens })) {
      yield { type: 'token', delta: chunk };
    }

    log.info('RAG stream pipeline completed', { durationMs: Date.now() - startTime });

    yield {
      type: 'done',
      metadata: {
        retrievedProducts: retrievalContext.products,
        retrievedDocuments: retrievalContext.documents,
        hasUserMemory: !!userMemory,
        totalResults: retrievalContext.products.length + retrievalContext.documents.length,
      },
    };
  }

  /**
   * Builds the full RAGContext for diagnostic/retrieve endpoints.
   */
  async buildContext(
    request: ChatRequest,
    options: RAGPipelineOptions = {}
  ): Promise<RAGContext> {
    const userQuery = this.extractUserQuery(request.messages);
    const queryEmbedding = await this.embeddingProvider.embed(userQuery, 'query');
    const retrievalContext = await this.hybridRetrieval.retrieve(userQuery, queryEmbedding, options);

    let userMemory: string | null = null;
    if (request.userId && this.getMemory) {
      try { userMemory = await this.getMemory(request.userId, queryEmbedding); } catch { }
    }

    const systemPrompt = this.promptBuilder.buildSystemPrompt(
      retrievalContext.products,
      retrievalContext.documents,
      userMemory
    );

    return {
      userQuery,
      queryEmbedding,
      retrievedProducts: retrievalContext.products,
      retrievedDocuments: retrievalContext.documents,
      userMemory,
      systemPrompt,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private extractUserQuery(messages: ChatRequest['messages']): string {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) {
      throw new Error('No user message found in conversation history');
    }
    return lastUserMessage.content;
  }

  private buildRawContext(
    products: ProductSearchResult[],
    documents: DocumentSearchResult[]
  ): string {
    const parts: string[] = [];

    if (products.length > 0) {
      parts.push(products.map((p) => `${p.name}: ${p.description}`).join('\n'));
    }
    if (documents.length > 0) {
      parts.push(documents.map((d) => d.parentContent ?? d.text).join('\n'));
    }

    return parts.join('\n\n');
  }
}
