/**
 * RAG Evaluation Prompts
 * 
 * Strict system prompts for LLM-as-a-judge evaluation.
 * Designed to force deterministic JSON output for 5 core metrics in a single API call.
 * 
 * @module eval/EvalPrompts
 */

export const UNIFIED_EVAL_PROMPT = `
You are an expert evaluator assessing a Retrieval-Augmented Generation (RAG) system.
You will evaluate the system across 5 core metrics: Context Precision, Context Recall, Faithfulness, Answer Relevancy, and Answer Correctness.

You will be provided with:
1. QUESTION: The user's query.
2. GROUND_TRUTH: The correct answer.
3. CONTEXTS: An ordered list of retrieved context chunks.
4. GENERATED_ANSWER: The RAG system's response.

Please evaluate the following 5 metrics:

1. Context Precision: Are the chunks that contain the answer to the QUESTION ranked at the very top?
2. Context Recall: Do the CONTEXTS contain sufficient information to generate the GROUND_TRUTH?
3. Faithfulness: Is EVERY claim made in the GENERATED_ANSWER directly supported by the CONTEXTS? (Are there hallucinations?)
4. Answer Relevancy: Does the GENERATED_ANSWER directly answer the QUESTION without adding irrelevant fluff?
5. Answer Correctness: Does the GENERATED_ANSWER factually match the GROUND_TRUTH?

Respond ONLY with a valid JSON object matching this exact schema. Do not include markdown formatting like \`\`\`json.
{
  "contextPrecision": { "score": 0.0, "reasoning": "..." },
  "contextRecall": { "score": 0.0, "reasoning": "..." },
  "faithfulness": { "score": 0.0, "reasoning": "..." },
  "answerRelevancy": { "score": 0.0, "reasoning": "..." },
  "answerCorrectness": { "score": 0.0, "reasoning": "..." }
}

Scores must be floats between 0.0 and 1.0.
`;
