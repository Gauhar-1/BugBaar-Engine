/**
 * IngestionService
 *
 * Orchestrates the document ingestion pipeline as a pure class.
 * Called by the BullMQ ingestion worker — no queue/framework coupling here.
 *
 * Pipeline:
 * 1. Parse — Extract structured Markdown via LlamaParse
 * 2. Chunk — Split into Markdown-aware structural chunks
 * 3. Summarize — Generate summaries for tables/images (parent-child)
 * 4. Embed — Generate vector embeddings (batched)
 * 5. Store — Bulk insert chunks into MongoDB Atlas
 *
 * @module services/IngestionService
 */

import { ObjectId } from 'mongodb';
import { IEmbeddingProvider } from '@/interfaces/IEmbeddingProvider';
import { parseDocument } from '@/infrastructure/parsing/parser';
import { splitMarkdownIntoChunks, StructuredChunk } from '@/infrastructure/parsing/markdown-chunker';
import { bulkInsertChunks, InsertDocumentChunk } from '@/infrastructure/database/document-repository';
import { SummarizationService } from '@/services/SummarizationService';
import { IngestionResult } from '@/types';
import { EMBED_BATCH_SIZE, SUMMARIZE_BATCH_SIZE } from '@/config/constants';
import { createLogger } from '@/lib/logger';

const log = createLogger('IngestionService');

export interface IngestionProgress {
  stage: string;
  current?: number;
  total?: number;
}

export class IngestionService {
  constructor(
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly summarization: SummarizationService,
    /** Optional progress callback — used by BullMQ worker to report job.updateProgress() */
    private readonly onProgress?: (progress: IngestionProgress) => Promise<void>
  ) {}

  /**
   * Processes a document buffer through the full 5-stage ingestion pipeline.
   *
   * @param buffer - Raw file buffer
   * @param filename - Original filename
   * @param mimeType - MIME type ('application/pdf' or 'text/plain')
   */
  async process(
    buffer: Buffer,
    filename: string,
    mimeType: string
  ): Promise<IngestionResult> {
    const startTime = Date.now();
    log.info('Ingestion pipeline started', { filename, mimeType, sizeBytes: buffer.length });

    // ── Stage 1: Parse ───────────────────────────────────────────────────────
    await this.reportProgress({ stage: 'Parsing document' });
    log.info('Stage 1: Parsing document');
    const markdown = await parseDocument(buffer, mimeType);
    log.info('Document parsed', { markdownLength: markdown.length });

    // ── Stage 2: Chunk ───────────────────────────────────────────────────────
    await this.reportProgress({ stage: 'Splitting into semantic chunks' });
    log.info('Stage 2: Structural chunking');
    const structuredChunks = splitMarkdownIntoChunks(markdown, filename);
    log.info('Document chunked', { totalChunks: structuredChunks.length });

    if (structuredChunks.length === 0) {
      log.warn('No chunks produced — skipping ingestion', { filename });
      return { filename, chunksProcessed: 0, tokensEstimated: 0 };
    }

    // ── Stage 3: Summarize Complex Chunks ────────────────────────────────────
    log.info('Stage 3: Summarizing complex chunks');
    const processedChunks = await this.summarizeInBatches(structuredChunks);

    // ── Stage 4: Generate Embeddings (batched) ───────────────────────────────
    log.info('Stage 4: Generating embeddings');
    const texts = processedChunks.map((c) => c.content);
    const embeddings = await this.embedInBatches(texts);

    // ── Stage 5: Store in MongoDB ─────────────────────────────────────────────
    await this.reportProgress({ stage: 'Storing in knowledge base' });
    log.info('Stage 5: Storing document chunks');
    const timestamp = new Date();

    const documentChunks: InsertDocumentChunk[] = processedChunks.map((chunk, index) => ({
      _id: new ObjectId(),
      text: chunk.content,
      embedding: embeddings[index],
      parentContent: chunk.parentContent,
      chunkType: chunk.type,
      headingPath: chunk.headingPath,
      metadata: {
        filename,
        chunkId: index + 1,
        timestamp,
        fileType: mimeType,
        hasTable: chunk.metadata.hasTable,
        hasImage: chunk.metadata.hasImage,
        isChildSummary: chunk.metadata.isChildSummary,
      },
    }));

    await bulkInsertChunks(documentChunks);

    const result: IngestionResult = {
      filename,
      chunksProcessed: documentChunks.length,
      tokensEstimated: Math.round(
        processedChunks.reduce((acc, c) => acc + c.content.length, 0) / 4
      ),
    };

    log.info('Ingestion pipeline completed', {
      ...result,
      durationMs: Date.now() - startTime,
    });

    return result;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private async summarizeInBatches(chunks: StructuredChunk[]): Promise<StructuredChunk[]> {
    const result: StructuredChunk[] = [...chunks];
    const complexIndices = chunks
      .map((c, i) => (c.type === 'table' || c.type === 'image_description' ? i : -1))
      .filter((i) => i >= 0);

    const totalBatches = Math.ceil(complexIndices.length / SUMMARIZE_BATCH_SIZE);

    for (let b = 0; b < complexIndices.length; b += SUMMARIZE_BATCH_SIZE) {
      const batchNum = Math.floor(b / SUMMARIZE_BATCH_SIZE) + 1;
      const batchIndices = complexIndices.slice(b, b + SUMMARIZE_BATCH_SIZE);

      await this.reportProgress({
        stage: `Summarizing complex chunks`,
        current: batchNum,
        total: totalBatches,
      });

      await Promise.all(
        batchIndices.map(async (idx) => {
          const chunk = chunks[idx];
          const summary = await this.summarization.generateChunkSummary(
            chunk.content,
            chunk.type as 'table' | 'image_description'
          );
          result[idx] = {
            ...chunk,
            content: summary,
            parentContent: chunk.content,
            metadata: { ...chunk.metadata, isChildSummary: true },
          };
        })
      );
    }

    return result;
  }

  private async embedInBatches(texts: string[]): Promise<number[][]> {
    const all: number[][] = [];
    const totalBatches = Math.ceil(texts.length / EMBED_BATCH_SIZE);

    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);

      await this.reportProgress({
        stage: `Generating embeddings`,
        current: batchNum,
        total: totalBatches,
      });

      log.debug(`Embedding batch ${batchNum}/${totalBatches}`, { batchSize: batch.length });
      const batchEmbeddings = await this.embeddingProvider.embedBatch(batch, 'passage');
      all.push(...batchEmbeddings);
    }

    return all;
  }

  private async reportProgress(progress: IngestionProgress): Promise<void> {
    if (this.onProgress) {
      try {
        await this.onProgress(progress);
      } catch {
        // Progress reporting is non-critical — never throw
      }
    }
  }
}
