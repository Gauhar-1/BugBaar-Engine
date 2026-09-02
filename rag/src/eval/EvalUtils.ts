/**
 * Evaluation Utilities
 *
 * Provides resilient JSON parsing to handle LLM quirks (like markdown blocks).
 *
 * @module eval/EvalUtils
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('EvalUtils');

export interface EvalMetricResult {
  score: number | null;
  reasoning: string;
}

/**
 * Robustly parses a JSON string returned by an LLM.
 * Strips markdown and conversational text, and validates the 5 metric schema.
 */
export function parseJsonResponse(raw: string): any {
  // Safe default fallback
  const fallbackMetric = { score: null, reasoning: 'Failed to parse LLM response' };
  const defaultFallback = {
    contextPrecision: { ...fallbackMetric },
    contextRecall: { ...fallbackMetric },
    faithfulness: { ...fallbackMetric },
    answerRelevancy: { ...fallbackMetric },
    answerCorrectness: { ...fallbackMetric }
  };

  try {
    let cleaned = raw;
    
    // Markdown / Conversational text stripping: find first { and last }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    } else {
      throw new Error('No JSON object found in response');
    }

    const parsed = JSON.parse(cleaned);
    const requiredKeys = ['contextPrecision', 'contextRecall', 'faithfulness', 'answerRelevancy', 'answerCorrectness'];
    
    for (const key of requiredKeys) {
      if (!parsed[key] || typeof parsed[key] !== 'object') {
        throw new Error(`Missing or invalid key: ${key}`);
      }
      
      const metric = parsed[key];
      if (typeof metric.score !== 'number' && metric.score !== null) {
        throw new Error(`Invalid score for ${key}`);
      }
      if (typeof metric.reasoning !== 'string') {
        throw new Error(`Invalid reasoning for ${key}`);
      }
      
      // Clamp valid numeric scores
      if (typeof metric.score === 'number') {
        metric.score = Math.max(0, Math.min(1, metric.score));
      }
    }
    
    return parsed;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to parse unified LLM JSON response', { raw, error: err.message });
    return defaultFallback;
  }
}
