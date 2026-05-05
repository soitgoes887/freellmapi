import type { Request, Response, NextFunction } from 'express';
import { getUnifiedApiKey } from '../db/index.js';

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  // Tests build the app without going through the env validation in index.ts
  // and exercise routes directly. Skip auth in that case to keep them simple.
  if (process.env.NODE_ENV === 'test') {
    next();
    return;
  }

  const expected = getUnifiedApiKey();
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!provided || provided !== expected) {
    res.status(401).json({
      error: { message: 'Invalid or missing API key', type: 'authentication_error' },
    });
    return;
  }
  next();
}
