import { Router, Request, Response } from 'express';
import {
  ANALYTICS_STATS,
  POOL_KEY,
  getPlayerAnalytics,
  getStatDistribution,
  isValidPoolKey,
  parseAnalyticsStat,
  parsePlayerId,
} from '../services/analytics.js';

// public, no auth — same as /api/players. these are league stats, not user data.

const INVALID_PLAYER_ID = 'A numeric player id is required';
const INVALID_STAT = `stat must be one of: ${ANALYTICS_STATS.join(', ')}`;
const INVALID_POOL = `pool must be "${POOL_KEY}"`;

// mounted under /api/players so the analytics for a player live next to the
// player itself. /:id/analytics can't collide with players.ts's /:id.
const playerAnalyticsRouter = Router();

/** Percentiles, pool distributions, and recent-form trends for one player. */
playerAnalyticsRouter.get('/:id/analytics', async (req: Request, res: Response): Promise<void> => {
  const playerId = parsePlayerId(req.params.id);
  if (playerId === null) {
    res.status(400).json({ error: INVALID_PLAYER_ID });
    return;
  }

  try {
    const analytics = await getPlayerAnalytics(playerId);
    if (!analytics) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }
    res.json(analytics);
  } catch {
    res.status(500).json({ error: 'Failed to fetch player analytics' });
  }
});

const analyticsRouter = Router();

/** One stat's league-wide distribution across the pool. */
analyticsRouter.get('/distributions', async (req: Request, res: Response): Promise<void> => {
  const stat = parseAnalyticsStat(req.query.stat);
  if (!stat) {
    res.status(400).json({ error: INVALID_STAT });
    return;
  }
  if (!isValidPoolKey(req.query.pool)) {
    res.status(400).json({ error: INVALID_POOL });
    return;
  }

  try {
    res.json(await getStatDistribution(stat));
  } catch {
    res.status(500).json({ error: 'Failed to fetch stat distribution' });
  }
});

export { analyticsRouter, playerAnalyticsRouter };
