import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { etIsoDate } from '../services/dates.js';

const router = Router();

let liveCache: { data: object[]; fetchedAt: number } = { data: [], fetchedAt: 0 };
const LIVE_CACHE_TTL = 3 * 60_000; // 3 minutes

// how far back and forward the scoreboard looks. a window (rather than just
// "today") means recent results stay visible AND upcoming games load, so the
// "Today" / "Tomorrow" labels in the strip actually have content even on an
// off-day with no game scheduled today. two weeks back covers a full playoff
// series so the back arrow has real history to scroll through; ten days
// forward covers upcoming games without pulling an unbounded schedule.
const PAST_WINDOW_DAYS = 14;
const FUTURE_WINDOW_DAYS = 10;

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { date } = req.query;

    if (date) {
      const result = await query(
        `SELECT id, nba_game_id, home_team, away_team, game_date,
                home_score, away_score, status, arena, updated_at
         FROM games
         WHERE game_date = $1
         ORDER BY game_date DESC, id DESC`,
        [date]
      );
      res.json(result.rows);
      return;
    }

    // default: a recent-plus-upcoming window instead of "the most recent 30
    // games regardless of age". during a multi-day gap (e.g. between playoff
    // games) the old LIMIT-30 query surfaced weeks-old games as if they were
    // current. bounds are ET date strings (matching game_date) with one extra
    // day of slack on each side so a boundary game is never cut off.
    //
    // the NOT(...) clause drops "phantom" past games: a game whose date has
    // passed but still has no scores was never actually played (e.g. an
    // "if necessary" playoff game in a series that ended early). a real
    // completed game always has scores, so past + null scores = never played.
    const result = await query(
      `SELECT id, nba_game_id, home_team, away_team, game_date,
              home_score, away_score, status, arena, updated_at
       FROM games
       WHERE game_date >= $1 AND game_date <= $2
         AND NOT (game_date < $3 AND home_score IS NULL AND away_score IS NULL)
       ORDER BY game_date ASC, id ASC`,
      [etIsoDate(-(PAST_WINDOW_DAYS + 1)), etIsoDate(FUTURE_WINDOW_DAYS + 1), etIsoDate(0)]
    );
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
    // not blocked from AWS IPs unlike stats.nba.com and cdn.nba.com.
    // `dates=START-END` returns the whole window in one call, so recent results
    // and upcoming scheduled games arrive together.
    const start = etIsoDate(-PAST_WINDOW_DAYS).replace(/-/g, '');
    const end = etIsoDate(FUTURE_WINDOW_DAYS).replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${start}-${end}`;

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
          type: { name: string; detail: string; shortDetail?: string };
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
      // scheduled games: prefer the compact tip-off time (shortDetail, e.g.
      // "8:00 PM EDT") over the verbose detail string, since these now show
      // for upcoming days, not just today.
      else status = e.status.type.shortDetail?.trim() || e.status.type.detail?.trim() || 'Scheduled';

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

    // drop "phantom" past games before doing anything with them: a game whose
    // date has passed but still has no scores was never played (e.g. an
    // "if necessary" playoff game in a series that ended in a sweep). ESPN
    // keeps these on the schedule, so the range fetch returns them — but they
    // shouldn't be written to the db or shown as blank past games.
    const today = etIsoDate(0);
    const played = result.filter(
      (g) => !(g.game_date < today && g.home_score === null && g.away_score === null)
    );

    // Write back to DB so getGames() stays fresh when ESPN is unavailable
    for (const g of played) {
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

    liveCache = { data: played, fetchedAt: Date.now() };
    res.json(played);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    res.status(isAbort ? 504 : 500).json({
      error: isAbort ? 'ESPN timed out' : 'Failed to fetch live scores',
    });
  }
});

export { router as gamesRouter };
