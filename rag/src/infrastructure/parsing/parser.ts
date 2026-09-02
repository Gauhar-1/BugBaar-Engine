/**
 * Document Parser (LlamaParse)
 * 
 * Multimodal document parsing via LlamaParse (LlamaIndex Cloud).
 * Replaces the old pdf2json parser with vision-capable extraction
 * that handles images, complex tables, and returns structured Markdown.
 * 
 * Falls back to plain text extraction for .txt files.
 * 
 * @module infrastructure/parsing/parser
 */

import { LlamaParseReader } from '@llamaindex/cloud/reader';
import { getLlamaCloudApiKey } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

const log = createLogger('ParserService');

/**
 * Thrown when document parsing fails.
 */
export class ParsingError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'PARSING_ERROR', 422);
    this.name = 'ParsingError';
    if (cause) this.cause = cause;
  }
}

/**
 * Extracts structured Markdown from a file buffer using LlamaParse.
 * 
 * For PDFs: Uses LlamaParse's multimodal capabilities to extract
 * text, tables, and image descriptions as clean Markdown.
 * 
 * For TXT: Returns the raw text content directly.
 * 
 * @param buffer - Raw file buffer
 * @param mimeType - MIME type of the file
 * @returns Structured Markdown content
 * @throws {ParsingError} If parsing fails
 */
export async function parseDocument(buffer: Buffer, mimeType: string): Promise<string> {
  log.info('Parsing document', { mimeType, sizeBytes: buffer.length });

  try {
    if (mimeType === 'application/pdf') {
      return await parsePdfWithLlamaParse(buffer);
    } else if (mimeType === 'text/plain') {
      const text = buffer.toString('utf-8');
      log.debug('Text file parsed', { textLength: text.length });
      return text;
    } else {
      throw new ParsingError(`Unsupported MIME type: ${mimeType}`);
    }
  } catch (error) {
    if (error instanceof ParsingError) {
      throw error;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Document parsing failed', { error: err.message });
    throw new ParsingError(`Failed to parse document: ${err.message}`, err);
  }
}

/**
 * Parses a PDF buffer using LlamaParse's multimodal extraction.
 * Returns structured Markdown with tables, headings, and image descriptions.
 */
async function parsePdfWithLlamaParse(buffer: Buffer): Promise<string> {
  log.info('Parsing PDF with LlamaParse (multimodal)');

  const reader = new LlamaParseReader({
    apiKey: getLlamaCloudApiKey(),
    resultType: 'markdown',
    verbose: false,
    premiumMode: true,
    isFormattingInstruction: true,
  });

  try {
    const documents = await reader.loadDataAsContent(new Uint8Array(buffer));

    if (!documents || documents.length === 0) {
      throw new ParsingError('LlamaParse returned no documents from PDF');
    }

    // Combine all document pages into a single Markdown string
    const markdown = documents
      .map((doc: { text: string }) => doc.text)
      .filter((text: string) => text && text.trim().length > 0)
      .join('\n\n---\n\n');

    if (!markdown || markdown.trim().length === 0) {
      throw new ParsingError('No readable content extracted from PDF document');
    }

    log.info('LlamaParse extraction completed', {
      pages: documents.length,
      markdownLength: markdown.length,
    });

    return markdown;
  } catch (error) {
    if (error instanceof ParsingError) throw error;
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('LlamaParse extraction failed', { error: err.message });
    throw new ParsingError(`LlamaParse failed: ${err.message}`, err);
  }
}