import { query } from '../db.js';
import { etIsoDate } from './dates.js';

/**
 * The day's slate: every scheduled game plus the players the latest model run
 * projects to matter in it.
 *
 * This file is the only place that reads `prediction_runs` /
 * `player_game_predictions`, so the rest of the backend stays ignorant of the
 * prediction schema. Both of those tables (and `nba_schedule`) arrive in
 * migrations 013/014 — every read here degrades to "no data yet" when they are
 * absent rather than failing the request, so the endpoint is safe to deploy
 * ahead of the migration.
 */

/** Players returned per game, ranked by projected points. */
export const TOP_PLAYERS_PER_GAME = 8;

/**
 * `prediction_runs.status` value for a run whose rows are all written. Only
 * complete runs are ever served — a half-written run would show a slate with
 * arbitrary games missing.
 */
export const COMPLETE_RUN_STATUS = 'complete';

/**
 * `stat` keys read out of `player_game_predictions`. The expected (mean) row
 * for a stat carries `quantile IS NULL`; 0.10/0.50/0.90 rows are the interval.
 */
export const PROB_ACTIVE_STAT = 'prob_active';
export const MINUTES_STAT = 'minutes';
export const POINTS_STAT = 'pts';

/** The quantile the projected minutes line is read from. */
export const MINUTES_QUANTILE = 0.5;

export interface SlateRun {
  model_version: string;
  /** ISO timestamp the run was produced at. */
  predicted_at: string | null;
}

export interface SlatePlayer {
  nba_player_id: string;
  name: string;
  team_abbr: string | null;
  /** Modelled probability the player appears at all, 0-1. */
  prob_active: number | null;
  /** Unconditional expected points — already multiplied through by availability. */
  proj_pts: number | null;
  /** Median projected minutes. */
  proj_min_p50: number | null;
}

export interface SlateGame {
  nba_game_id: string;
  game_status: string | null;
  home_team_id: string | null;
  home_team_abbr: string | null;
  away_team_id: string | null;
  away_team_abbr: string | null;
  players: SlatePlayer[];
}

export interface SlateResponse {
  date: string;
  run: SlateRun | null;
  games: SlateGame[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a `?date=` parameter. Absent means "today in ET" — NBA game days
 * are anchored to the Eastern calendar, so the Lambda's UTC clock would roll
 * the slate over at 7pm local.
 *
 * An unparseable or non-calendar date (2026-02-31) is rejected rather than
 * clamped: silently answering for a different day is a wrong answer.
 */
export function parsePredictionDate(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return etIsoDate(0);
  if (typeof raw !== 'string' || !ISO_DAY.test(raw)) return null;
  // round-trips only for real calendar days: Date.UTC normalizes Feb 31 to
  // Mar 3, which then fails the string comparison.
  const [y, m, d] = raw.split('-').map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(asUtc.getTime())) return null;
  return asUtc.toISOString().slice(0, 10) === raw ? raw : null;
}

/** Coerces a pg NUMERIC (which arrives as a string) to a number, or null. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Fixed-precision rounding that preserves null rather than turning it into 0. */
export function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** `YYYY-MM-DD` for a pg DATE, read off local calendar fields (see analytics.ts). */
export function toIsoDay(value: unknown): string | null {
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

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * True for the two pg errors that mean "this migration hasn't been applied
 * here yet" — undefined_table and undefined_column. Those are an expected
 * state for a deploy that lands ahead of 013/014, so callers answer with an
 * empty payload. Every other error still propagates: a database that is down
 * must not be reported as a quiet day with no games.
 */
export function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === '42P01' || code === '42703';
}

/**
 * Rows from a query that is allowed not to have a table yet — an absent
 * relation reads as "no rows". Exported so the watchlist reads the same
 * prediction tables under the same rule.
 */
export async function rowsOrEmpty<T>(fn: () => Promise<{ rows: unknown[] }>): Promise<T[]> {
  try {
    return (await fn()).rows as T[];
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}

interface RunRow {
  id: unknown;
  model_version: unknown;
  predicted_at: unknown;
}

/** ISO timestamp for a pg TIMESTAMPTZ, which arrives as a Date under `pg`. */
function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * The newest complete run, or null when no run has finished (or the tables do
 * not exist yet). Exported because the watchlist scores against the same run.
 */
export async function getLatestCompleteRun(): Promise<(SlateRun & { id: number }) | null> {
  const rows = await rowsOrEmpty<RunRow>(() =>
    query(
      `SELECT id, model_version, predicted_at
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
    predicted_at: toIsoTimestamp(row.predicted_at),
  };
}

interface ScheduleRow {
  nba_game_id: unknown;
  game_status: unknown;
  home_team_id: unknown;
  away_team_id: unknown;
}

async function fetchSchedule(date: string): Promise<ScheduleRow[]> {
  return rowsOrEmpty<ScheduleRow>(() =>
    query(
      `SELECT nba_game_id, game_status, home_team_id, away_team_id
       FROM nba_schedule
       WHERE game_date = $1
       ORDER BY nba_game_id`,
      [date]
    )
  );
}

/**
 * team_id -> abbreviation. `nba_schedule` stores ids only, and the game logs
 * are the one table that carries both, so the mapping is read from there
 * exactly as analytics.ts does.
 */
async function fetchTeamAbbrs(): Promise<Map<string, string>> {
  const rows = await rowsOrEmpty<{ team_id: unknown; team_abbr: unknown }>(() =>
    query(
      `SELECT DISTINCT team_id, team_abbr
       FROM player_game_logs
       WHERE team_abbr IS NOT NULL`
    )
  );

  const map = new Map<string, string>();
  for (const row of rows) map.set(String(row.team_id), String(row.team_abbr));
  return map;
}

interface PredictionRow {
  nba_game_id: unknown;
  nba_player_id: unknown;
  name: unknown;
  team_abbr: unknown;
  prob_active: unknown;
  proj_pts: unknown;
  proj_min_p50: unknown;
}

/**
 * One row per (game, player) for the run, pivoting the long prediction table
 * into the three numbers the slate shows. The pivot happens in SQL so a game
 * with 30 players still costs one round trip.
 *
 * `proj_pts` is deliberately the UNCONDITIONAL expectation (`conditional =
 * false`): a 40-point projection that assumes the player suits up is not
 * comparable across a slate where some of those players are game-time
 * decisions.
 */
async function fetchPredictions(runId: number, date: string): Promise<PredictionRow[]> {
  return rowsOrEmpty<PredictionRow>(() =>
    query(
      `SELECT pgp.nba_game_id,
              pgp.nba_player_id,
              MAX(p.name) AS name,
              MAX(p.team) AS team_abbr,
              MAX(CASE WHEN pgp.stat = $3 AND pgp.quantile IS NULL
                       THEN pgp.value END)::float AS prob_active,
              MAX(CASE WHEN pgp.stat = $4 AND pgp.quantile IS NULL AND pgp.conditional = false
                       THEN pgp.value END)::float AS proj_pts,
              MAX(CASE WHEN pgp.stat = $5 AND pgp.quantile = $6
                       THEN pgp.value END)::float AS proj_min_p50
       FROM player_game_predictions pgp
       LEFT JOIN players p ON p.nba_id = pgp.nba_player_id
       WHERE pgp.prediction_run_id = $1
         AND pgp.game_date = $2
       GROUP BY pgp.nba_game_id, pgp.nba_player_id`,
      [runId, date, PROB_ACTIVE_STAT, POINTS_STAT, MINUTES_STAT, MINUTES_QUANTILE]
    )
  );
}

/**
 * Best projected points first. Players the run has no points row for sort to
 * the bottom rather than to the top (a null is "unknown", not "zero"), and
 * name breaks ties so the order is stable across identical projections.
 */
export function rankSlatePlayers(
  players: SlatePlayer[],
  limit: number = TOP_PLAYERS_PER_GAME
): SlatePlayer[] {
  return [...players]
    .sort((a, b) => {
      const aPts = a.proj_pts;
      const bPts = b.proj_pts;
      if (aPts === null && bPts === null) return a.name.localeCompare(b.name);
      if (aPts === null) return 1;
      if (bPts === null) return -1;
      return bPts - aPts || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/**
 * The slate for one ET calendar day. Never throws for missing data: no
 * schedule gives an empty `games` array, no finished run gives `run: null`
 * with every game's `players` empty, and the page renders its own empty state
 * off those.
 */
export async function getSlate(date: string): Promise<SlateResponse> {
  const schedule = await fetchSchedule(date);
  const run = await getLatestCompleteRun();
  const runSummary = run ? { model_version: run.model_version, predicted_at: run.predicted_at } : null;

  // no games means nothing to hang predictions off; skip the remaining round
  // trips entirely.
  if (schedule.length === 0) return { date, run: runSummary, games: [] };

  const teamAbbrs = await fetchTeamAbbrs();
  const predictions = run ? await fetchPredictions(run.id, date) : [];

  const byGame = new Map<string, SlatePlayer[]>();
  for (const row of predictions) {
    const gameId = String(row.nba_game_id);
    const list = byGame.get(gameId) ?? [];
    list.push({
      nba_player_id: String(row.nba_player_id),
      name: String(row.name ?? ''),
      team_abbr: text(row.team_abbr),
      prob_active: round(num(row.prob_active), 3),
      proj_pts: round(num(row.proj_pts), 1),
      proj_min_p50: round(num(row.proj_min_p50), 1),
    });
    byGame.set(gameId, list);
  }

  const games: SlateGame[] = schedule.map((row) => {
    const homeId = text(row.home_team_id);
    const awayId = text(row.away_team_id);
    return {
      nba_game_id: String(row.nba_game_id),
      game_status: text(row.game_status),
      home_team_id: homeId,
      home_team_abbr: homeId ? teamAbbrs.get(homeId) ?? null : null,
      away_team_id: awayId,
      away_team_abbr: awayId ? teamAbbrs.get(awayId) ?? null : null,
      players: rankSlatePlayers(byGame.get(String(row.nba_game_id)) ?? []),
    };
  });

  return { date, run: runSummary, games };
}
