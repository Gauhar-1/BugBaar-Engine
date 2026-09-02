/**
 * RAG Evaluation CLI Runner
 *
 * Bootstraps the application context, loads the dataset, executes evaluations,
 * and generates Markdown & JSON reports.
 *
 * Usage: npm run eval
 */

// Force NVIDIA for the evaluator before environment variables are cached
// process.env.NVIDIA_CHAT_MODEL = 'meta/llama-3.3-70b-instruct';

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

import { RagEvaluator, TestCase, TestCaseResult } from './RagEvaluator';
import { RAGPipelineService } from '@/services/RAGPipelineService';
import { HybridRetrievalService } from '@/services/HybridRetrievalService';
import { SecurityGuardrailService } from '@/services/SecurityGuardrailService';
import { PromptBuilderService } from '@/services/PromptBuilderService';
import { MongoVectorStore } from '@/providers/MongoVectorStore';
import { CohereReranker } from '@/providers/CohereReranker';
import { OpenAIEmbeddingProvider } from '@/providers/OpenAIEmbeddingProvider';
import { NvidiaEmbeddingProvider } from '@/providers/NvidiaEmbeddingProvider';
import { OpenAILLMProvider } from '@/providers/OpenAILLMProvider';
import { NvidiaLLMProvider } from '@/providers/NvidiaLLMProvider';
import { getDatabase } from '@/infrastructure/database/mongodb-client';
import { getEmbeddingProvider } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('RunEval');

const DATASET_PATH = path.resolve(__dirname, '../../tests/eval/rag-eval-dataset.json');
const REPORTS_DIR = path.resolve(__dirname, '../../tests/eval/reports');

// Bootstrap RAG Pipeline
function bootstrapRagPipeline(): RAGPipelineService {
  log.info('Bootstrapping internal RAG Pipeline for evaluation');
  
  const providerType = getEmbeddingProvider();
  const embeddingProvider = providerType === 'openai' ? new OpenAIEmbeddingProvider() : new NvidiaEmbeddingProvider();
  
  // NOTE: This llmProvider is for the system being tested, NOT the judge.
  // The system being tested will use whatever is in .env
  const llmProvider = providerType === 'openai' ? new OpenAILLMProvider() : new NvidiaLLMProvider();
  
  const vectorStore = new MongoVectorStore(getDatabase);
  const reranker = new CohereReranker();
  const guardrail = new SecurityGuardrailService();
  const promptBuilder = new PromptBuilderService();
  const hybridRetrieval = new HybridRetrievalService(vectorStore, embeddingProvider, reranker);
  
  return new RAGPipelineService(
    embeddingProvider,
    hybridRetrieval,
    llmProvider,
    guardrail,
    promptBuilder
  );
}

function formatScore(score: number | null): string {
  if (score === null) return 'N/A (API Overloaded)';
  return score.toString();
}

function generateMarkdownReport(results: TestCaseResult[], avgScores: Record<string, number>): string {
  let md = `# RAG Evaluation Report\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n\n`;
  
  md += `## Aggregate Scores\n\n`;
  md += `| Metric | Average Score |\n`;
  md += `|---|---|\n`;
  md += `| Context Precision | ${(avgScores.contextPrecision * 100).toFixed(1)}% |\n`;
  md += `| Context Recall | ${(avgScores.contextRecall * 100).toFixed(1)}% |\n`;
  md += `| Faithfulness | ${(avgScores.faithfulness * 100).toFixed(1)}% |\n`;
  md += `| Answer Relevancy | ${(avgScores.answerRelevancy * 100).toFixed(1)}% |\n`;
  md += `| Answer Correctness | ${(avgScores.answerCorrectness * 100).toFixed(1)}% |\n\n`;

  md += `## Detailed Test Cases\n\n`;

  results.forEach((res, i) => {
    md += `### Test Case ${i + 1}\n\n`;
    md += `**Question:** ${res.question}\n\n`;
    md += `**Ground Truth:** ${res.ground_truth}\n\n`;
    md += `**Generated Answer:** ${res.generated_answer}\n\n`;

    md += `#### Metrics\n\n`;
    md += `- **Context Precision:** ${formatScore(res.contextPrecision.score)} (${res.contextPrecision.reasoning})\n`;
    md += `- **Context Recall:** ${formatScore(res.contextRecall.score)} (${res.contextRecall.reasoning})\n`;
    md += `- **Faithfulness:** ${formatScore(res.faithfulness.score)} (${res.faithfulness.reasoning})\n`;
    md += `- **Answer Relevancy:** ${formatScore(res.answerRelevancy.score)} (${res.answerRelevancy.reasoning})\n`;
    md += `- **Answer Correctness:** ${formatScore(res.answerCorrectness.score)} (${res.answerCorrectness.reasoning})\n\n`;
    md += `---\n\n`;
  });

  return md;
}

async function run() {
  log.info('Starting LLM-as-a-judge Evaluation Suite');

  if (!fs.existsSync(DATASET_PATH)) {
    log.error('Dataset not found', { path: DATASET_PATH });
    process.exit(1);
  }

  const rawData = fs.readFileSync(DATASET_PATH, 'utf-8');
  const dataset = JSON.parse(rawData) as TestCase[];

  const pipeline = bootstrapRagPipeline();
  const evaluator = new RagEvaluator(pipeline);

  // Ensure reports dir exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const jsonProgressPath = path.join(REPORTS_DIR, `eval-report-in-progress.json`);
  const mdProgressPath = path.join(REPORTS_DIR, `eval-report-in-progress.md`);

  const calculateAverages = (currentResults: TestCaseResult[]) => {
    const totals = { cp: 0, cr: 0, f: 0, ar: 0, ac: 0 };
    const counts = { cp: 0, cr: 0, f: 0, ar: 0, ac: 0 };

    for (const res of currentResults) {
      if (res.contextPrecision.score !== null) { totals.cp += res.contextPrecision.score; counts.cp++; }
      if (res.contextRecall.score !== null) { totals.cr += res.contextRecall.score; counts.cr++; }
      if (res.faithfulness.score !== null) { totals.f += res.faithfulness.score; counts.f++; }
      if (res.answerRelevancy.score !== null) { totals.ar += res.answerRelevancy.score; counts.ar++; }
      if (res.answerCorrectness.score !== null) { totals.ac += res.answerCorrectness.score; counts.ac++; }
    }

    return {
      contextPrecision: counts.cp > 0 ? totals.cp / counts.cp : 0,
      contextRecall: counts.cr > 0 ? totals.cr / counts.cr : 0,
      faithfulness: counts.f > 0 ? totals.f / counts.f : 0,
      answerRelevancy: counts.ar > 0 ? totals.ar / counts.ar : 0,
      answerCorrectness: counts.ac > 0 ? totals.ac / counts.ac : 0,
    };
  };

  const results: TestCaseResult[] = [];

  for (let i = 0; i < dataset.length; i++) {
    log.info(`Evaluating Test Case ${i + 1}/${dataset.length}`);
    try {
      const result = await evaluator.evaluateTestCase(dataset[i], i + 1);
      results.push(result);

      // Incremental Persistence
      const avgScores = calculateAverages(results);
      fs.writeFileSync(jsonProgressPath, JSON.stringify({ avgScores, results }, null, 2));
      fs.writeFileSync(mdProgressPath, generateMarkdownReport(results, avgScores));

    } catch (err) {
      log.error(`Evaluation crashed for test case ${i + 1}`, {
        error: (err as Error).message,
      });
      // Do not abort entirely if one crashes hard
    }
  }

  const finalAvgScores = calculateAverages(results);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  const finalJsonPath = path.join(REPORTS_DIR, `eval-report-${timestamp}.json`);
  const finalMdPath = path.join(REPORTS_DIR, `eval-report-${timestamp}.md`);

  // Rename progress files to final timestamped files
  if (fs.existsSync(jsonProgressPath)) fs.renameSync(jsonProgressPath, finalJsonPath);
  if (fs.existsSync(mdProgressPath)) fs.renameSync(mdProgressPath, finalMdPath);

  log.info(`Evaluation Suite Completed. Reports saved to ${REPORTS_DIR}`);
  process.exit(0);
}

run().catch((err) => {
  log.error('Fatal error during evaluation', { error: err.message });
  process.exit(1);
});
