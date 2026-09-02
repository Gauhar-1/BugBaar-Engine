/**
 * Request Context (AsyncLocalStorage)
 * 
 * Provides a request-scoped context for threading userId and threadId
 * through the call stack without modifying intermediate function signatures.
 * 
 * This enables the chat-history-repository to read isolation fields
 * (userId, threadId) even when called by the RAG pipeline, which
 * cannot be modified per project constraints.
 * 
 * @module lib/request-context
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Shape of the per-request context carrying tenant isolation fields.
 */
export interface RequestContext {
  /** Supabase-verified user ID */
  userId: string;
  /** Per-conversation thread UUID */
  threadId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Executes a function within a request-scoped context.
 * All synchronous and asynchronous code called within `fn`
 * can retrieve the context via `getRequestContext()`.
 * 
 * @param ctx - The isolation context (userId + threadId)
 * @param fn - The function to execute within this context
 * @returns The return value of `fn`
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Retrieves the current request context, if one has been set
 * via `runWithContext`. Returns `undefined` if called outside
 * a context scope (e.g., during background jobs or tests).
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
