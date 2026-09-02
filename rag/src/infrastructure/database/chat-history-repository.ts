/**
 * Chat History Repository
 * 
 * Data access layer for the chat_history collection.
 * Persists conversation messages for the memory worker
 * to analyze and extract permanent user traits.
 * 
 * All operations enforce user + thread isolation to prevent
 * cross-tenant data leakage.
 * 
 * @module infrastructure/database/chat-history-repository
 */

import { getDatabase } from './mongodb-client';
import { ChatHistoryMessage } from './types';
import { CHAT_HISTORY_COLLECTION } from '@/config/constants';
import { createLogger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { getRequestContext } from '@/lib/request-context';
import { ObjectId } from 'mongodb';

const log = createLogger('ChatHistoryRepository');

/**
 * Appends a single message to the chat history.
 * Reads userId and threadId from AsyncLocalStorage context
 * set by the route handler via runWithContext().
 * 
 * @param userId - The Supabase-verified user ID
 * @param role - Message role ('user' or 'assistant')
 * @param content - Message text content
 */
export async function appendMessage(
  userId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  try {
    const db = await getDatabase();
    const collection = db.collection<ChatHistoryMessage>(CHAT_HISTORY_COLLECTION);

    // Read threadId from AsyncLocalStorage context.
    // The context is set by the route handler via runWithContext().
    const ctx = getRequestContext();
    const threadId = ctx?.threadId ?? 'default';

    await collection.insertOne({
      _id: new ObjectId(),
      userId,
      threadId,
      role,
      content,
      timestamp: new Date(),
    });

    log.debug('Chat message appended', { userId, threadId, role });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to append chat message', { userId, error: err.message });
    // Non-critical — don't throw, just log
  }
}

/**
 * Retrieves the most recent messages for a thread owned by a specific user.
 * Filters by BOTH userId and threadId for strict isolation.
 * 
 * @param userId - The Supabase-verified user ID
 * @param threadId - The conversation thread UUID
 * @param limit - Maximum number of messages to retrieve (default: 20)
 * @returns Array of chat messages, most recent last
 */
export async function getRecentMessages(
  userId: string,
  threadId: string,
  limit: number = 20
): Promise<ChatHistoryMessage[]> {
  try {
    const db = await getDatabase();
    const collection = db.collection<ChatHistoryMessage>(CHAT_HISTORY_COLLECTION);

    const messages = await collection
      .find({ userId, threadId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    // Reverse to get chronological order (oldest first)
    return messages.reverse();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to fetch recent messages', { userId, threadId, error: err.message });
    throw new DatabaseError(`Failed to fetch chat history: ${err.message}`, err);
  }
}

/**
 * Retrieves the most recent messages for a user across ALL threads.
 * Used by the memory summarization worker to build a holistic
 * user profile from their entire conversation history.
 * 
 * @param userId - The Supabase-verified user ID
 * @param limit - Maximum number of messages to retrieve (default: 30)
 * @returns Array of chat messages, most recent last
 */
export async function getRecentMessagesByUser(
  userId: string,
  limit: number = 30
): Promise<ChatHistoryMessage[]> {
  try {
    const db = await getDatabase();
    const collection = db.collection<ChatHistoryMessage>(CHAT_HISTORY_COLLECTION);

    const messages = await collection
      .find({ userId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    return messages.reverse();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to fetch user messages', { userId, error: err.message });
    throw new DatabaseError(`Failed to fetch user chat history: ${err.message}`, err);
  }
}

/**
 * Returns the total number of messages for a user across all threads.
 * Used to determine when to trigger memory summarization.
 * Memory summarization is user-scoped, not thread-scoped.
 * 
 * @param userId - The Supabase-verified user ID
 * @returns Total message count
 */
export async function getMessageCount(userId: string): Promise<number> {
  try {
    const db = await getDatabase();
    const collection = db.collection<ChatHistoryMessage>(CHAT_HISTORY_COLLECTION);
    return await collection.countDocuments({ userId });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to count messages', { userId, error: err.message });
    return 0;
  }
}

/**
 * Retrieves a list of unique chat threads for a specific user,
 * grouped by threadId, including the most recent message timestamp
 * and a content preview.
 * 
 * Filters by userId to ensure strict tenant isolation.
 * 
 * @param userId - The Supabase-verified user ID
 * @returns Array of chat threads sorted by most recent activity
 */
export async function getThreads(userId: string): Promise<{ threadId: string; lastUpdated: Date; preview: string }[]> {
  try {
    const db = await getDatabase();
    const collection = db.collection<ChatHistoryMessage>(CHAT_HISTORY_COLLECTION);
    
    const threads = await collection.aggregate([
      // Filter to only this user's messages
      { $match: { userId } },
      // Sort first so that $first within $group grabs the most recent message
      { $sort: { timestamp: -1 } },
      { 
        $group: { 
          _id: "$threadId", 
          lastUpdated: { $first: "$timestamp" }, 
          preview: { $first: "$content" } 
        } 
      },
      { $sort: { lastUpdated: -1 } }
    ]).toArray();
    
    return threads.map(t => ({
      threadId: t._id,
      lastUpdated: t.lastUpdated,
      preview: t.preview
    }));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to fetch chat threads', { userId, error: err.message });
    throw new DatabaseError(`Failed to fetch chat threads: ${err.message}`, err);
  }
}
