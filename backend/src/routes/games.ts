import { Router, Request, Response } from 'express';
import { query } from '../db.js';

const router = Router();

// In-memory cache so the NBA API isn't hammered on every page load
let liveCache: { data: object[]; fetchedAt: number } = { data: [], fetchedAt: 0 };
const LIVE_CACHE_TTL = 90_000; // 90 seconds

const NBA_API_HEADERS: Record<string, string> = {
  Host: 'stats.nba.com',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

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
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

router.get('/live', async (_req: Request, res: Response): Promise<void> => {
  // Serve from cache if fresh — avoids slow NBA API call on every request
  if (Date.now() - liveCache.fetchedAt < LIVE_CACHE_TTL && liveCache.data.length > 0) {
    res.json(liveCache.data);
    return;
  }

  try {
    // NBA schedules are in Eastern Time — using UTC here causes wrong-date fetches after 8 PM ET
    const gameDate = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    }); // e.g. "05/21/2026"

    const url = `https://stats.nba.com/stats/scoreboardv2?DayOffset=0&GameDate=${gameDate}&LeagueID=00`;
    const resp = await fetch(url, { headers: NBA_API_HEADERS });

    if (!resp.ok) {
      res.status(502).json({ error: 'NBA API unavailable' });
      return;
    }

    const data = await resp.json();
    const resultSets: Record<string, { headers: string[]; rowSet: unknown[][] }> = {};
    for (const rs of data.resultSets || []) {
      resultSets[rs.name] = rs;
    }

    const gameHeader = resultSets['GameHeader'];
    const lineScore = resultSets['LineScore'];

    if (!gameHeader) {
      res.json([]);
      return;
    }

    const toDict = (rs: { headers: string[]; rowSet: unknown[][] }): Record<string, unknown>[] =>
      rs.rowSet.map((row) =>
        Object.fromEntries(rs.headers.map((h, i) => [h, row[i]]))
      );

    const games = toDict(gameHeader);
    const scores = lineScore ? toDict(lineScore) : [];

    // build score/name lookups keyed by game+team id to avoid multiple passes
    const scoreMap: Record<string, Record<string, number | null>> = {};
    const teamNameMap: Record<string, Record<string, string>> = {};
    for (const s of scores) {
      const gid = String(s.GAME_ID ?? '');
      const tid = String(s.TEAM_ID ?? '');
      const pts = s.PTS != null ? Number(s.PTS) : null;
      const teamName = [s.TEAM_CITY_NAME, s.TEAM_NAME].filter(Boolean).join(' ')
        || String(s.TEAM_ABBREVIATION ?? '');
      if (!scoreMap[gid]) scoreMap[gid] = {};
      scoreMap[gid][tid] = pts;
      if (!teamNameMap[gid]) teamNameMap[gid] = {};
      teamNameMap[gid][tid] = teamName;
    }

    const result = games.map((g: Record<string, unknown>) => {
      const gameId = String(g.GAME_ID ?? '');
      const homeTeamId = String(g.HOME_TEAM_ID ?? '');
      const awayTeamId = String(g.VISITOR_TEAM_ID ?? '');
      const gameScores = scoreMap[gameId] || {};
      const gameTeams = teamNameMap[gameId] || {};

      const statusId = Number(g.GAME_STATUS_ID ?? 1);
      let status: string;
      if (statusId === 1) status = g.GAME_STATUS_TEXT ? String(g.GAME_STATUS_TEXT).trim() : 'Scheduled';
      else if (statusId === 2) status = 'In Progress';
      else status = 'Final';

      const dateStr = String(g.GAME_DATE_EST ?? '').slice(0, 10);

      const period = g.LIVE_PERIOD != null ? Number(g.LIVE_PERIOD) : undefined;
      const rawClock = g.LIVE_PC_TIME != null ? String(g.LIVE_PC_TIME).trim() : undefined;
      const gameClock = rawClock && rawClock !== '' && rawClock !== '0:00' ? rawClock : undefined;

      return {
        id: gameId,
        nba_game_id: gameId,
        home_team: gameTeams[homeTeamId] || 'Unknown',
        away_team: gameTeams[awayTeamId] || 'Unknown',
        game_date: dateStr,
        home_score: gameScores[homeTeamId] ?? null,
        away_score: gameScores[awayTeamId] ?? null,
        status,
        ...(period ? { period } : {}),
        ...(gameClock ? { game_clock: gameClock } : {}),
      };
    });

    for (const g of result) {
      try {
        await query(
          `INSERT INTO games (nba_game_id, home_team, away_team, game_date, home_score, away_score, status, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (nba_game_id) DO UPDATE SET
             home_score = EXCLUDED.home_score,
             away_score = EXCLUDED.away_score,
             status = EXCLUDED.status,
             updated_at = NOW()`,
          [g.nba_game_id, g.home_team, g.away_team, g.game_date, g.home_score, g.away_score, g.status]
        );
      } catch {
        // non-fatal db write — continue returning live data
      }
    }

    liveCache = { data: result, fetchedAt: Date.now() };
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch live scores' });
  }
});

export { router as gamesRouter };
