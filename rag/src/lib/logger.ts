/**
 * Structured Logger
 * 
 * Lightweight logging utility with level-based filtering,
 * timestamps, and contextual module tagging.
 * 
 * In production, only WARN and ERROR levels are emitted.
 * In development, all levels are active.
 * 
 * @module lib/logger
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const MIN_LEVEL: LogLevel = process.env.NODE_ENV === 'production' ? 'WARN' : 'DEBUG';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[MIN_LEVEL];
}

function formatEntry(entry: LogEntry): string {
  const base = `[${entry.timestamp}] [${entry.level}] [${entry.module}] ${entry.message}`;
  if (entry.data && Object.keys(entry.data).length > 0) {
    return `${base} ${JSON.stringify(entry.data)}`;
  }
  return base;
}

/**
 * Creates a scoped logger instance for a specific module.
 * 
 * @example
 * ```ts
 * const log = createLogger('RAGPipeline');
 * log.info('Processing query', { query: 'summer dress' });
 * log.error('Embedding failed', { error: err.message });
 * ```
 */
export function createLogger(module: string) {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      data,
    };

    const formatted = formatEntry(entry);

    switch (level) {
      case 'ERROR':
        console.error(formatted);
        break;
      case 'WARN':
        console.warn(formatted);
        break;
      case 'DEBUG':
        console.debug(formatted);
        break;
      default:
        console.log(formatted);
    }
  };

  return {
    debug: (message: string, data?: Record<string, unknown>) => log('DEBUG', message, data),
    info: (message: string, data?: Record<string, unknown>) => log('INFO', message, data),
    warn: (message: string, data?: Record<string, unknown>) => log('WARN', message, data),
    error: (message: string, data?: Record<string, unknown>) => log('ERROR', message, data),
  };
}
