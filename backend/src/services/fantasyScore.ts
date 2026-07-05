import { query } from '../db.js';

/**
 * Fantasy points per game, using the industry-standard NBA weighting:
 *
 *   FP = PTS + 1.2·REB + 1.5·AST + 3·STL + 3·BLK + 1·3PM − 1·TOV
 *
 * This is the same formula used by NBA.com (NBA_FANTASY_PTS), FanDuel,
 * and most "fantasy rank" articles. Values are interpretable directly —
 * a player putting up 50 FP/g is a top-tier producer, 25-30 is a typical
 * fantasy starter, etc.
 *
 * Note: this formula doesn't directly reward FG%/FT% — those matter in
 * category leagues but not in points-style scoring. For category-league
 * users we can revisit with a z-score variant later if needed; for now
 * matching what other sites publish was the priority.
 *
 * Cached for an hour to amortize the recompute across many requests.
 */

export interface FantasyStatLine {
  points_per_game: number;
  rebounds_per_game: number;
  assists_per_game: number;
  steals_per_game: number;
  blocks_per_game: number;
  three_pointers_made: number;
  turnovers_per_game: number;
}

export function fantasyPoints(p: FantasyStatLine): number {
  return (
    p.points_per_game +
    1.2 * p.rebounds_per_game +
    1.5 * p.assists_per_game +
    3 * p.steals_per_game +
    3 * p.blocks_per_game +
    1 * p.three_pointers_made -
    1 * p.turnovers_per_game
  );
}

// minimum volume to receive a meaningful rank. below this a player has played
// too little to compare against rotation regulars — their score is null so the
// FS column shows "-" instead of a misleading "47.8" from a tiny sample.
export const MIN_GAMES_FOR_RANK = 15;
export const MIN_MIN_FOR_RANK = 12;

// per-game fantasy score for one player, or null if the player hasn't played
// enough to be ranked. pulled out of the cached load path so unit tests can
// exercise the scoring rules without a database.
export function scorePlayer(
  stats: FantasyStatLine & { games_played: number; minutes_per_game: number }
): number | null {
  if (stats.games_played < MIN_GAMES_FOR_RANK) return null;
  if (stats.minutes_per_game < MIN_MIN_FOR_RANK) return null;
  return Math.round(fantasyPoints(stats) * 10) / 10;
}

export interface PlayerWithScore {
  id: number;
  nba_id: string | null;
  name: string;
  team: string | null;
  position: string | null;
  points_per_game: number;
  rebounds_per_game: number;
  assists_per_game: number;
  steals_per_game: number;
  blocks_per_game: number;
  field_goal_percentage: number;
  free_throw_percentage: number;
  three_point_percentage: number;
  three_pointers_made: number;
  turnovers_per_game: number;
  minutes_per_game: number;
  games_played: number;
  injury_status: string | null;
  injury_detail: string | null;
  headshot_url: string | null;
  fantasy_score: number | null;
  fantasy_rank: number | null;
}

interface CacheEntry {
  ranked: PlayerWithScore[];
  byId: Map<number, PlayerWithScore>;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
const TTL_MS = 60 * 60 * 1000;

async function compute(): Promise<{ ranked: PlayerWithScore[]; byId: Map<number, PlayerWithScore> }> {
  const all = await query(`
    SELECT id, nba_id, name, team, position,
           points_per_game::float    AS points_per_game,
           rebounds_per_game::float  AS rebounds_per_game,
           assists_per_game::float   AS assists_per_game,
           steals_per_game::float    AS steals_per_game,
           blocks_per_game::float    AS blocks_per_game,
           field_goal_percentage::float    AS field_goal_percentage,
           free_throw_percentage::float    AS free_throw_percentage,
           three_point_percentage::float   AS three_point_percentage,
           three_pointers_made::float      AS three_pointers_made,
           turnovers_per_game::float       AS turnovers_per_game,
           minutes_per_game::float         AS minutes_per_game,
           games_played::int               AS games_played,
           injury_status, injury_detail, headshot_url
    FROM players
  `);

  const rows = all.rows as Array<Record<string, unknown>>;

  const scored: PlayerWithScore[] = rows.map((p) => {
    const gp = Number(p.games_played) || 0;
    const mpg = Number(p.minutes_per_game) || 0;

    const stats = {
      points_per_game: Number(p.points_per_game) || 0,
      rebounds_per_game: Number(p.rebounds_per_game) || 0,
      assists_per_game: Number(p.assists_per_game) || 0,
      steals_per_game: Number(p.steals_per_game) || 0,
      blocks_per_game: Number(p.blocks_per_game) || 0,
      three_pointers_made: Number(p.three_pointers_made) || 0,
      turnovers_per_game: Number(p.turnovers_per_game) || 0,
    };

    const score = scorePlayer({ ...stats, games_played: gp, minutes_per_game: mpg });

    return {
      id: Number(p.id),
      nba_id: (p.nba_id as string) ?? null,
      name: String(p.name ?? ''),
      team: (p.team as string) ?? null,
      position: (p.position as string) ?? null,
      ...stats,
      field_goal_percentage: Number(p.field_goal_percentage) || 0,
      free_throw_percentage: Number(p.free_throw_percentage) || 0,
      three_point_percentage: Number(p.three_point_percentage) || 0,
      minutes_per_game: mpg,
      games_played: gp,
      injury_status: (p.injury_status as string) ?? null,
      injury_detail: (p.injury_detail as string) ?? null,
      headshot_url: (p.headshot_url as string) ?? null,
      fantasy_score: score,
      fantasy_rank: null,
    };
  });

  // Rank by FP descending; unranked players (null score) stay at the bottom.
  const rankable = scored.filter((p) => p.fantasy_score !== null);
  rankable.sort((a, b) => (b.fantasy_score ?? 0) - (a.fantasy_score ?? 0));
  rankable.forEach((p, i) => { p.fantasy_rank = i + 1; });

  const byId = new Map<number, PlayerWithScore>();
  scored.forEach((p) => byId.set(p.id, p));

  // Returned `ranked` is sorted: rankable first (best to worst), then
  // un-scored players in their original order.
  const unranked = scored.filter((p) => p.fantasy_score === null);
  return { ranked: [...rankable, ...unranked], byId };
}

async function load(): Promise<CacheEntry> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  const { ranked, byId } = await compute();
  cache = { ranked, byId, fetchedAt: Date.now() };
  return cache;
}

/** All players with their fantasy scores + ranks, sorted by rank (nulls last). */
export async function getRankedPlayers(): Promise<PlayerWithScore[]> {
  return (await load()).ranked;
}

/** Quick lookup by player id (e.g. when overlaying scores onto an existing list). */
export async function getScoresById(): Promise<Map<number, PlayerWithScore>> {
  return (await load()).byId;
}
