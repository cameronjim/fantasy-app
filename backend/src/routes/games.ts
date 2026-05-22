import { Router, Request, Response } from 'express';
import { query } from '../db.js';

const router = Router();

let liveCache: { data: object[]; fetchedAt: number } = { data: [], fetchedAt: 0 };
const LIVE_CACHE_TTL = 3 * 60_000; // 3 minutes

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { date } = req.query;
    let sql: string;
    const params: unknown[] = [];

    if (date) {
      sql = `SELECT id, nba_game_id, home_team, away_team, game_date,
                    home_score, away_score, status, arena, updated_at
             FROM games
             WHERE game_date = $1
             ORDER BY game_date DESC, id DESC`;
      params.push(date);
    } else {
      sql = `SELECT id, nba_game_id, home_team, away_team, game_date,
                    home_score, away_score, status, arena, updated_at
             FROM games
             ORDER BY game_date DESC, id DESC
             LIMIT 30`;
    }

    const result = await query(sql, params);
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

router.get('/live', async (_req: Request, res: Response): Promise<void> => {
  if (Date.now() - liveCache.fetchedAt < LIVE_CACHE_TTL && liveCache.data.length > 0) {
    res.json(liveCache.data);
    return;
  }

  try {
    // ESPN public scoreboard — designed for third-party access, no auth needed,
    // not blocked from AWS IPs unlike stats.nba.com and cdn.nba.com
    const url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    let resp: globalThis.Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      res.status(502).json({ error: 'ESPN API unavailable' });
      return;
    }

    const data = await resp.json() as {
      events: Array<{
        id: string;
        date: string; // UTC ISO e.g. "2026-05-22T00:00Z" — midnight UTC = start of game day in ET
        status: {
          type: { name: string; detail: string };
          period: number;
          displayClock: string;
        };
        competitions: Array<{
          venue?: { fullName?: string };
          competitors: Array<{
            homeAway: 'home' | 'away';
            score: string;
            team: { displayName: string };
          }>;
        }>;
      }>;
    };

    if (!data.events?.length) {
      res.json([]);
      return;
    }

    const result = data.events.map((e) => {
      // ESPN stores dates as UTC midnight — convert to Eastern Time for the real game date
      // e.g. "2026-05-22T00:00Z" = midnight UTC = 8 PM ET May 21 → game date is May 21
      const etDate = new Date(e.date).toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }); // "05/21/2026"
      const [mm, dd, yyyy] = etDate.split('/');
      const isoDate = `${yyyy}-${mm}-${dd}`;

      const statusName = e.status.type.name;
      let status: string;
      if (statusName === 'STATUS_FINAL') status = 'Final';
      else if (statusName === 'STATUS_IN_PROGRESS') status = 'In Progress';
      else status = e.status.type.detail?.trim() || 'Scheduled';

      const competition = e.competitions[0];
      const home = competition?.competitors.find((c) => c.homeAway === 'home');
      const away = competition?.competitors.find((c) => c.homeAway === 'away');

      const isPreGame = statusName === 'STATUS_SCHEDULED';
      const homeScore = !isPreGame && home?.score ? parseInt(home.score) : null;
      const awayScore = !isPreGame && away?.score ? parseInt(away.score) : null;

      const period = statusName === 'STATUS_IN_PROGRESS' && e.status.period
        ? e.status.period : undefined;
      const gameClock = statusName === 'STATUS_IN_PROGRESS' && e.status.displayClock
        && e.status.displayClock !== '0:00' ? e.status.displayClock : undefined;

      return {
        id: e.id,
        nba_game_id: e.id,
        home_team: home?.team.displayName ?? 'Unknown',
        away_team: away?.team.displayName ?? 'Unknown',
        game_date: isoDate,
        home_score: homeScore,
        away_score: awayScore,
        status,
        arena: competition?.venue?.fullName ?? '',
        ...(period != null ? { period } : {}),
        ...(gameClock ? { game_clock: gameClock } : {}),
      };
    });

    // Write back to DB so getGames() stays fresh when ESPN is unavailable
    for (const g of result) {
      try {
        await query(
          `INSERT INTO games (nba_game_id, home_team, away_team, game_date, home_score, away_score, status, arena, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (nba_game_id) DO UPDATE SET
             home_team  = EXCLUDED.home_team,
             away_team  = EXCLUDED.away_team,
             home_score = EXCLUDED.home_score,
             away_score = EXCLUDED.away_score,
             game_date  = EXCLUDED.game_date,
             status     = EXCLUDED.status,
             arena      = EXCLUDED.arena,
             updated_at = NOW()`,
          [g.nba_game_id, g.home_team, g.away_team, g.game_date,
           g.home_score, g.away_score, g.status, g.arena]
        );
      } catch { /* non-fatal */ }
    }

    liveCache = { data: result, fetchedAt: Date.now() };
    res.json(result);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    res.status(isAbort ? 504 : 500).json({
      error: isAbort ? 'ESPN timed out' : 'Failed to fetch live scores',
    });
  }
});

export { router as gamesRouter };
