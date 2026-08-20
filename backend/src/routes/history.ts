import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import {
  MAX_SEASON_PLAYERS_LIMIT,
  clampLimit,
  clampOffset,
  isValidSeason,
  searchPattern,
} from '../services/historyParams.js';

const router = Router();

const INVALID_SEASON = 'A valid season is required, formatted like 1996-97';

const PLAYER_COLUMNS = `nba_player_id,
       player_name,
       season,
       team,
       games_played,
       minutes_per_game::float8      AS minutes_per_game,
       points_per_game::float8       AS points_per_game,
       rebounds_per_game::float8     AS rebounds_per_game,
       assists_per_game::float8      AS assists_per_game,
       steals_per_game::float8       AS steals_per_game,
       blocks_per_game::float8       AS blocks_per_game,
       turnovers_per_game::float8    AS turnovers_per_game,
       field_goal_percentage::float8 AS field_goal_percentage,
       three_point_percentage::float8 AS three_point_percentage,
       free_throw_percentage::float8 AS free_throw_percentage,
       three_pointers_made::float8   AS three_pointers_made`;

const TEAM_COLUMNS = `nba_team_id,
       team_name,
       team_abbreviation AS abbreviation,
       season,
       games_played,
       wins,
       losses,
       minutes_per_game::float8      AS minutes_per_game,
       points_per_game::float8       AS points_per_game,
       rebounds_per_game::float8     AS rebounds_per_game,
       assists_per_game::float8      AS assists_per_game,
       steals_per_game::float8       AS steals_per_game,
       blocks_per_game::float8       AS blocks_per_game,
       turnovers_per_game::float8    AS turnovers_per_game,
       field_goal_percentage::float8 AS field_goal_percentage,
       three_point_percentage::float8 AS three_point_percentage,
       free_throw_percentage::float8 AS free_throw_percentage,
       defensive_rating::float8      AS defensive_rating,
       offensive_rating::float8      AS offensive_rating,
       net_rating::float8            AS net_rating`;

router.get('/seasons', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT season
       FROM (
         SELECT DISTINCT season FROM player_season_stats
         UNION
         SELECT DISTINCT season FROM team_season_stats
       ) AS s
       ORDER BY season DESC`
    );
    res.json({ seasons: result.rows.map((r) => r.season) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch seasons' });
  }
});

router.get('/players', async (req: Request, res: Response): Promise<void> => {
  const { season } = req.query;
  if (!isValidSeason(season)) {
    res.status(400).json({ error: INVALID_SEASON });
    return;
  }

  const search = searchPattern(req.query.search);
  const limit = clampLimit(req.query.limit, MAX_SEASON_PLAYERS_LIMIT);
  const offset = clampOffset(req.query.offset);

  const params: unknown[] = [season];
  let where = 'WHERE season = $1';
  if (search) {
    params.push(search);
    where += ` AND player_name ILIKE $${params.length}`;
  }

  const limitPlaceholder = params.length + 1;
  const offsetPlaceholder = params.length + 2;

  try {
    const [countResult, pageResult] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM player_season_stats ${where}`, params),
      query(
        `SELECT ${PLAYER_COLUMNS}
         FROM player_season_stats
         ${where}
         ORDER BY points_per_game DESC NULLS LAST, player_name ASC
         LIMIT $${limitPlaceholder} OFFSET $${offsetPlaceholder}`,
        [...params, limit, offset]
      ),
    ]);

    res.json({
      season,
      total: countResult.rows[0]?.total ?? 0,
      players: pageResult.rows,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch season players' });
  }
});

router.get('/players/:nbaPlayerId/seasons', async (req: Request, res: Response): Promise<void> => {
  const { nbaPlayerId } = req.params;

  try {
    const result = await query(
      `SELECT ${PLAYER_COLUMNS}
       FROM player_season_stats
       WHERE nba_player_id = $1
       ORDER BY season ASC`,
      [nbaPlayerId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'No historical seasons found for that player' });
      return;
    }

    const latest = result.rows[result.rows.length - 1];

    res.json({
      nba_player_id: nbaPlayerId,
      player_name: latest.player_name,
      seasons: result.rows,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch player history' });
  }
});

router.get('/teams', async (req: Request, res: Response): Promise<void> => {
  const { season } = req.query;
  if (!isValidSeason(season)) {
    res.status(400).json({ error: INVALID_SEASON });
    return;
  }

  try {
    const result = await query(
      `SELECT ${TEAM_COLUMNS}
       FROM team_season_stats
       WHERE season = $1
       ORDER BY points_per_game DESC NULLS LAST, team_name ASC`,
      [season]
    );

    res.json({ season, teams: result.rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch season teams' });
  }
});

export { router as historyRouter };
