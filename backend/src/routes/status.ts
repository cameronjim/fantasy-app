import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { getCurrentBenchmarks } from '../services/benchmarks.js';

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

/**
 * Live league benchmarks computed from the current player pool. Powers the
 * AI's "strong/average/weak" thresholds; also handy for the UI if we ever
 * want to surface the league average alongside the user's team averages.
 */
router.get('/benchmarks', async (_req: Request, res: Response): Promise<void> => {
  try {
    const benchmarks = await getCurrentBenchmarks();
    res.json(benchmarks);
  } catch {
    res.status(500).json({ error: 'Failed to load benchmarks' });
  }
});

export { router as statusRouter };
