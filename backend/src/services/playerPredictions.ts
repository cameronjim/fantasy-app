import { query } from '../db.js';
import { COMPLETE_RUN_STATUS, rowsOrEmpty } from './slate.js';

// serving every stored forecast for one player, not just his next game.
//
// services/predictions.ts answers "what does the model say about tonight" and
// collapses the answer into a single card. This file answers the other half of
// the question a manager actually asks — "what does the rest of his week look
// like" — and so it stays in the long format the store uses: one entry per
// scheduled game, and inside each entry whatever stats the run happened to
// emit.
//
// THE STAT VOCABULARY IS NOT HARDCODED HERE, ON PURPOSE. Migration 014 says the
// stat list is expected to grow (reb/stl/blk/tov/fg3m/fgm/fga/ftm/fta are being
// added to the emission path as this is written). A serving layer with a fixed
// list of stats silently drops every new one until someone remembers to edit
// it, and the omission looks exactly like "the model didn't predict that".
// Everything below pivots by whatever `stat` values come back, and the response
// carries the resulting key list so the UI can build its own columns.

/** `<stat>_uncond` is the schedule-level twin of the bare `<stat>`. */
const UNCOND_SUFFIX = '_uncond';

/** P(he plays). Blended/served probability. */
const PROB_ACTIVE = 'prob_active';
/** The raw model probability before any official-designation override. */
const PROB_ACTIVE_MODEL = 'prob_active_model';

/** Stat keys that describe availability rather than production. */
const AVAILABILITY_STATS = new Set<string>([PROB_ACTIVE, PROB_ACTIVE_MODEL]);

/**
 * Display order for the stat keys the response advertises. Anything a run emits
 * that is not on this list still comes back — it is sorted alphabetically after
 * the known ones rather than dropped, so a newly emitted stat appears on the
 * page the day it is first written.
 */
const STAT_ORDER = [
  'minutes',
  'pts',
  'reb',
  'ast',
  'stl',
  'blk',
  'tov',
  'fg3m',
  'fgm',
  'fga',
  'ftm',
  'fta',
] as const;

/** Games returned when the caller does not ask for a different number. */
export const DEFAULT_UPCOMING_LIMIT = 14;
/** Hard ceiling, so a hand-typed `?limit=100000` cannot ask for a whole season. */
export const MAX_UPCOMING_LIMIT = 60;

const P10 = 0.1;
const P50 = 0.5;
const P90 = 0.9;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One stat for one player-game. Every field is nullable: a run that emits an
 *  expected value but no quantiles is normal, and so is the reverse. */
export interface PredictionStatLine {
  /** The conditional expected value — a mean, "given he plays". */
  expected: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** `<stat>_uncond`: the same estimate with P(play) already multiplied in. */
  unconditional: number | null;
}

export interface UpcomingGamePrediction {
  nba_game_id: string;
  /** `YYYY-MM-DD`. */
  game_date: string;
  /** The other team's abbreviation, or null when the schedule row is missing. */
  opponent_abbr: string | null;
  /** Null when the player's current team matches neither side of the game. */
  is_home: boolean | null;
  /** Source-reported status text ('Final', '7:30 pm ET', 'PPD'), or null. */
  game_status: string | null;
  /** P(he plays), 0-1. A model probability, never an official designation. */
  prob_active: number | null;
  /** The pre-override model probability, when the run stores one separately. */
  prob_active_model: number | null;
  /** Keyed by stat name — whatever the run emitted for this player-game. */
  stats: Record<string, PredictionStatLine>;
}

export interface PredictionRunMeta {
  id: number;
  model_version: string;
  feature_version: string | null;
  predicted_at: string | null;
  /** The information boundary: nothing at or after this was visible to the run. */
  forecast_cutoff_at: string | null;
  /**
   * The `horizon=...` clause of the run's notes, when it has one. Cheap to
   * read and the one part of a free-text note the UI can say something honest
   * about ("scored at T-6h on game day" is a different claim from a projection
   * made a week out).
   */
  horizon: string | null;
}

export interface PlayerPredictionsResponse {
  player_id: number;
  nba_player_id: string | null;
  /** Null when no run has ever completed — an empty page, not an error. */
  run: PredictionRunMeta | null;
  /** Every stat key present across `games`, in display order. */
  stats: string[];
  /** Ordered by game date, earliest first. */
  games: UpcomingGamePrediction[];
}

export interface UpcomingOptions {
  /**
   * The player's current team abbreviation. Decides home/away and therefore
   * which side of the schedule row is the opponent; the caller already has it
   * from the players row it looked the id up in, so it is passed rather than
   * re-queried.
   */
  teamAbbr?: string | null;
  /** Inclusive lower bound on game_date, or null for "everything in the run". */
  from?: string | null;
  limit?: number;
}

/** One row of the long-format store joined to its schedule row. */
export interface UpcomingPredictionRow {
  nba_game_id: unknown;
  game_date: unknown;
  home_team_abbr: unknown;
  away_team_abbr: unknown;
  game_status: unknown;
  stat: unknown;
  quantile: unknown;
  value: unknown;
  conditional: unknown;
}

/**
 * `?from=` validation. Absent means NO FILTER, deliberately unlike
 * slate.ts's `parsePredictionDate`, which defaults to today: the only run on
 * either database right now is a January backtest, and a serving default of
 * "today onwards" would render every player's page empty while looking
 * perfectly healthy. A caller that wants future games asks for them.
 *
 * Returns `null` for "no filter" and `false` for "the caller sent something
 * that is not a calendar day", which is a 400 rather than a silent full scan.
 */
export function parseFromDate(raw: unknown): string | null | false {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !ISO_DAY.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(asUtc.getTime())) return false;
  // Feb 31 normalizes to Mar 3 and then fails this comparison.
  return asUtc.toISOString().slice(0, 10) === raw ? raw : false;
}

/**
 * `?limit=` validation. Absent is the default; anything that is not a whole
 * number in [1, MAX_UPCOMING_LIMIT] is `false` (a 400) rather than clamped —
 * quietly returning 60 rows to someone who asked for 500 is a wrong answer
 * dressed as a right one.
 */
export function parseLimit(raw: unknown): number | false {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_UPCOMING_LIMIT;
  if (typeof raw !== 'string' && typeof raw !== 'number') return false;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_UPCOMING_LIMIT) return false;
  return parsed;
}

/** pg returns NUMERIC as a string; every value here is a stat, so the cast is safe. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value);
  return str === '' ? null : str;
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
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The `horizon=...` clause out of a run's free-text notes, e.g.
 * "horizon=gameday (T-6h)". Null when the note does not carry one — this is a
 * convenience, not a contract, so it never guesses.
 */
export function horizonFromNotes(notes: unknown): string | null {
  if (typeof notes !== 'string') return null;
  const match = /horizon\s*=\s*([^;\n]+)/i.exec(notes);
  return match ? match[1].trim() || null : null;
}

/**
 * Stat keys in display order: the known ones first in the order a box score
 * reads, then anything else alphabetically. Unknown keys are appended rather
 * than dropped — see the file header.
 */
export function orderStatKeys(keys: Iterable<string>): string[] {
  const known: string[] = [];
  const unknown: string[] = [];
  const seen = new Set(keys);
  for (const key of STAT_ORDER) if (seen.has(key)) known.push(key);
  for (const key of seen) if (!STAT_ORDER.includes(key as (typeof STAT_ORDER)[number])) unknown.push(key);
  unknown.sort();
  return [...known, ...unknown];
}

function emptyLine(): PredictionStatLine {
  return { expected: null, p10: null, p50: null, p90: null, unconditional: null };
}

/**
 * Long-format rows into one entry per game. Pure — the database access lives in
 * `getUpcomingPredictionsForPlayer` — so the pivot rules are testable without a
 * connection.
 *
 * `playerTeamAbbr` is what decides home/away: `nba_schedule` stores both sides
 * of a game and nothing in the prediction row says which one the player is on.
 * A player whose current team matches neither side (traded since the run, or a
 * stale `players.team`) gets `is_home: null` and `opponent_abbr: null` rather
 * than a coin-flip guess.
 */
export function pivotUpcomingRows(
  rows: UpcomingPredictionRow[],
  playerTeamAbbr: string | null
): UpcomingGamePrediction[] {
  const byGame = new Map<string, UpcomingGamePrediction>();
  // pg preserves the ORDER BY, but the map is keyed by game id, so the output
  // order is rebuilt from the dates rather than trusted from insertion.
  const quantiles = new Map<string, Map<string, Map<number, number>>>();

  for (const row of rows) {
    const gameId = text(row.nba_game_id);
    const gameDate = toIsoDay(row.game_date);
    if (!gameId || !gameDate) continue;

    let game = byGame.get(gameId);
    if (!game) {
      const home = text(row.home_team_abbr);
      const away = text(row.away_team_abbr);
      const isHome = playerTeamAbbr && home === playerTeamAbbr
        ? true
        : playerTeamAbbr && away === playerTeamAbbr
          ? false
          : null;
      game = {
        nba_game_id: gameId,
        game_date: gameDate,
        opponent_abbr: isHome === null ? null : isHome ? away : home,
        is_home: isHome,
        game_status: text(row.game_status),
        prob_active: null,
        prob_active_model: null,
        stats: {},
      };
      byGame.set(gameId, game);
      quantiles.set(gameId, new Map());
    }

    const stat = text(row.stat);
    const value = num(row.value);
    if (!stat || value === null) continue;
    const quantile = num(row.quantile);

    if (quantile === null && AVAILABILITY_STATS.has(stat)) {
      // clamped on read as well as on write: a probability arriving from
      // storage is still just a number, and the UI renders it as a percentage.
      const clamped = Math.min(Math.max(value, 0), 1);
      if (stat === PROB_ACTIVE) game.prob_active = round(clamped, 4);
      else game.prob_active_model = round(clamped, 4);
      continue;
    }

    const isUncond = stat.endsWith(UNCOND_SUFFIX);
    const base = isUncond ? stat.slice(0, -UNCOND_SUFFIX.length) : stat;
    if (!base) continue;

    const line = game.stats[base] ?? emptyLine();
    game.stats[base] = line;

    if (quantile === null) {
      if (isUncond) line.unconditional = round(value, 2);
      else line.expected = round(value, 2);
      continue;
    }

    // quantiles are only meaningful on the conditional series; an unconditional
    // quantile would be a different distribution and the store does not emit one.
    if (isUncond) continue;
    const forGame = quantiles.get(gameId)!;
    const forStat = forGame.get(base) ?? new Map<number, number>();
    forStat.set(quantile, value);
    forGame.set(base, forStat);
  }

  for (const [gameId, game] of byGame) {
    for (const [stat, byQuantile] of quantiles.get(gameId) ?? []) {
      const line = game.stats[stat] ?? emptyLine();
      game.stats[stat] = line;
      const p10 = byQuantile.get(P10);
      const p50 = byQuantile.get(P50);
      const p90 = byQuantile.get(P90);
      // each quantile stands on its own: a run that stores a median but no tail
      // still gets its median served, and the band simply does not render.
      line.p10 = p10 === undefined ? null : round(p10, 2);
      line.p50 = p50 === undefined ? null : round(p50, 2);
      line.p90 = p90 === undefined ? null : round(p90, 2);
    }
  }

  return [...byGame.values()].sort(
    (a, b) => a.game_date.localeCompare(b.game_date) || a.nba_game_id.localeCompare(b.nba_game_id)
  );
}

/** Every stat key any of these games carries, in display order. */
export function collectStatKeys(games: UpcomingGamePrediction[]): string[] {
  const keys = new Set<string>();
  for (const game of games) for (const key of Object.keys(game.stats)) keys.add(key);
  return orderStatKeys(keys);
}

interface RunRow {
  id: unknown;
  model_version: unknown;
  feature_version: unknown;
  predicted_at: unknown;
  forecast_cutoff_at: unknown;
  notes: unknown;
}

/**
 * The newest complete run, with the provenance columns the slate does not need.
 * Separate from `slate.getLatestCompleteRun` rather than an extension of it so
 * the slate's payload does not grow a cutoff timestamp it never renders.
 *
 * Returns null when no run has finished, and also when migration 014 has not
 * been applied here yet — the tables are applied by hand against two databases,
 * and a player page that 500s because an optional section has no table behind
 * it is a worse outcome than a page without the section.
 */
export async function getLatestRunMeta(): Promise<PredictionRunMeta | null> {
  const rows = await rowsOrEmpty<RunRow>(() =>
    query(
      `SELECT id, model_version, feature_version, predicted_at, forecast_cutoff_at, notes
       FROM prediction_runs
       WHERE status = $1
       ORDER BY predicted_at DESC, id DESC
       LIMIT 1`,
      [COMPLETE_RUN_STATUS]
    )
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    model_version: String(row.model_version ?? ''),
    feature_version: text(row.feature_version),
    predicted_at: toIsoInstant(row.predicted_at),
    forecast_cutoff_at: toIsoInstant(row.forecast_cutoff_at),
    horizon: horizonFromNotes(row.notes),
  };
}

/**
 * One round trip for the whole section.
 *
 * The inner CTE picks the games first — grouped, ordered and limited — so
 * `?limit=14` means fourteen GAMES rather than fourteen of the ~14 long-format
 * rows each game produces. The outer join then pulls every stat row for exactly
 * those games. `nba_schedule` is a LEFT JOIN because a prediction outliving its
 * schedule row (a rescheduled or purged game) should still serve its numbers
 * with an unknown opponent, not vanish.
 */
const UPCOMING_SQL = `
  WITH games AS (
    SELECT nba_game_id, MIN(game_date) AS game_date
    FROM player_game_predictions
    WHERE prediction_run_id = $1
      AND nba_player_id = $2
      AND ($3::date IS NULL OR game_date >= $3::date)
    GROUP BY nba_game_id
    ORDER BY MIN(game_date) ASC, nba_game_id ASC
    LIMIT $4
  )
  SELECT g.nba_game_id,
         g.game_date,
         s.home_team_abbr,
         s.away_team_abbr,
         s.game_status,
         p.stat,
         p.quantile::float AS quantile,
         p.value::float    AS value,
         p.conditional
  FROM games g
  JOIN player_game_predictions p
    ON p.prediction_run_id = $1
   AND p.nba_player_id = $2
   AND p.nba_game_id = g.nba_game_id
  LEFT JOIN nba_schedule s ON s.nba_game_id = g.nba_game_id
  ORDER BY g.game_date ASC, g.nba_game_id ASC, p.stat ASC
`;

interface CacheEntry {
  data: Omit<PlayerPredictionsResponse, 'player_id' | 'nba_player_id'>;
  fetchedAt: number;
}

// same five minutes as services/predictions.ts: a run lands at a fixed time
// each day, but an injury scratch can invalidate a whole week of rows an hour
// before tip.
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

/** Drops every cached player. Used by tests. */
export function clearUpcomingPredictionsCache(): void {
  cache.clear();
}

/**
 * Every game the latest complete run has a prediction for, for one player.
 *
 * Empty is a normal answer with two distinct causes, both 200s: no run has
 * completed (`run: null`), or the run simply has nothing for this player
 * (`run` populated, `games: []`). The UI says something different for each, so
 * they are not collapsed the way services/predictions.ts collapses them.
 */
export async function getUpcomingPredictionsForPlayer(
  nbaPlayerId: string | null,
  options: UpcomingOptions = {}
): Promise<Omit<PlayerPredictionsResponse, 'player_id' | 'nba_player_id'>> {
  const from = options.from ?? null;
  const limit = options.limit ?? DEFAULT_UPCOMING_LIMIT;
  if (!nbaPlayerId) return { run: null, stats: [], games: [] };

  const cacheKey = `${nbaPlayerId}|${from ?? ''}|${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.data;

  const run = await getLatestRunMeta();
  if (!run) {
    const empty = { run: null, stats: [], games: [] };
    cache.set(cacheKey, { data: empty, fetchedAt: Date.now() });
    return empty;
  }

  const rows = await rowsOrEmpty<UpcomingPredictionRow>(() =>
    query(UPCOMING_SQL, [run.id, nbaPlayerId, from, limit])
  );

  const games = pivotUpcomingRows(rows, options.teamAbbr ?? null);
  const data = { run, stats: collectStatKeys(games), games };
  cache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}
