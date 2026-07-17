import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { optionalAuth, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// generous ceiling — a human clicking around generates a few dozen views an
// hour; this only stops scripts from flooding the page_views table.
const trackLimiter = rateLimit({ scope: 'track', limit: 300, windowSeconds: 3600 });

const MAX_PATH_LENGTH = 300;
const MAX_FIELD_LENGTH = 300;

/** truncate-or-null for the optional free-text fields we store verbatim. */
function clamp(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, MAX_FIELD_LENGTH);
}

// fire-and-forget pageview beacon from the SPA router. anonymous visitors are
// recorded with a null user_id; a valid bearer token attributes the view.
router.post('/pageview', trackLimiter, optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const { path, referrer } = req.body;

  // only accept app-internal pathnames. query strings are rejected rather
  // than stripped so a reset-password token can never end up in analytics.
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('?')) {
    res.status(400).json({ error: 'path must be an app pathname starting with "/"' });
    return;
  }
  if (path.length > MAX_PATH_LENGTH) {
    res.status(400).json({ error: `path must be ${MAX_PATH_LENGTH} characters or fewer` });
    return;
  }

  const userId = (req as AuthRequest).userId ?? null;
  const userAgent = clamp(req.headers['user-agent']);

  try {
    await query(
      `INSERT INTO page_views (user_id, path, referrer, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [userId, path, clamp(referrer), userAgent]
    );
  } catch {
    // analytics must never break the app — swallow the write failure and
    // still return success to the beacon.
  }
  res.status(204).end();
});

export { router as trackRouter };
