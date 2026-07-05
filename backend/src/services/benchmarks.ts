import { query } from '../db.js';

export interface Benchmarks {
  PTS: number;
  REB: number;
  AST: number;
  STL: number;
  BLK: number;
  'FG%': number;
  'FT%': number;
  '3PM': number;
  TO: number;
  sample_size: number;
}

// Reasonable fallback when the DB has insufficient player data (fresh deploy
// before the first scrape completes). Matches what we hardcoded previously.
const FALLBACK: Benchmarks = {
  PTS: 15.0, REB: 5.0, AST: 3.5, STL: 1.0, BLK: 0.7,
  'FG%': 46.0, 'FT%': 78.0, '3PM': 1.5, TO: 1.8,
  sample_size: 0,
};

interface CacheEntry {
  data: Benchmarks;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
const TTL_MS = 60 * 60 * 1000; // 1 hour — scraper runs every 6, so this is fresh enough

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Per-player averages across the current "rotation player" pool — players
 * with at least 30 games played and 20+ minutes per game. This is roughly
 * the top ~150 fantasy-relevant NBA players, closely approximating the
 * rostered pool in a standard 10-team / 13-roster 9-cat league.
 *
 * Using real averages means our "strong / average / weak" ratings actually
 * reflect the current league, not a stale hardcoded heuristic. Cached for
 * an hour so we're not running the aggregate on every analysis request.
 */
export async function getCurrentBenchmarks(): Promise<Benchmarks> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return cache.data;
  }

  try {
    const result = await query(`
      SELECT
        AVG(points_per_game)::float       AS pts,
        AVG(rebounds_per_game)::float     AS reb,
        AVG(assists_per_game)::float      AS ast,
        AVG(steals_per_game)::float       AS stl,
        AVG(blocks_per_game)::float       AS blk,
        AVG(field_goal_percentage)::float AS fg_pct,
        AVG(free_throw_percentage)::float AS ft_pct,
        AVG(three_pointers_made)::float   AS three_pm,
        AVG(turnovers_per_game)::float    AS tov,
        COUNT(*)::int                     AS n
      FROM players
      WHERE games_played >= 30
        AND minutes_per_game >= 20
    `);

    const row = result.rows[0];
    if (!row || !row.n || row.n < 30) {
      return FALLBACK;
    }

    const benchmarks: Benchmarks = {
      PTS:   round1(row.pts),
      REB:   round1(row.reb),
      AST:   round1(row.ast),
      STL:   round1(row.stl),
      BLK:   round1(row.blk),
      'FG%': round1(row.fg_pct),
      'FT%': round1(row.ft_pct),
      '3PM': round1(row.three_pm),
      TO:    round1(row.tov),
      sample_size: row.n,
    };
    cache = { data: benchmarks, fetchedAt: Date.now() };
    return benchmarks;
  } catch {
    return FALLBACK;
  }
}

/** Formats benchmarks for embedding in AI system prompts. */
export function formatBenchmarksLine(b: Benchmarks): string {
  return [
    `PTS ${b.PTS}`,
    `REB ${b.REB}`,
    `AST ${b.AST}`,
    `STL ${b.STL}`,
    `BLK ${b.BLK}`,
    `FG% ${b['FG%']}`,
    `FT% ${b['FT%']}`,
    `3PM ${b['3PM']}`,
    `TO ${b.TO}`,
  ].join(', ');
}
