import { Request, Response, NextFunction } from 'express';
import { query } from '../db.js';

export interface RateLimitOptions {
  scope: string;
  limit: number;
  windowSeconds: number;
  keyFor?: (req: Request) => string;
  failClosed?: boolean;
}

export async function recordHit(bucket: string, windowSeconds: number): Promise<number> {
  const result = await query(
    `INSERT INTO rate_limits (bucket, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM NOW()) / $2) * $2), 1)
     ON CONFLICT (bucket, window_start)
     DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [bucket, windowSeconds]
  );
  return Number(result.rows[0].count);
}

function clientKey(req: Request): string {
  return req.ip ?? 'unknown';
}

export function rateLimit(options: RateLimitOptions) {
  const { scope, limit, windowSeconds, keyFor = clientKey, failClosed = false } = options;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      next();
      return;
    }
    try {
      const bucket = `${scope}:${keyFor(req)}`;
      const count = await recordHit(bucket, windowSeconds);
      if (count > limit) {
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }
    } catch {
      if (failClosed) {
        res.status(503).json({
          error: 'Rate limiting is temporarily unavailable. Please try again shortly.',
        });
        return;
      }
    }
    next();
  };
}
