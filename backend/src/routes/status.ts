import { Router, Request, Response } from 'express';
import { query } from '../db.js';

const router = Router();

/**
 * Returns the latest update timestamp for each data source.
 * Used by the frontend status badge so users can see when stats were last refreshed.
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT
        (SELECT MAX(updated_at) FROM players) AS players_updated_at,
        (SELECT MAX(updated_at) FROM teams)   AS teams_updated_at,
        (SELECT MAX(updated_at) FROM games)   AS games_updated_at
    `);
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to load status' });
  }
});

export { router as statusRouter };
