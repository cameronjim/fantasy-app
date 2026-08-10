import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { getSlate, parsePredictionDate } from '../services/slate.js';
import {
  MAX_WINDOW_DAYS,
  POSITION_FILTERS,
  getWatchlist,
  parsePositionFilter,
  parseWindowDays,
} from '../services/watchlist.js';
import { parsePlayerId } from '../services/analytics.js';
import {
  MAX_UPCOMING_LIMIT,
  getUpcomingPredictionsForPlayer,
  parseFromDate,
  parseLimit,
} from '../services/playerPredictions.js';

// public, no auth — the same league data as /api/players and /api/analytics.
// nothing here is user-scoped.

const INVALID_DATE = 'date must be a calendar day formatted YYYY-MM-DD';
const INVALID_FROM = 'from must be a calendar day formatted YYYY-MM-DD';
const INVALID_LIMIT = `limit must be a whole number between 1 and ${MAX_UPCOMING_LIMIT}`;
const INVALID_PLAYER_ID = 'A numeric player id is required';
const INVALID_DAYS = `days must be a whole number between 1 and ${MAX_WINDOW_DAYS}`;
const INVALID_POSITION = `position must be one of ${POSITION_FILTERS.join(', ')}, or any`;

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

/**
 * Ranked discovery candidates over a window of `days` starting at `date`, with
 * the rule codes that put them there.
 *
 * `days` defaults to 1 — the request the page made before windows existed, so an
 * older client keeps getting exactly what it got. `position` filters to a roster
 * slot (G/F/C) or an exact position (PG/SG/SF/PF/C); absent means every
 * position. Both are rejected rather than clamped or ignored, so a typo is a 400
 * instead of a list that quietly answers a different question.
 */
watchlistRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const date = parsePredictionDate(req.query.date);
  if (date === null) {
    res.status(400).json({ error: INVALID_DATE });
    return;
  }

  const days = parseWindowDays(req.query.days);
  if (days === null) {
    res.status(400).json({ error: INVALID_DAYS });
    return;
  }

  const position = parsePositionFilter(req.query.position);
  if (position === false) {
    res.status(400).json({ error: INVALID_POSITION });
    return;
  }

  try {
    res.json(await getWatchlist(date, { days, position }));
  } catch {
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

/**
 * Mounted under /api/players, next to /:id/analytics, because these are that
 * player's predictions rather than a slice of the league slate. `:id` is the
 * internal `players.id` the rest of the player surface uses; the prediction
 * store keys on `players.nba_id`, which is TEXT, and is only ever passed as a
 * bound parameter.
 */
const playerPredictionsRouter = Router();

/**
 * Every game the latest complete run predicts for one player, earliest first.
 *
 * The empty answers are 200s, not errors, and they are distinguishable:
 *   `run: null, games: []`  no run has ever completed (production, today).
 *   `run: {...}, games: []` the run exists but has nothing for this player.
 * Only an unknown player id is a 404 — the same rule /:id/analytics follows.
 */
playerPredictionsRouter.get(
  '/:id/predictions',
  async (req: Request, res: Response): Promise<void> => {
    const playerId = parsePlayerId(req.params.id);
    if (playerId === null) {
      res.status(400).json({ error: INVALID_PLAYER_ID });
      return;
    }

    const from = parseFromDate(req.query.from);
    if (from === false) {
      res.status(400).json({ error: INVALID_FROM });
      return;
    }

    const limit = parseLimit(req.query.limit);
    if (limit === false) {
      res.status(400).json({ error: INVALID_LIMIT });
      return;
    }

    try {
      const players = await query(`SELECT nba_id, team FROM players WHERE id = $1`, [playerId]);
      const player = players.rows[0];
      if (!player) {
        res.status(404).json({ error: 'Player not found' });
        return;
      }

      const nbaPlayerId = player.nba_id === null || player.nba_id === undefined
        ? null
        : String(player.nba_id);
      const teamAbbr = player.team === null || player.team === undefined
        ? null
        : String(player.team);

      const payload = await getUpcomingPredictionsForPlayer(nbaPlayerId, {
        teamAbbr,
        from,
        limit,
      });
      res.json({ player_id: playerId, nba_player_id: nbaPlayerId, ...payload });
    } catch {
      res.status(500).json({ error: 'Failed to fetch player predictions' });
    }
  }
);

export { predictionsRouter, watchlistRouter, playerPredictionsRouter };
