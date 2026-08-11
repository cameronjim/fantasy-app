import { query } from '../db.js';

// serving the newest stored forecast for one player's next game.
//
// the prediction store (migration 014) is append-only and long-format: one row
// per (run, player, game, stat, quantile). the page wants one object. this file
// is the pivot between the two, plus the cache that keeps a page load from
// re-running the query for every visitor.
//
// the read is deliberately narrow. it never recomputes anything, never falls
// back to a heuristic, and never invents a projection when the model has not
// made one — a missing prediction returns null and the card disappears. a
// fabricated number on a page that says "projection" is worse than no card.

/**
 * `conditional` in the stored rows means "given he plays". The bare stat name
 * carries that estimate; `<stat>_uncond` carries the schedule-level one, which
 * is already multiplied by P(play). The spike measured the gap at roughly half
 * (22.5 conditional minutes against 15.0 unconditional), so which one is being
 * shown has to be unambiguous — hence the `conditional: true` marker on the
 * served object rather than a comment nobody reads.
 */
const UNCOND_SUFFIX = '_uncond';

/** P(he plays at all). Unconditional by construction, always in [0,1]. */
const PROB_ACTIVE = 'prob_active';

/**
 * Stats served as a single expected value. `minutes` and `pts` are absent
 * because they are served as a P10/P50/P90 range instead — the two stats a
 * start/sit call actually turns on are the two where a point estimate hides the
 * spread that makes the call hard.
 */
const POINT_STATS = ['reb', 'ast', 'stl', 'blk', 'tov', 'fg3m'] as const;

type PointStat = (typeof POINT_STATS)[number];

const P10 = 0.1;
const P50 = 0.5;
const P90 = 0.9;

export interface QuantileRange {
  p10: number;
  p50: number;
  p90: number;
}

export interface ProjectedStats extends Record<PointStat, number | null> {
  minutes: QuantileRange | null;
  pts: QuantileRange | null;
}

export interface PlayerPrediction {
  /** when the run that produced this executed, ISO 8601. */
  as_of: string;
  model_version: string;
  /** the game being predicted, `YYYY-MM-DD`. */
  game_date: string;
  /** P(he plays), 0-1. Null when the run did not emit one for him. */
  prob_active: number | null;
  projected: ProjectedStats;
  /** every number in `projected` is "given he plays". */
  conditional: true;
  /** the same points estimate over the schedule, misses included. */
  unconditional_pts: number | null;
  /**
   * One-line rendering of the numbers above. Present because the player page's
   * card is written against an all-optional shape and renders `summary`
   * verbatim; without it, a reader sees a grid in which the two most useful
   * cells (a minutes range and a points range) are objects the card cannot
   * format. The numbers are the same ones in `projected` — nothing here is
   * computed that is not already served structurally.
   */
  summary: string | null;
}

/** One row of the long-format store, as it comes back from pg. */
export interface PredictionRow {
  model_version: string;
  predicted_at: Date | string;
  game_date: Date | string;
  stat: string;
  quantile: number | string | null;
  value: number | string;
  conditional: boolean;
}

interface CacheEntry {
  data: PlayerPrediction | null;
  fetchedAt: number;
}

// short, because a prediction run lands at a fixed time each day but an injury
// scratch can invalidate the whole card an hour before tip. five minutes is the
// benchmarks.ts pattern with the TTL turned down for a fact that moves.
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

/** Drops every cached prediction so the next request re-reads. Used by tests. */
export function clearPredictionsCache(): void {
  cache.clear();
}

/**
 * pg returns NUMERIC as a string to avoid the precision loss a JS number would
 * cause. Everything here is a stat with at most two meaningful decimals, so the
 * conversion is safe — but it has to be explicit, or `value` reaches the client
 * as `"18.40"` and every arithmetic comparison in the UI silently becomes a
 * string comparison.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `YYYY-MM-DD` from a pg DATE, read off local calendar fields (see analytics.ts). */
function toIsoDay(value: unknown): string | null {
  if (value instanceof Date) {
    const y = String(value.getFullYear()).padStart(4, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return match ? match[1] : null;
  }
  return null;
}

function toIsoInstant(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * A complete P10/P50/P90 triple, or null. Partial ranges are dropped rather
 * than filled in: a range missing its top is not a narrower range, it is an
 * unreadable one, and the sort is what keeps a rendered interval from reading
 * backwards even if the store somehow holds a crossed set.
 */
function toRange(byQuantile: Map<number, number>): QuantileRange | null {
  const p10 = byQuantile.get(P10);
  const p50 = byQuantile.get(P50);
  const p90 = byQuantile.get(P90);
  if (p10 === undefined || p50 === undefined || p90 === undefined) return null;

  const [lo, mid, hi] = [p10, p50, p90].sort((a, b) => a - b);
  return { p10: round(lo, 2), p50: round(mid, 2), p90: round(hi, 2) };
}

function formatRange(range: QuantileRange | null, unit: string): string | null {
  if (!range) return null;
  return `${range.p50.toFixed(1)} ${unit} (${range.p10.toFixed(1)}-${range.p90.toFixed(1)})`;
}

/**
 * The one-line reading of the card, in the order a start/sit decision needs it:
 * will he play, how long, how much, and what that is worth over the schedule.
 */
function buildSummary(prediction: Omit<PlayerPrediction, 'summary'>): string | null {
  const parts: string[] = [];
  if (prediction.prob_active !== null) {
    parts.push(`${Math.round(prediction.prob_active * 100)}% to play`);
  }
  const minutes = formatRange(prediction.projected.minutes, 'min');
  if (minutes) parts.push(minutes);
  const points = formatRange(prediction.projected.pts, 'pts');
  if (points) parts.push(points);
  if (parts.length === 0) return null;

  const tail =
    prediction.unconditional_pts === null
      ? ''
      : `, ${prediction.unconditional_pts.toFixed(1)} pts averaged over the schedule`;
  return `${parts.join(', ')} if he plays${tail}.`;
}

/**
 * Long-format rows for one player-game into the served object. Pure — the
 * database access lives in `getLatestPredictionForPlayer` — so the reshaping
 * rules are testable without a connection.
 *
 * Returns null for an empty row set, which is the same answer the caller gives
 * for "no run exists": the page hides the card either way, and distinguishing
 * "the model has never run" from "the model has nothing for this player" is not
 * a distinction the UI can act on.
 */
export function pivotPredictionRows(rows: PredictionRow[]): PlayerPrediction | null {
  if (rows.length === 0) return null;

  const first = rows[0];
  const gameDate = toIsoDay(first.game_date);
  const asOf = toIsoInstant(first.predicted_at);
  if (!gameDate || !asOf) return null;

  const expected = new Map<string, number>();
  const quantiles = new Map<string, Map<number, number>>();
  let probActive: number | null = null;

  for (const row of rows) {
    const value = num(row.value);
    if (value === null) continue;
    const quantile = num(row.quantile);

    if (quantile === null) {
      if (row.stat === PROB_ACTIVE) {
        // clamped on write too, but a probability arriving from storage is
        // still just a number, and the card renders it as a percentage.
        probActive = Math.min(Math.max(value, 0), 1);
        continue;
      }
      expected.set(row.stat, value);
      continue;
    }

    const forStat = quantiles.get(row.stat) ?? new Map<number, number>();
    forStat.set(quantile, value);
    quantiles.set(row.stat, forStat);
  }

  const minutesQuantiles = quantiles.get('minutes');
  const ptsQuantiles = quantiles.get('pts');
  const projected: ProjectedStats = {
    minutes: minutesQuantiles ? toRange(minutesQuantiles) : null,
    pts: ptsQuantiles ? toRange(ptsQuantiles) : null,
    reb: null,
    ast: null,
    stl: null,
    blk: null,
    tov: null,
    fg3m: null,
  };

  for (const stat of POINT_STATS) {
    const value = expected.get(stat);
    projected[stat] = value === undefined ? null : round(value, 2);
  }

  const unconditionalPts = expected.get(`pts${UNCOND_SUFFIX}`);
  const base: Omit<PlayerPrediction, 'summary'> = {
    as_of: asOf,
    model_version: String(first.model_version ?? ''),
    game_date: gameDate,
    prob_active: probActive === null ? null : round(probActive, 4),
    projected,
    conditional: true,
    unconditional_pts: unconditionalPts === undefined ? null : round(unconditionalPts, 2),
  };

  return { ...base, summary: buildSummary(base) };
}

/**
 * The newest complete run's rows for this player's next game, in one round
 * trip.
 *
 * Three constraints are folded into the single statement rather than into three
 * queries, because each one filters the next:
 *   - `status = 'complete'` — a killed run leaves a partial slate, and half a
 *     slate looks identical to a whole one once it is stored.
 *   - newest `predicted_at` — a run supersedes its predecessors; older rows stay
 *     in the table forever for backtesting and must never be served.
 *   - the earliest `game_date >= CURRENT_DATE` FOR THAT PLAYER, not for the
 *     league. Teams play on different nights, so "the next game" is a per-player
 *     question and a league-wide date would return nothing for two thirds of
 *     the roster.
 */
const LATEST_PREDICTION_SQL = `
  WITH latest_run AS (
    SELECT id, model_version, predicted_at
    FROM prediction_runs
    WHERE status = 'complete'
    ORDER BY predicted_at DESC
    LIMIT 1
  ),
  next_game AS (
    SELECT p.game_date
    FROM player_game_predictions p
    JOIN latest_run r ON r.id = p.prediction_run_id
    WHERE p.nba_player_id = $1
      AND p.game_date >= CURRENT_DATE
    ORDER BY p.game_date ASC
    LIMIT 1
  )
  SELECT r.model_version,
         r.predicted_at,
         p.game_date,
         p.stat,
         p.quantile::float AS quantile,
         p.value::float    AS value,
         p.conditional
  FROM player_game_predictions p
  JOIN latest_run r ON r.id = p.prediction_run_id
  JOIN next_game g  ON g.game_date = p.game_date
  WHERE p.nba_player_id = $1
`;

/**
 * The stored forecast for this player's next game, or null.
 *
 * Null is returned for every "we don't have one" case, including a failed
 * query. That is deliberate: migration 014 is applied by hand against two
 * databases (see 013's note on `schema_migrations`), so there is a real window
 * in which the tables do not exist yet. A player analytics page that 500s
 * because an optional card has no table behind it is a worse outcome than a
 * page without the card.
 */
export async function getLatestPredictionForPlayer(
  nbaPlayerId: string | null
): Promise<PlayerPrediction | null> {
  if (!nbaPlayerId) return null;

  const cached = cache.get(nbaPlayerId);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.data;

  let data: PlayerPrediction | null = null;
  try {
    const result = await query(LATEST_PREDICTION_SQL, [nbaPlayerId]);
    data = pivotPredictionRows(result.rows as PredictionRow[]);
  } catch {
    // cached as null below, so a missing table costs one query per player per
    // five minutes rather than one per request.
    data = null;
  }

  cache.set(nbaPlayerId, { data, fetchedAt: Date.now() });
  return data;
}
