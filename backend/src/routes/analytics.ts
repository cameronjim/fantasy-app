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


const INVALID_PLAYER_ID = 'A numeric player id is required';
const INVALID_STAT = `stat must be one of: ${ANALYTICS_STATS.join(', ')}`;
const INVALID_POOL = `pool must be "${POOL_KEY}"`;

const playerAnalyticsRouter = Router();

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
