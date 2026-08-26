import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { clampLimit, clampOffset, searchPattern } from '../services/queryParams.js';
import {
  MAX_RATINGS_2K_LIMIT,
  ORDER_BY_SQL,
  RATINGS_2K_ATTRIBUTION,
  normalizeName,
  parseSort,
  parseTeamType,
} from '../services/ratings2kParams.js';

const router = Router();

const INVALID_TEAM_TYPE = 'teamType must be one of curr, class, allt, all';
const NAME_REQUIRED = 'A name is required';

const SUMMARY_COLUMNS = `slug,
       name,
       team,
       team_type,
       overall,
       positions,
       game_version,
       player_image`;

const DETAIL_COLUMNS = `${SUMMARY_COLUMNS},
       archetype,
       build,
       height,
       weight,
       wingspan,
       updated_at`;

const BADGE_TIER_ORDER = `CASE tier
           WHEN 'Legendary'    THEN 1
           WHEN 'Hall of Fame' THEN 2
           WHEN 'Gold'         THEN 3
           WHEN 'Silver'       THEN 4
           WHEN 'Bronze'       THEN 5
           ELSE 6
         END`;

router.get('/players', async (req: Request, res: Response): Promise<void> => {
  const parsedTeamType = parseTeamType(req.query.teamType);
  if (!parsedTeamType.ok) {
    res.status(400).json({ error: INVALID_TEAM_TYPE });
    return;
  }

  const search = searchPattern(req.query.search);
  const limit = clampLimit(req.query.limit, MAX_RATINGS_2K_LIMIT);
  const offset = clampOffset(req.query.offset);
  const orderBy = ORDER_BY_SQL[parseSort(req.query.sort)];

  const params: unknown[] = [];
  const conditions: string[] = [];
  if (parsedTeamType.teamType) {
    params.push(parsedTeamType.teamType);
    conditions.push(`team_type = $${params.length}`);
  }
  if (search) {
    params.push(search);
    conditions.push(`name ILIKE $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const limitPlaceholder = params.length + 1;
  const offsetPlaceholder = params.length + 2;

  try {
    const [countResult, pageResult] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM nba_2k_players ${where}`, params),
      query(
        `SELECT ${SUMMARY_COLUMNS}
         FROM nba_2k_players
         ${where}
         ORDER BY ${orderBy}
         LIMIT $${limitPlaceholder} OFFSET $${offsetPlaceholder}`,
        [...params, limit, offset]
      ),
    ]);

    res.json({
      total: countResult.rows[0]?.total ?? 0,
      players: pageResult.rows,
      source: RATINGS_2K_ATTRIBUTION,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch 2K players' });
  }
});

router.get('/players/:slug', async (req: Request, res: Response): Promise<void> => {
  const { slug } = req.params;

  try {
    const playerResult = await query(
      `SELECT ${DETAIL_COLUMNS}
       FROM nba_2k_players
       WHERE slug = $1`,
      [slug]
    );

    if (playerResult.rows.length === 0) {
      res.status(404).json({ error: '2K player not found' });
      return;
    }

    const [attributeResult, badgeResult, historyResult] = await Promise.all([
      query(
        `SELECT attribute_name, value
         FROM nba_2k_attributes
         WHERE player_slug = $1
         ORDER BY attribute_name ASC`,
        [slug]
      ),
      query(
        `SELECT badge_name, tier, category, description, image_url
         FROM nba_2k_badges
         WHERE player_slug = $1
         ORDER BY ${BADGE_TIER_ORDER}, badge_name ASC`,
        [slug]
      ),
      query(
        `SELECT game_version, overall, delta
         FROM nba_2k_rating_history
         WHERE player_slug = $1
         ORDER BY game_version DESC`,
        [slug]
      ),
    ]);

    res.json({
      player: playerResult.rows[0],
      attributes: attributeResult.rows,
      badges: badgeResult.rows,
      rating_history: historyResult.rows,
      source: RATINGS_2K_ATTRIBUTION,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch 2K player' });
  }
});

router.get('/by-player-name', async (req: Request, res: Response): Promise<void> => {
  const normalized = normalizeName(req.query.name);
  if (!normalized) {
    res.status(400).json({ error: NAME_REQUIRED });
    return;
  }

  try {
    const result = await query(
      `SELECT ${SUMMARY_COLUMNS}
       FROM nba_2k_players
       WHERE normalized_name = $1
       ORDER BY (team_type = 'curr') DESC, overall DESC NULLS LAST
       LIMIT 1`,
      [normalized]
    );

    res.json({
      player: result.rows[0] ?? null,
      source: RATINGS_2K_ATTRIBUTION,
    });
  } catch {
    res.status(500).json({ error: 'Failed to resolve 2K player' });
  }
});

export { router as ratings2kRouter };
