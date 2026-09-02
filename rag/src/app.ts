/**
 * Express Application Factory
 *
 * Creates and configures the Express application with:
 * - Security headers (Helmet)
 * - CORS
 * - JSON body parsing
 * - RAG routes under /rag
 * - Global error handler
 * - 404 handler
 *
 * @module app
 */

import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { ragRouter } from '@/routes/rag.routes';
import { errorMiddleware, notFoundMiddleware } from '@/middleware/error.middleware';
import { createLogger } from '@/lib/logger';

const log = createLogger('App');

export function createApp(): Application {
  const app = express();

  // ── Security ───────────────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ───────────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  // ── Body Parsing ───────────────────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Health Check ───────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'bugbaar-engine-rag',
      timestamp: new Date().toISOString(),
    });
  });

  // ── RAG Routes ─────────────────────────────────────────────────────────────
  app.use('/rag', ragRouter);

  log.info('Routes registered: /health, /rag/*');

  // ── 404 Handler ────────────────────────────────────────────────────────────
  app.use(notFoundMiddleware);

  // ── Global Error Handler ───────────────────────────────────────────────────
  // MUST be registered after all routes
  app.use(errorMiddleware);

  return app;
}
