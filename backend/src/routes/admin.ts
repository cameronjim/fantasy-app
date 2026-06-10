import { Router, Request, Response } from 'express';
import { query } from '../db.js';

// mounted behind requireAuth + requireAdmin in app.ts — every handler here
// can assume the caller is an authenticated admin.
const router = Router();

/** All registered accounts, newest first, with per-user activity rollups. */
router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.email, u.name, u.is_admin, u.created_at,
              (u.password_hash IS NOT NULL) AS has_password,
              (u.google_id IS NOT NULL) AS has_google,
              (SELECT COUNT(*)::int FROM my_roster r WHERE r.user_id = u.id) AS roster_count,
              (SELECT MAX(pv.created_at) FROM page_views pv WHERE pv.user_id = u.id) AS last_seen
       FROM users u
       ORDER BY u.created_at DESC`
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: 'Failed to load users' });
  }
});

/** Headline counters plus the most-viewed pages over the last 7 days. */
router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const totals = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS total_users,
         (SELECT COUNT(*)::int FROM users WHERE created_at > NOW() - INTERVAL '7 days') AS new_users_7d,
         (SELECT COUNT(*)::int FROM page_views WHERE created_at > NOW() - INTERVAL '24 hours') AS views_24h,
         (SELECT COUNT(*)::int FROM page_views WHERE created_at > NOW() - INTERVAL '7 days') AS views_7d,
         (SELECT COUNT(DISTINCT user_id)::int FROM page_views
          WHERE created_at > NOW() - INTERVAL '24 hours' AND user_id IS NOT NULL) AS active_users_24h`
    );
    const topPaths = await query(
      `SELECT path, COUNT(*)::int AS views
       FROM page_views
       WHERE created_at > NOW() - INTERVAL '7 days'
       GROUP BY path
       ORDER BY views DESC
       LIMIT 10`
    );
    res.json({ totals: totals.rows[0], top_paths: topPaths.rows });
  } catch {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

/** Most recent page views with the viewer's username when known. */
router.get('/views', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT pv.id, pv.path, pv.referrer, pv.user_agent, pv.created_at,
              u.username
       FROM page_views pv
       LEFT JOIN users u ON u.id = pv.user_id
       ORDER BY pv.created_at DESC
       LIMIT 100`
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: 'Failed to load page views' });
  }
});

export { router as adminRouter };
