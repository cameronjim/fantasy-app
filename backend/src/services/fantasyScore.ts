import { query } from '../db.js';

/**
 * 9-category fantasy ranking.
 *
 * For each cat, we compute the mean + stddev across "rotation players"
 * (>=30 games, >=20 minutes per game) and then a player's z-score per cat.
 * Total fantasy score = sum of z-scores across all 9 cats (TO is inverted
 * since fewer turnovers is better).
 *
 * This is the same method most fantasy-rank sites use (hashtag basketball etc).
 * It naturally handles the scale differences between PPG (15ish) and BLK (0.7).
 *
 * Cached for an hour. Refresh aligns with the scraper's 6-hour cadence
 * without re-running the aggregate on every player request.
 */

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

const CATEGORIES = [
  { key: 'points_per_game',         lowerBetter: false },
  { key: 'rebounds_per_game',       lowerBetter: false },
  { key: 'assists_per_game',        lowerBetter: false },
  { key: 'steals_per_game',         lowerBetter: false },
  { key: 'blocks_per_game',         lowerBetter: false },
  { key: 'field_goal_percentage',   lowerBetter: false },
  { key: 'free_throw_percentage',   lowerBetter: false },
  { key: 'three_pointers_made',     lowerBetter: false },
  { key: 'turnovers_per_game',      lowerBetter: true },
] as const;

// Below this threshold a player is essentially out of the league pool — we
// surface no rank for them so the column doesn't claim e.g. "rank #487"
// for a guy who played 4 minutes once.
const MIN_GAMES_FOR_RANK = 15;
const MIN_MIN_FOR_RANK = 12;

async function compute(): Promise<{ ranked: PlayerWithScore[]; byId: Map<number, PlayerWithScore> }> {
  // The pool we use to derive mean/stddev is rotation-player only — same
  // cohort as the benchmarks service.
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

  // Build the rotation pool for stats.
  const pool = rows.filter((p) =>
    Number(p.games_played) >= 30 && Number(p.minutes_per_game) >= 20
  );

  // mean + stddev per category from the rotation pool.
  const stats: Record<string, { mean: number; sd: number }> = {};
  for (const cat of CATEGORIES) {
    const vals = pool.map((p) => Number(p[cat.key]) || 0);
    if (vals.length === 0) {
      stats[cat.key] = { mean: 0, sd: 1 };
      continue;
    }
    const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, v) => a + (v - mu) ** 2, 0) / vals.length;
    stats[cat.key] = { mean: mu, sd: Math.sqrt(variance) || 1 };
  }

  // Score every player who clears the minimum-volume floor. Below the floor
  // their score is null (we don't pretend to rank guys with 6 games or 9 min).
  const scored: PlayerWithScore[] = rows.map((p) => {
    const gp = Number(p.games_played) || 0;
    const mpg = Number(p.minutes_per_game) || 0;

    let score: number | null = null;
    if (gp >= MIN_GAMES_FOR_RANK && mpg >= MIN_MIN_FOR_RANK) {
      let total = 0;
      for (const cat of CATEGORIES) {
        const { mean, sd } = stats[cat.key];
        const z = (Number(p[cat.key]) - mean) / sd;
        total += cat.lowerBetter ? -z : z;
      }
      score = Math.round(total * 100) / 100;
    }

    return {
      id: Number(p.id),
      nba_id: (p.nba_id as string) ?? null,
      name: String(p.name ?? ''),
      team: (p.team as string) ?? null,
      position: (p.position as string) ?? null,
      points_per_game: Number(p.points_per_game) || 0,
      rebounds_per_game: Number(p.rebounds_per_game) || 0,
      assists_per_game: Number(p.assists_per_game) || 0,
      steals_per_game: Number(p.steals_per_game) || 0,
      blocks_per_game: Number(p.blocks_per_game) || 0,
      field_goal_percentage: Number(p.field_goal_percentage) || 0,
      free_throw_percentage: Number(p.free_throw_percentage) || 0,
      three_point_percentage: Number(p.three_point_percentage) || 0,
      three_pointers_made: Number(p.three_pointers_made) || 0,
      turnovers_per_game: Number(p.turnovers_per_game) || 0,
      minutes_per_game: mpg,
      games_played: gp,
      injury_status: (p.injury_status as string) ?? null,
      injury_detail: (p.injury_detail as string) ?? null,
      headshot_url: (p.headshot_url as string) ?? null,
      fantasy_score: score,
      fantasy_rank: null, // assigned below
    };
  });

  // Rank the players who have a score, descending. Nulls stay at the bottom
  // without a rank assigned.
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
