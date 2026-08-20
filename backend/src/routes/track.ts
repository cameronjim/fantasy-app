import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { optionalAuth, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const trackLimiter = rateLimit({ scope: 'track', limit: 300, windowSeconds: 3600 });

const MAX_PATH_LENGTH = 300;
const MAX_FIELD_LENGTH = 300;

function clamp(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, MAX_FIELD_LENGTH);
}

router.post('/pageview', trackLimiter, optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const { path, referrer } = req.body;

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
  }
  res.status(204).end();
});

export { router as trackRouter };
