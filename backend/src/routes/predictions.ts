import { Router, Request, Response } from 'express';
import { getSlate, parsePredictionDate } from '../services/slate.js';
import { getWatchlist } from '../services/watchlist.js';

// public, no auth — the same league data as /api/players and /api/analytics.
// nothing here is user-scoped.

const INVALID_DATE = 'date must be a calendar day formatted YYYY-MM-DD';

/** Mounted at /api/predictions. */
const predictionsRouter = Router();

/**
 * The day's games with each game's top projected players. Absent `date`
 * defaults to today in Eastern Time, which is the calendar the NBA schedule
 * is published on.
 */
predictionsRouter.get('/slate', async (req: Request, res: Response): Promise<void> => {
  const date = parsePredictionDate(req.query.date);
  if (date === null) {
    res.status(400).json({ error: INVALID_DATE });
    return;
  }

  try {
    res.json(await getSlate(date));
  } catch {
    res.status(500).json({ error: 'Failed to fetch slate' });
  }
});

/** Mounted at /api/watchlist — a top-level resource, not a prediction of one. */
const watchlistRouter = Router();

/** Ranked discovery candidates with the rule codes that put them there. */
watchlistRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const date = parsePredictionDate(req.query.date);
  if (date === null) {
    res.status(400).json({ error: INVALID_DATE });
    return;
  }

  try {
    res.json(await getWatchlist(date));
  } catch {
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

export { predictionsRouter, watchlistRouter };
