/**
 * Environment Configuration
 *
 * Centralized, validated access to all environment variables.
 * Throws descriptive errors at startup if required vars are missing.
 *
 * @module config/env
 */

interface EnvConfig {
  // ── Server ────────────────────────────────────────────────────────────────
  PORT: number;
  NODE_ENV: string;

  // ── MongoDB ───────────────────────────────────────────────────────────────
  MONGODB_URI: string;
  MONGODB_DB_NAME: string;

  // ── OpenAI ────────────────────────────────────────────────────────────────
  OPENAI_API_KEY: string;
  OPENAI_CHAT_MODEL: string;
  OPENAI_EMBED_MODEL: string;
  OPENAI_SUMMARIZATION_MODEL: string;

  // ── NVIDIA NIM (alternative embedding/LLM provider) ───────────────────────
  NVIDIA_API_KEY: string;
  NVIDIA_BASE_URL: string;
  NVIDIA_CHAT_MODEL: string;
  NVIDIA_EMBED_MODEL: string;
  NVIDIA_SUMMARIZATION_MODEL: string;
  JUDGE_LLM_MODEL: string;

  // ── Cohere ────────────────────────────────────────────────────────────────
  COHERE_API_KEY: string;
  COHERE_RERANK_MODEL: string;

  // ── Cloudinary ────────────────────────────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
  CLOUDINARY_FOLDER: string;

  // ── Redis / BullMQ ────────────────────────────────────────────────────────
  REDIS_URL: string;

  // ── LlamaParse ────────────────────────────────────────────────────────────
  LLAMA_CLOUD_API_KEY: string;

  // ── Provider Selection ────────────────────────────────────────────────────
  /** 'openai' | 'nvidia' — selects IEmbeddingProvider implementation at startup */
  EMBEDDING_PROVIDER: 'openai' | 'nvidia';

  // ── Observability ─────────────────────────────────────────────────────────
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_BASE_URL: string;
}

/**
 * Retrieves and validates a required environment variable.
 * @throws {Error} If the variable is not set or is empty.
 */
function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(
      `[ENV] Missing required environment variable: ${key}. ` +
        `Please add it to your .env file. See .env.example for reference.`
    );
  }
  return value.trim();
}

/**
 * Retrieves an optional environment variable with a default fallback.
 */
function getOptionalEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value && value.trim() !== '' ? value.trim() : defaultValue;
}

/** Lazily-cached configuration singleton. Only validates on first access. */
let _cachedConfig: EnvConfig | null = null;

export function getEnvConfig(): EnvConfig {
  if (_cachedConfig) return _cachedConfig;

  const rawProvider = getOptionalEnv('EMBEDDING_PROVIDER', 'openai');
  if (rawProvider !== 'openai' && rawProvider !== 'nvidia') {
    throw new Error(`[ENV] EMBEDDING_PROVIDER must be 'openai' or 'nvidia', got: '${rawProvider}'`);
  }

  _cachedConfig = {
    PORT: parseInt(getOptionalEnv('PORT', '3001'), 10),
    NODE_ENV: getOptionalEnv('NODE_ENV', 'development'),

    MONGODB_URI: getRequiredEnv('MONGODB_URI'),
    MONGODB_DB_NAME: getOptionalEnv('MONGODB_DB_NAME', 'ecrs_apparel'),

    OPENAI_API_KEY: getOptionalEnv('OPENAI_API_KEY', ''),
    OPENAI_CHAT_MODEL: getOptionalEnv('OPENAI_CHAT_MODEL', 'gpt-4o'),
    OPENAI_EMBED_MODEL: getOptionalEnv('OPENAI_EMBED_MODEL', 'text-embedding-3-small'),
    OPENAI_SUMMARIZATION_MODEL: getOptionalEnv('OPENAI_SUMMARIZATION_MODEL', 'gpt-4o-mini'),

    NVIDIA_API_KEY: getOptionalEnv('NVIDIA_API_KEY', ''),
    NVIDIA_BASE_URL: getOptionalEnv('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
    NVIDIA_CHAT_MODEL: getOptionalEnv('NVIDIA_CHAT_MODEL', 'nvidia/nemotron-3-ultra-550b-a55b'),
    NVIDIA_EMBED_MODEL: getOptionalEnv('NVIDIA_EMBED_MODEL', 'nvidia/llama-nemotron-embed-1b-v2'),
    NVIDIA_SUMMARIZATION_MODEL: getOptionalEnv('NVIDIA_SUMMARIZATION_MODEL', 'meta/llama-3.1-8b-instruct'),
    JUDGE_LLM_MODEL: getOptionalEnv('JUDGE_LLM_MODEL', 'meta/llama-3.2-3b-instruct'),

    COHERE_API_KEY: getOptionalEnv('COHERE_API_KEY', ''),
    COHERE_RERANK_MODEL: getOptionalEnv('COHERE_RERANK_MODEL', 'rerank-english-v3.0'),

    CLOUDINARY_CLOUD_NAME: getOptionalEnv('CLOUDINARY_CLOUD_NAME', ''),
    CLOUDINARY_API_KEY: getOptionalEnv('CLOUDINARY_API_KEY', ''),
    CLOUDINARY_API_SECRET: getOptionalEnv('CLOUDINARY_API_SECRET', ''),
    CLOUDINARY_FOLDER: getOptionalEnv('CLOUDINARY_FOLDER', 'bugbaar-documents'),

    REDIS_URL: getOptionalEnv('REDIS_URL', 'redis://localhost:6379'),

    LLAMA_CLOUD_API_KEY: getOptionalEnv('LLAMA_CLOUD_API_KEY', ''),

    EMBEDDING_PROVIDER: rawProvider,

    LANGFUSE_SECRET_KEY: getOptionalEnv('LANGFUSE_SECRET_KEY', ''),
    LANGFUSE_PUBLIC_KEY: getOptionalEnv('LANGFUSE_PUBLIC_KEY', ''),
    LANGFUSE_BASE_URL: getOptionalEnv('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com'),
  };

  return _cachedConfig;
}

// ─── Typed Accessors ──────────────────────────────────────────────────────────

export const getPort = () => getEnvConfig().PORT;
export const getMongoUri = () => getEnvConfig().MONGODB_URI;
export const getMongoDbName = () => getEnvConfig().MONGODB_DB_NAME;

export const getOpenAiApiKey = () => getEnvConfig().OPENAI_API_KEY;
export const getOpenAiChatModel = () => getEnvConfig().OPENAI_CHAT_MODEL;
export const getOpenAiEmbedModel = () => getEnvConfig().OPENAI_EMBED_MODEL;
export const getOpenAiSummarizationModel = () => getEnvConfig().OPENAI_SUMMARIZATION_MODEL;

export const getNvidiaApiKey = () => getEnvConfig().NVIDIA_API_KEY;
export const getNvidiaBaseUrl = () => getEnvConfig().NVIDIA_BASE_URL;
export const getNvidiaChatModel = () => getEnvConfig().NVIDIA_CHAT_MODEL;
export const getNvidiaEmbedModel = () => getEnvConfig().NVIDIA_EMBED_MODEL;
export const getNvidiaSummarizationModel = () => getEnvConfig().NVIDIA_SUMMARIZATION_MODEL;
export const getJudgeLlmModel = () => getEnvConfig().JUDGE_LLM_MODEL;

export const getCohereApiKey = () => getEnvConfig().COHERE_API_KEY;
export const getCohereRerankModel = () => getEnvConfig().COHERE_RERANK_MODEL;

export const getCloudinaryCloudName = () => getEnvConfig().CLOUDINARY_CLOUD_NAME;
export const getCloudinaryApiKey = () => getEnvConfig().CLOUDINARY_API_KEY;
export const getCloudinaryApiSecret = () => getEnvConfig().CLOUDINARY_API_SECRET;
export const getCloudinaryFolder = () => getEnvConfig().CLOUDINARY_FOLDER;

export const getRedisUrl = () => getEnvConfig().REDIS_URL;
export const getLlamaCloudApiKey = () => getEnvConfig().LLAMA_CLOUD_API_KEY;
export const getEmbeddingProvider = () => getEnvConfig().EMBEDDING_PROVIDER;

export const isDevelopment = () => getEnvConfig().NODE_ENV === 'development';
export const getLangfuseSecretKey = () => getEnvConfig().LANGFUSE_SECRET_KEY;
export const getLangfusePublicKey = () => getEnvConfig().LANGFUSE_PUBLIC_KEY;
export const getLangfuseBaseUrl = () => getEnvConfig().LANGFUSE_BASE_URL;
export const isLangfuseEnabled = () =>
  !!getEnvConfig().LANGFUSE_SECRET_KEY && !!getEnvConfig().LANGFUSE_PUBLIC_KEY;
