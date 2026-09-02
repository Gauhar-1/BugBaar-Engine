/**
 * MongoDB Client Singleton
 *
 * Implements the singleton pattern for MongoDB connections.
 * Uses module-level caching suitable for long-running Express servers.
 * (Removed Next.js HMR global hack — not needed in a standard Node.js process)
 *
 * @module infrastructure/database/mongodb-client
 */

import { MongoClient, Db } from 'mongodb';
import { getMongoUri, getMongoDbName } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';

const log = createLogger('MongoDBClient');

/** MongoDB client connection options */
const CLIENT_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 30000,
  connectTimeoutMS: 10000,
  serverSelectionTimeoutMS: 10000,
};

// Module-level singleton (safe for a persistent Express process)
let _clientPromise: Promise<MongoClient> | null = null;

/**
 * Returns the cached MongoClient promise.
 * Creates the client on first call; reuses on subsequent calls.
 */
function getClientPromise(): Promise<MongoClient> {
  if (!_clientPromise) {
    const uri = getMongoUri();
    log.info('Creating MongoDB client');
    const client = new MongoClient(uri, CLIENT_OPTIONS);
    _clientPromise = client.connect();
  } else {
    log.debug('Reusing cached MongoDB client');
  }
  return _clientPromise;
}

/**
 * Returns the connected MongoDB database instance.
 *
 * @throws {DatabaseError} If the connection fails
 */
export async function getDatabase(): Promise<Db> {
  try {
    const client = await getClientPromise();
    const dbName = getMongoDbName();
    log.debug('Connected to database', { dbName });
    return client.db(dbName);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to connect to MongoDB', { error: err.message });
    throw new DatabaseError('Failed to connect to MongoDB Atlas', err);
  }
}

/**
 * Returns the raw MongoClient (for advanced operations like sessions/transactions).
 */
export async function getClient(): Promise<MongoClient> {
  try {
    return await getClientPromise();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Failed to get MongoDB client', { error: err.message });
    throw new DatabaseError('Failed to establish MongoDB client', err);
  }
}

/**
 * Closes the MongoDB connection.
 * Call this on process SIGTERM / SIGINT for clean shutdown.
 */
export async function closeDatabase(): Promise<void> {
  if (_clientPromise) {
    const client = await _clientPromise;
    await client.close();
    _clientPromise = null;
    log.info('MongoDB connection closed');
  }
}
