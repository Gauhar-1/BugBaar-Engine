/**
 * Markdown-Aware Structural Chunker
 * 
 * Splits LlamaParse Markdown output into semantically coherent chunks
 * that respect document structure:
 * - Never splits mid-table
 * - Preserves heading hierarchy as breadcrumbs
 * - Identifies chunk types (text, table, image_description, heading_section)
 * - Produces parent-child relationships for complex content
 * 
 * @module infrastructure/parsing/markdown-chunker
 */

import { createLogger } from '@/lib/logger';
import { CHUNK_MAX_CHARS } from '@/config/constants';

const log = createLogger('MarkdownChunker');

/**
 * A structured chunk produced from Markdown splitting.
 */
export interface StructuredChunk {
  /** Unique chunk identifier within the document */
  id: string;
  /** Content classification */
  type: 'text' | 'table' | 'image_description' | 'heading_section';
  /** The content to be vectorized (summary for tables, full text for others) */
  content: string;
  /** Full raw Markdown of the parent content (for tables: the actual table) */
  parentContent?: string;
  /** Heading hierarchy breadcrumb path */
  headingPath: string[];
  /** Chunk metadata */
  metadata: {
    filename: string;
    chunkIndex: number;
    hasTable: boolean;
    hasImage: boolean;
    isChildSummary: boolean;
  };
}

/**
 * Regex patterns for identifying Markdown structural elements.
 */
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;
const TABLE_ROW_REGEX = /^\|.+\|$/;
const TABLE_SEPARATOR_REGEX = /^\|[\s\-:|]+\|$/;
const IMAGE_REGEX = /^!\[([^\]]*)\]\(([^)]+)\)/;

/**
 * Splits a Markdown document into structured chunks that respect
 * document boundaries (headers, tables, images).
 * 
 * @param markdown - The full Markdown content from LlamaParse
 * @param filename - Source filename for metadata
 * @param maxChunkChars - Maximum characters per chunk (default: CHUNK_MAX_CHARS)
 * @returns Array of structured chunks ready for embedding
 */
export function splitMarkdownIntoChunks(
  markdown: string,
  filename: string,
  maxChunkChars: number = CHUNK_MAX_CHARS
): StructuredChunk[] {
  log.info('Splitting Markdown into structural chunks', {
    filename,
    markdownLength: markdown.length,
    maxChunkChars,
  });

  const lines = markdown.split('\n');
  const sections = extractSections(lines);
  const chunks: StructuredChunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const sectionChunks = processSection(section, filename, maxChunkChars, chunkIndex);
    chunks.push(...sectionChunks);
    chunkIndex += sectionChunks.length;
  }

  log.info('Markdown chunking completed', {
    filename,
    totalChunks: chunks.length,
    tables: chunks.filter(c => c.type === 'table').length,
    images: chunks.filter(c => c.type === 'image_description').length,
  });

  return chunks;
}

// ─── Internal Types ─────────────────────────────────────────────────────────

interface Section {
  headingPath: string[];
  content: string;
  hasTable: boolean;
  hasImage: boolean;
}

// ─── Section Extraction ─────────────────────────────────────────────────────

/**
 * Parses Markdown lines into sections delineated by headings,
 * tracking the heading hierarchy as a breadcrumb path.
 */
function extractSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  const currentHeadingPath: string[] = [];
  let currentContent: string[] = [];
  let currentHasTable = false;
  let currentHasImage = false;

  function flushSection() {
    const content = currentContent.join('\n').trim();
    if (content.length > 0) {
      sections.push({
        headingPath: [...currentHeadingPath],
        content,
        hasTable: currentHasTable,
        hasImage: currentHasImage,
      });
    }
    currentContent = [];
    currentHasTable = false;
    currentHasImage = false;
  }

  for (const line of lines) {
    const headingMatch = line.match(HEADING_REGEX);

    if (headingMatch) {
      // Flush previous section before starting new one
      flushSection();

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Adjust heading path: truncate to current level and append
      while (currentHeadingPath.length >= level) {
        currentHeadingPath.pop();
      }
      currentHeadingPath.push(title);

      // Include the heading itself in the new section
      currentContent.push(line);
    } else {
      currentContent.push(line);

      if (TABLE_ROW_REGEX.test(line.trim())) {
        currentHasTable = true;
      }
      if (IMAGE_REGEX.test(line.trim())) {
        currentHasImage = true;
      }
    }
  }

  // Flush the last section
  flushSection();

  return sections;
}

// ─── Section Processing ─────────────────────────────────────────────────────

/**
 * Processes a single section into one or more chunks.
 * Tables and images are extracted as separate chunks;
 * large text sections are split by sentence boundaries.
 */
function processSection(
  section: Section,
  filename: string,
  maxChunkChars: number,
  startIndex: number
): StructuredChunk[] {
  const chunks: StructuredChunk[] = [];
  let chunkIndex = startIndex;

  // Extract tables as dedicated chunks (never split mid-table)
  if (section.hasTable) {
    const { tables, remainingText } = extractTables(section.content);

    for (const table of tables) {
      chunks.push({
        id: `${filename}:chunk-${chunkIndex}`,
        type: 'table',
        content: table, // Will be replaced by summary after AI summarization
        parentContent: table, // Raw table preserved for parent-child retrieval
        headingPath: section.headingPath,
        metadata: {
          filename,
          chunkIndex,
          hasTable: true,
          hasImage: false,
          isChildSummary: false, // Will be set to true after summary generation
        },
      });
      chunkIndex++;
    }

    // Process remaining non-table text
    if (remainingText.trim().length > 0) {
      const textChunks = splitTextBySize(remainingText, maxChunkChars);
      for (const text of textChunks) {
        chunks.push({
          id: `${filename}:chunk-${chunkIndex}`,
          type: 'text',
          content: text,
          headingPath: section.headingPath,
          metadata: {
            filename,
            chunkIndex,
            hasTable: false,
            hasImage: false,
            isChildSummary: false,
          },
        });
        chunkIndex++;
      }
    }
  }
  // Extract image descriptions
  else if (section.hasImage) {
    const imageChunks = extractImageDescriptions(section.content);
    for (const desc of imageChunks) {
      chunks.push({
        id: `${filename}:chunk-${chunkIndex}`,
        type: 'image_description',
        content: desc,
        headingPath: section.headingPath,
        metadata: {
          filename,
          chunkIndex,
          hasTable: false,
          hasImage: true,
          isChildSummary: false,
        },
      });
      chunkIndex++;
    }
  }
  // Plain text section
  else {
    const textChunks = splitTextBySize(section.content, maxChunkChars);
    for (const text of textChunks) {
      chunks.push({
        id: `${filename}:chunk-${chunkIndex}`,
        type: section.headingPath.length > 0 ? 'heading_section' : 'text',
        content: text,
        headingPath: section.headingPath,
        metadata: {
          filename,
          chunkIndex,
          hasTable: false,
          hasImage: false,
          isChildSummary: false,
        },
      });
      chunkIndex++;
    }
  }

  return chunks;
}

// ─── Table Extraction ───────────────────────────────────────────────────────

/**
 * Extracts complete Markdown tables from content,
 * returning them separately from surrounding text.
 */
function extractTables(content: string): { tables: string[]; remainingText: string } {
  const lines = content.split('\n');
  const tables: string[] = [];
  const nonTableLines: string[] = [];
  let currentTable: string[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isTableRow = TABLE_ROW_REGEX.test(trimmed);
    const isSeparator = TABLE_SEPARATOR_REGEX.test(trimmed);

    if (isTableRow || isSeparator) {
      if (!inTable) {
        inTable = true;
      }
      currentTable.push(line);
    } else {
      if (inTable) {
        // End of table
        if (currentTable.length >= 2) {
          tables.push(currentTable.join('\n'));
        } else {
          // Not a real table, just pipe characters
          nonTableLines.push(...currentTable);
        }
        currentTable = [];
        inTable = false;
      }
      nonTableLines.push(line);
    }
  }

  // Flush last table
  if (inTable && currentTable.length >= 2) {
    tables.push(currentTable.join('\n'));
  } else if (currentTable.length > 0) {
    nonTableLines.push(...currentTable);
  }

  return { tables, remainingText: nonTableLines.join('\n') };
}

// ─── Image Description Extraction ───────────────────────────────────────────

/**
 * Extracts image alt-text descriptions from Markdown image syntax.
 */
function extractImageDescriptions(content: string): string[] {
  const descriptions: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.trim().match(IMAGE_REGEX);
    if (match) {
      const altText = match[1];
      const url = match[2];
      descriptions.push(`Image: ${altText || 'No description'}. Source: ${url}`);
    }
  }

  // If no explicit image syntax found, treat the whole section as description
  if (descriptions.length === 0) {
    descriptions.push(content);
  }

  return descriptions;
}

// ─── Text Splitting ─────────────────────────────────────────────────────────

/**
 * Splits text into chunks by paragraph boundaries, then by sentences,
 * respecting the maximum character limit.
 */
function splitTextBySize(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= maxChars) return [normalized];

  // Split by paragraphs first
  const paragraphs = normalized.split('\n\n').filter(p => p.trim().length > 0);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      // Flush current
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // Split oversized paragraph by sentences
      const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
      let sentenceChunk = '';
      for (const sentence of sentences) {
        if ((sentenceChunk.length + sentence.length) > maxChars && sentenceChunk.trim()) {
          chunks.push(sentenceChunk.trim());
          sentenceChunk = '';
        }
        sentenceChunk += sentence + ' ';
      }
      if (sentenceChunk.trim()) {
        chunks.push(sentenceChunk.trim());
      }
    } else if ((currentChunk.length + paragraph.length + 2) > maxChars && currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph + '\n\n';
    } else {
      currentChunk += paragraph + '\n\n';
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
