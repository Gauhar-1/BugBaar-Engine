/**
 * Error Middleware
 *
 * Global Express error handler. Converts AppError subclasses
 * into structured JSON responses and handles unknown errors as 500.
 *
 * Must be registered LAST in the Express middleware chain.
 *
 * @module middleware/error.middleware
 */

import { Request, Response, NextFunction } from 'express';
import { AppError, toErrorResponse } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('ErrorMiddleware');

/**
 * Express global error handler.
 * Signature must have 4 parameters for Express to recognize it as an error handler.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { body, statusCode } = toErrorResponse(error);

  log.error('Request error', {
    method: req.method,
    path: req.path,
    statusCode,
    code: body.code,
    error: body.error,
  });

  res.status(statusCode).json(body);
}

/**
 * 404 handler for unmatched routes.
 */
export function notFoundMiddleware(req: Request, res: Response): void {
  res.status(404).json({
    error: `Route ${req.method} ${req.path} not found`,
    code: 'NOT_FOUND',
    statusCode: 404,
  });
}
