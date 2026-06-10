import { Request, Response, NextFunction } from 'express';
import { query } from '../db.js';

export interface RateLimitOptions {
  // human-readable bucket prefix, e.g. 'login' or 'ai'. keeps unrelated limits
  // from sharing a counter.
  scope: string;
  // max requests allowed per window before the limiter starts rejecting.
  limit: number;
  // window length in seconds. fixed window: all hits in the same window share
  // one counter row.
  windowSeconds: number;
  // derives the throttling identity from the request. defaults to client ip;
  // authenticated routes pass a userId-based key instead.
  keyFor?: (req: Request) => string;
}

/**
 * Records a hit for `bucket` in the current fixed window and returns the
 * running count. The upsert is atomic, so concurrent Lambda invocations can't
 * race past the limit. window_start is computed in SQL (server clock) to keep
 * counting consistent regardless of which container handles the request.
 */
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

// behind API Gateway / CloudFront the real client ip arrives in
// x-forwarded-for; express surfaces it on req.ip once 'trust proxy' is set.
function clientKey(req: Request): string {
  return req.ip ?? 'unknown';
}

/**
 * Express middleware enforcing a per-key request ceiling backed by Postgres.
 * Returns 429 once the window count exceeds `limit`.
 *
 * Disabled under NODE_ENV=test so the unit/api suites don't depend on a real
 * counter table — the logic is covered directly in rateLimit.test.ts.
 *
 * Fails OPEN: if the counter query errors, the request proceeds. A limiter
 * outage must not lock out every user, and route-level validation still
 * guards each endpoint.
 */
export function rateLimit(options: RateLimitOptions) {
  const { scope, limit, windowSeconds, keyFor = clientKey } = options;

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
      // fail open — see the function doc.
    }
    next();
  };
}
