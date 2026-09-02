/**
 * RagEvaluator
 *
 * Core engine for running evaluations.
 * Instantiates the NvidiaLLMProvider with a specific Judge model (Llama 3.3 70B)
 * and evaluates a query against 5 core RAG metrics.
 *
 * @module eval/RagEvaluator
 */

import { RAGPipelineService } from '@/services/RAGPipelineService';
import { getJudgeLlmModel, getNvidiaApiKey, getNvidiaBaseUrl } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { withRetry } from '@/infrastructure/nvidia/retry-handler';
import { UNIFIED_EVAL_PROMPT } from './EvalPrompts';
import { parseJsonResponse, EvalMetricResult } from './EvalUtils';
import { ProductSearchResult, DocumentSearchResult } from '@/types';

const log = createLogger('RagEvaluator');

export interface TestCase {
  question: string;
  ground_truth: string;
}

export interface TestCaseResult {
  question: string;
  ground_truth: string;
  generated_answer: string;
  contextPrecision: EvalMetricResult;
  contextRecall: EvalMetricResult;
  faithfulness: EvalMetricResult;
  answerRelevancy: EvalMetricResult;
  answerCorrectness: EvalMetricResult;
}

export class RagEvaluator {
  constructor(private readonly ragPipeline: RAGPipelineService) {}

  /**
   * Formats context chunks into a numbered list string.
   */
  private formatContexts(products: ProductSearchResult[], documents: DocumentSearchResult[]): string {
    let output = '';
    let index = 1;

    for (const p of products) {
      output += `[${index}] Product: ${p.name} - ${p.description}\n`;
      index++;
    }

    for (const d of documents) {
      output += `[${index}] Document: ${d.parentContent ?? d.text}\n`;
      index++;
    }

    return output.trim() || 'No context retrieved.';
  }

  private async generateJudgeCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
    const baseUrl = getNvidiaBaseUrl();
    const apiKey = getNvidiaApiKey();
    const model = getJudgeLlmModel();

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_object' }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Judge API error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  private async evaluateAllMetrics(systemPrompt: string, userPrompt: string): Promise<any> {
    log.info(`Evaluating all metrics in a single judge call`);

    try {
      return await withRetry(
        async () => {
          const responseText = await this.generateJudgeCompletion(systemPrompt, userPrompt);
          return parseJsonResponse(responseText);
        },
        { operationName: `EvalMetrics_Unified`, maxAttempts: 3 }
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Evaluation completely failed`, { error: err.message });
      const failMetric = { score: null, reasoning: `API Overloaded/Failed: ${err.message}` };
      return {
        contextPrecision: failMetric,
        contextRecall: failMetric,
        faithfulness: failMetric,
        answerRelevancy: failMetric,
        answerCorrectness: failMetric,
      };
    }
  }

  /**
   * Evaluates a single test case sequentially.
   */
  async evaluateTestCase(testCase: TestCase, index: number): Promise<TestCaseResult> {
    log.info('Starting test case evaluation', { question: testCase.question, index });

    // 1. Run the RAG Pipeline to get context and answer with a strict 300 maxToken cap
    const ragResponse = await this.ragPipeline.execute({
      messages: [{ role: 'user', content: testCase.question }]
    }, { maxTokens: 300 });

    const generatedAnswer = ragResponse.answer;
    const retrievedProducts = ragResponse.context.retrievedProducts;
    const retrievedDocuments = ragResponse.context.retrievedDocuments;
    
    // Immediate early logging of Generation
    log.info(`[TestCase ${index}] Generated Answer: ${generatedAnswer}`);
    log.info(`[TestCase ${index}] Retrieved ${retrievedProducts.length + retrievedDocuments.length} chunks`);

    let contextsString = this.formatContexts(retrievedProducts, retrievedDocuments);
    if (contextsString.length > 3000) {
      log.debug('Truncating contexts string for Judge LLM to 3000 characters');
      contextsString = contextsString.substring(0, 3000) + '\n...[TRUNCATED]';
    }

    // 2. Run all evaluation metrics in a single judge call to bypass rate limits
    const userPrompt = `QUESTION: ${testCase.question}\nGROUND_TRUTH: ${testCase.ground_truth}\nCONTEXTS:\n${contextsString}\nGENERATED_ANSWER: ${generatedAnswer}`;
    
    const scores = await this.evaluateAllMetrics(UNIFIED_EVAL_PROMPT, userPrompt);

    log.info('Test case evaluation completed', { question: testCase.question });

    return {
      question: testCase.question,
      ground_truth: testCase.ground_truth,
      generated_answer: generatedAnswer,
      contextPrecision: scores.contextPrecision || { score: null, reasoning: 'Failed to parse' },
      contextRecall: scores.contextRecall || { score: null, reasoning: 'Failed to parse' },
      faithfulness: scores.faithfulness || { score: null, reasoning: 'Failed to parse' },
      answerRelevancy: scores.answerRelevancy || { score: null, reasoning: 'Failed to parse' },
      answerCorrectness: scores.answerCorrectness || { score: null, reasoning: 'Failed to parse' },
    };
  }
}
