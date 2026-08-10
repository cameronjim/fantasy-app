import { query } from '../db.js';
import { etIsoDate } from './dates.js';
import { mean, stddev } from './analytics.js';

/**
 * The day's slate: every scheduled game plus the players the latest model run
 * projects to matter in it, ranked by their projected TOTAL fantasy impact
 * rather than by points alone.
 *
 * This file owns the slate's reads of `prediction_runs` /
 * `player_game_predictions` and the shared helpers the other readers of those
 * tables borrow (`getLatestCompleteRun`, `rowsOrEmpty`, the stat-name
 * vocabulary below) — `playerPredictions.ts`, `watchlist.ts` and `ai.ts` each
 * query them for their own surface. Both tables (and `nba_schedule`) arrive in
 * migrations 013/014 — every read here degrades to "no data yet" when they are
 * absent rather than failing the request, so the endpoint is safe to deploy
 * ahead of the migration.
 */

/** Players returned per game, ranked by projected fantasy impact. */
export const TOP_PLAYERS_PER_GAME = 8;

/**
 * `prediction_runs.status` value for a run whose rows are all written. Only
 * complete runs are ever served — a half-written run would show a slate with
 * arbitrary games missing.
 */
export const COMPLETE_RUN_STATUS = 'complete';

/**
 * ============================ STAT VOCABULARY ============================
 * Migration 014 stores two axes that are easy to confuse, and asking for the
 * wrong COMBINATION of them returns NO ROWS rather than a wrong number:
 *
 *   the stat NAME carries the conditional/unconditional distinction. The bare
 *   name ('pts') is the "given he plays" estimate, and its rows are
 *   `conditional = true`. The schedule-level expectation — already multiplied
 *   through by P(play) — is a stat name of its OWN ('pts_uncond'), and those
 *   rows are the `conditional = false` ones.
 *
 *   the `quantile` column carries mean-vs-interval. NULL is the expected value;
 *   0.10/0.50/0.90 are the empirical interval, and only the conditional series
 *   has them.
 *
 * So the unconditional expectation for a stat is
 * `stat = '<name>_uncond' AND quantile IS NULL`. Filtering
 * `stat = '<name>' AND conditional = false` matches nothing at all — the two
 * halves contradict each other by construction. That combination was the
 * original bug here, and because a no-rows pivot is a NULL rather than an
 * error it presented as every player showing "- pts", with the ranking
 * silently degrading to alphabetical.
 * ========================================================================
 */
export const UNCOND_SUFFIX = '_uncond';

/** The schedule-level twin of a bare stat name. See the block above. */
export function uncondStat(stat: string): string {
  return `${stat}${UNCOND_SUFFIX}`;
}

/** P(he plays at all). Unconditional by construction, `quantile IS NULL`. */
export const PROB_ACTIVE_STAT = 'prob_active';
/** Read for its P50 row only — the median minutes line the card shows. */
export const MINUTES_STAT = 'minutes';
export const POINTS_STAT = 'pts';
/** The stat name the projected-points column actually reads. */
export const POINTS_UNCOND_STAT = uncondStat(POINTS_STAT);

/** The quantile the projected minutes line is read from. */
export const MINUTES_QUANTILE = 0.5;

/**
 * Box-score stats pivoted for the slate, every one of them read as
 * `<stat>_uncond` so the numbers stay comparable across a slate on which some
 * players are game-time decisions. `fgm`/`fga`/`ftm`/`fta` are never shown —
 * they are here so the percentage categories can be scored by volume (see
 * `categoryValues`).
 */
export const PROJECTED_STATS = [
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

export type ProjectedStat = (typeof PROJECTED_STATS)[number];

/** The subset carried in the payload as a compact per-category line. */
export const DISPLAY_CATEGORIES = ['reb', 'ast', 'stl', 'blk', 'tov', 'fg3m'] as const;

export type DisplayCategory = (typeof DISPLAY_CATEGORIES)[number];

/**
 * ======================= THE NINE FANTASY CATEGORIES =======================
 * The same nine categories `fantasyScore.ts::zScoreRank` values a season line
 * by, in the same order, so a player who rates well there rates well here.
 *
 * `fg` and `ft` are not stored stats. A projected PERCENTAGE would rank three
 * dunks a game above twenty efficient attempts, so each is scored as
 * ATTEMPT-WEIGHTED EXCESS MAKES — `made - attempted * pool_rate` — the same
 * form `analytics.ts::attemptWeightedImpact` uses for season lines, and the
 * volume adjustment `zScoreRank` documents as not-yet-implemented for its own
 * naive percentages.
 * ===========================================================================
 */
export const IMPACT_CATEGORIES = [
  'pts',
  'reb',
  'ast',
  'stl',
  'blk',
  'fg3m',
  'fg',
  'ft',
  'tov',
] as const;

export type ImpactCategory = (typeof IMPACT_CATEGORIES)[number];

/** Categories where less is better, so the z-score is flipped before summing. */
export const REVERSED_IMPACT_CATEGORIES: ReadonlySet<ImpactCategory> = new Set<ImpactCategory>([
  'tov',
]);

/** Impact players highlighted inside one game card. */
export const SPOTLIGHT_PER_GAME = 3;
/** Impact players highlighted across the whole slate. */
export const SLATE_SPOTLIGHT_COUNT = 10;

/**
 * ================================ THE POOL ================================
 * Every z-score on this page is relative to ONE pool: all player-games the run
 * projects for this date, across every game on it. That is what makes "total
 * impact" mean "impact relative to tonight" — the same player rates differently
 * on a two-game Tuesday than on a full eleven-game Wednesday, and tonight is
 * the comparison a manager setting a lineup is actually making.
 *
 * Echoed in the response as `pool`, following the `analytics.ts` convention
 * (`POOL_KEY` / `POOL_LABEL` / `POOL_DEFINITION`), so the UI never hardcodes
 * the definition of a number it is displaying.
 * ==========================================================================
 */
export const IMPACT_POOL_KEY = 'slate';
export const IMPACT_POOL_LABEL = "Tonight's slate";
export const IMPACT_POOL_DEFINITION =
  "every player the run projects for this date, across all of the date's games";

/** Marks a placeholder name, so a reader knows it is an id and not a person. */
export const PLACEHOLDER_NAME_SUFFIX = '(new roster)';

export interface SlateRun {
  model_version: string;
  /** ISO timestamp the run was produced at. */
  predicted_at: string | null;
}

/** The reference set every impact z-score is measured against. */
export interface SlatePool {
  key: string;
  label: string;
  definition: string;
  sample_size: number;
}

/** Unconditional per-category projections, for the compact line under a name. */
export type SlateProjectedCategories = Record<DisplayCategory, number | null>;

export interface SlatePlayer {
  nba_player_id: string;
  name: string;
  /**
   * True when `name` is a placeholder built from the id because `players` has
   * no row for him. The UI renders it differently, and the ranking never lets
   * an unidentified player win a tie against a named one.
   */
  name_is_placeholder: boolean;
  team_abbr: string | null;
  /** Modelled probability the player appears at all, 0-1. */
  prob_active: number | null;
  /** Unconditional expected points — already multiplied through by availability. */
  proj_pts: number | null;
  /** Median projected minutes. */
  proj_min_p50: number | null;
  /** Unconditional expectations for the categories the card lists. */
  projected: SlateProjectedCategories;
  /**
   * Projected total fantasy impact: the sum of this player's z-scores across
   * the nine categories, measured against `pool`. 0 is an average night on this
   * slate; null means the run did not project every category in play for him.
   */
  impact: number | null;
  /** Top `SPOTLIGHT_PER_GAME` by impact inside this game. */
  spotlight: boolean;
  /** Top `SLATE_SPOTLIGHT_COUNT` by impact across the whole pool. */
  slate_spotlight: boolean;
}

export interface SlateGame {
  nba_game_id: string;
  game_status: string | null;
  home_team_id: string | null;
  home_team_abbr: string | null;
  away_team_id: string | null;
  away_team_abbr: string | null;
  /** The best impact in this game, which is what orders the game cards. */
  top_impact: number | null;
  players: SlatePlayer[];
}

export interface SlateResponse {
  date: string;
  run: SlateRun | null;
  pool: SlatePool;
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

/** One pivoted (game, player) row: fixed columns plus one per projected stat. */
type PredictionRow = {
  nba_game_id: unknown;
  nba_player_id: unknown;
  name: unknown;
  team_abbr: unknown;
  prob_active: unknown;
  proj_min_p50: unknown;
} & { [K in ProjectedStat]: unknown };

/**
 * Parameter layout for `fetchPredictions`: $1 run, $2 date, $3 prob_active,
 * $4 minutes, $5 the minutes quantile, then one per projected stat from $6.
 */
const PROJECTED_STAT_PARAM_OFFSET = 6;

/**
 * `MAX(CASE WHEN ...)` per projected stat, generated from `PROJECTED_STATS` so
 * a stat added to that list is read without editing SQL. The stat NAMES are
 * bound parameters; the only interpolated text is the column aliases, which are
 * this file's own constants and never request input.
 */
const PROJECTED_PIVOT_SQL = PROJECTED_STATS.map(
  (stat, i) =>
    `MAX(CASE WHEN pgp.stat = $${PROJECTED_STAT_PARAM_OFFSET + i} AND pgp.quantile IS NULL
                       THEN pgp.value END)::float AS ${stat}`
).join(',\n              ');

/**
 * One row per (game, player) for the run, pivoting the long prediction table
 * into the numbers the slate shows. The pivot happens in SQL so a game with 30
 * players still costs one round trip.
 *
 * Every production stat is read as `<stat>_uncond`, i.e. the UNCONDITIONAL
 * expectation: a 40-point projection that assumes the player suits up is not
 * comparable across a slate where some of those players are game-time
 * decisions. See the STAT VOCABULARY block for why the NAME is what carries
 * that, and why a `conditional = false` filter on the bare name cannot.
 *
 * `players` is a LEFT JOIN because the two tables churn independently
 * (migration 014 deliberately has no foreign key): an offseason signing or
 * rookie the season-stats scrape has not written yet has predictions and no
 * roster row, and dropping him would hide a player the model has an opinion
 * about. His `name` comes back NULL — see `resolvePlayerName`.
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
              MAX(CASE WHEN pgp.stat = $4 AND pgp.quantile = $5
                       THEN pgp.value END)::float AS proj_min_p50,
              ${PROJECTED_PIVOT_SQL}
       FROM player_game_predictions pgp
       LEFT JOIN players p ON p.nba_id = pgp.nba_player_id
       WHERE pgp.prediction_run_id = $1
         AND pgp.game_date = $2
       GROUP BY pgp.nba_game_id, pgp.nba_player_id`,
      [
        runId,
        date,
        PROB_ACTIVE_STAT,
        MINUTES_STAT,
        MINUTES_QUANTILE,
        ...PROJECTED_STATS.map(uncondStat),
      ]
    )
  );
}

/** The raw projections one player-game contributes to the impact computation. */
export type ImpactInput = Record<ProjectedStat, number | null>;

/**
 * A display name that is never blank.
 *
 * `players` and the prediction store churn independently, so a run can project
 * a player the season-stats scrape has never written a row for — offseason
 * additions and rookies, in practice. That used to render as an empty string,
 * which ALSO sorted first alphabetically and so put a nameless row at the top
 * of a game card.
 *
 * The placeholder keeps the id visible, so the row stays identifiable and is
 * obviously not a person's name. THE DURABLE FIX IS UPSTREAM: the scraper
 * should upsert every rostered player into `players` (out of scope here — the
 * scraper owns that table), at which point this branch stops firing on its own.
 */
export function resolvePlayerName(
  raw: unknown,
  nbaPlayerId: string
): { name: string; placeholder: boolean } {
  const trimmed = raw === null || raw === undefined ? '' : String(raw).trim();
  if (trimmed !== '') return { name: trimmed, placeholder: false };
  return { name: `NBA #${nbaPlayerId} ${PLACEHOLDER_NAME_SUFFIX}`, placeholder: true };
}

/** Sums a stat over the pool, treating a missing value as no contribution. */
function poolTotal(pool: ImpactInput[], stat: ProjectedStat): number {
  let total = 0;
  for (const entry of pool) total += entry[stat] ?? 0;
  return total;
}

/**
 * The pool's own conversion rates, the baseline the percentage categories are
 * measured against. A pool with no attempts has no rate, which leaves every
 * excess-makes value equal to the raw makes — the right degenerate answer,
 * since nobody can be above or below a baseline that does not exist.
 */
export function poolRates(pool: ImpactInput[]): { fg: number; ft: number } {
  const fga = poolTotal(pool, 'fga');
  const fta = poolTotal(pool, 'fta');
  return {
    fg: fga === 0 ? 0 : poolTotal(pool, 'fgm') / fga,
    ft: fta === 0 ? 0 : poolTotal(pool, 'ftm') / fta,
  };
}

/**
 * One player-game's nine category values, before z-scoring. The seven counting
 * stats pass through; `fg`/`ft` become attempt-weighted excess makes against
 * the pool rate, and are null when either half of the pair is missing.
 */
export function categoryValues(
  entry: ImpactInput,
  rates: { fg: number; ft: number }
): Record<ImpactCategory, number | null> {
  const excess = (made: number | null, attempted: number | null, rate: number): number | null =>
    made === null || attempted === null ? null : made - attempted * rate;

  return {
    pts: entry.pts,
    reb: entry.reb,
    ast: entry.ast,
    stl: entry.stl,
    blk: entry.blk,
    fg3m: entry.fg3m,
    fg: excess(entry.fgm, entry.fga, rates.fg),
    ft: excess(entry.ftm, entry.fta, rates.ft),
    tov: entry.tov,
  };
}

/**
 * Projected total fantasy impact per player-game, returned aligned with `pool`.
 *
 * Each category is z-scored against the pool and the z-scores are SUMMED, with
 * TOV flipped because fewer turnovers are better. That is
 * `fantasyScore.ts::zScoreRank`'s shape applied to one night's projections
 * instead of a season line — summed rather than averaged, so the number reads
 * as total impact rather than as impact per category. 0 is an average player on
 * this slate; a star is several points of z above it.
 *
 * A category counts only if the run emitted it for somebody: the stat
 * vocabulary is still growing (migration 014 says so), and a run that emits
 * three stats should rank on three rather than report nothing. But within the
 * categories that ARE in play a player needs all of them — summing a partial
 * set yields a number that looks comparable to a full one and is not, so an
 * incomplete player scores null and sorts as unknown rather than as bad.
 */
export function impactScores(pool: ImpactInput[]): Array<number | null> {
  if (pool.length === 0) return [];

  const rates = poolRates(pool);
  const values = pool.map((entry) => categoryValues(entry, rates));

  const inPlay: ImpactCategory[] = [];
  const shape = new Map<ImpactCategory, { m: number; sd: number }>();
  for (const cat of IMPACT_CATEGORIES) {
    const present = values
      .map((v) => v[cat])
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (present.length === 0) continue;
    inPlay.push(cat);
    shape.set(cat, { m: mean(present), sd: stddev(present) });
  }

  if (inPlay.length === 0) return pool.map(() => null);

  return values.map((v) => {
    let total = 0;
    for (const cat of inPlay) {
      const value = v[cat];
      if (value === null || !Number.isFinite(value)) return null;
      const { m, sd } = shape.get(cat)!;
      // a category the whole pool agrees on separates nobody, so it contributes
      // 0 rather than a NaN from dividing by zero.
      const z = sd === 0 ? 0 : (value - m) / sd;
      total += REVERSED_IMPACT_CATEGORIES.has(cat) ? -z : z;
    }
    return round(total, 2);
  });
}

/** Descending, with null last — a null is "unknown", not "worst". */
function byValueDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Best projected total impact first, with points as the tiebreak.
 *
 * Players the run has no complete projection for sort to the bottom rather than
 * to the top (a null is "unknown", not "zero"). A placeholder name loses a tie
 * to a real one and can never win one by being lexicographically small — the
 * blank name that used to sort first is exactly why that rule is explicit.
 */
export function rankSlatePlayers(
  players: SlatePlayer[],
  limit: number = TOP_PLAYERS_PER_GAME
): SlatePlayer[] {
  return [...players]
    .sort((a, b) => {
      const byImpact = byValueDesc(a.impact, b.impact);
      if (byImpact !== 0) return byImpact;
      const byPoints = byValueDesc(a.proj_pts, b.proj_pts);
      if (byPoints !== 0) return byPoints;
      if (a.name_is_placeholder !== b.name_is_placeholder) return a.name_is_placeholder ? 1 : -1;
      return a.name.localeCompare(b.name) || a.nba_player_id.localeCompare(b.nba_player_id);
    })
    .slice(0, limit);
}

/**
 * The `nba_player_id`s of the top `count` players by impact. Both spotlight
 * scopes use it — a game card's top three and the slate's top ten are the same
 * question asked of a different set. A player without an impact score is never
 * spotlighted, however short the list is: the badge is a claim, and there is
 * nothing to claim about an unscored player.
 */
export function topImpactIds(players: SlatePlayer[], count: number): Set<string> {
  return new Set(
    [...players]
      .filter((p) => p.impact !== null)
      .sort(
        (a, b) =>
          byValueDesc(a.impact, b.impact) ||
          a.name.localeCompare(b.name) ||
          a.nba_player_id.localeCompare(b.nba_player_id)
      )
      .slice(0, count)
      .map((p) => p.nba_player_id)
  );
}

/** Pool descriptor echoed verbatim in every response so the UI never hardcodes it. */
export function poolDescriptor(sampleSize: number): SlatePool {
  return {
    key: IMPACT_POOL_KEY,
    label: IMPACT_POOL_LABEL,
    definition: IMPACT_POOL_DEFINITION,
    sample_size: sampleSize,
  };
}

/**
 * The slate for one ET calendar day. Never throws for missing data: no
 * schedule gives an empty `games` array, no finished run gives `run: null`
 * with every game's `players` empty, and the page renders its own empty state
 * off those.
 *
 * Game cards come back ordered by the best impact they contain rather than by
 * game id — the point of the page is to say where tonight's production is.
 */
export async function getSlate(date: string): Promise<SlateResponse> {
  const schedule = await fetchSchedule(date);
  const run = await getLatestCompleteRun();
  const runSummary = run ? { model_version: run.model_version, predicted_at: run.predicted_at } : null;

  // no games means nothing to hang predictions off; skip the remaining round
  // trips entirely.
  if (schedule.length === 0) {
    return { date, run: runSummary, pool: poolDescriptor(0), games: [] };
  }

  const teamAbbrs = await fetchTeamAbbrs();
  const predictions = run ? await fetchPredictions(run.id, date) : [];

  // the pool is every player-game the run has for this date — see THE POOL.
  const inputs: ImpactInput[] = predictions.map((row) => {
    const entry = {} as ImpactInput;
    for (const stat of PROJECTED_STATS) entry[stat] = num(row[stat]);
    return entry;
  });
  const impacts = impactScores(inputs);

  const players: SlatePlayer[] = predictions.map((row, i) => {
    const nbaPlayerId = String(row.nba_player_id);
    const { name, placeholder } = resolvePlayerName(row.name, nbaPlayerId);
    const projected = {} as SlateProjectedCategories;
    for (const cat of DISPLAY_CATEGORIES) projected[cat] = round(inputs[i][cat], 1);

    return {
      nba_player_id: nbaPlayerId,
      name,
      name_is_placeholder: placeholder,
      team_abbr: text(row.team_abbr),
      prob_active: round(num(row.prob_active), 3),
      proj_pts: round(inputs[i].pts, 1),
      proj_min_p50: round(num(row.proj_min_p50), 1),
      projected,
      impact: impacts[i],
      spotlight: false,
      slate_spotlight: false,
    };
  });

  const slateSpotlight = topImpactIds(players, SLATE_SPOTLIGHT_COUNT);
  for (const player of players) {
    player.slate_spotlight = slateSpotlight.has(player.nba_player_id);
  }

  const byGame = new Map<string, SlatePlayer[]>();
  for (let i = 0; i < players.length; i += 1) {
    const gameId = String(predictions[i].nba_game_id);
    const list = byGame.get(gameId) ?? [];
    list.push(players[i]);
    byGame.set(gameId, list);
  }

  const games: SlateGame[] = schedule.map((row) => {
    const homeId = text(row.home_team_id);
    const awayId = text(row.away_team_id);
    const gameId = String(row.nba_game_id);
    const inGame = byGame.get(gameId) ?? [];

    // chosen from the whole game rather than from the ranked slice, so the
    // badge means "best in this game" and not "best of the eight we showed".
    const gameSpotlight = topImpactIds(inGame, SPOTLIGHT_PER_GAME);
    for (const player of inGame) player.spotlight = gameSpotlight.has(player.nba_player_id);

    const ranked = rankSlatePlayers(inGame);

    return {
      nba_game_id: gameId,
      game_status: text(row.game_status),
      home_team_id: homeId,
      home_team_abbr: homeId ? teamAbbrs.get(homeId) ?? null : null,
      away_team_id: awayId,
      away_team_abbr: awayId ? teamAbbrs.get(awayId) ?? null : null,
      top_impact: ranked[0]?.impact ?? null,
      players: ranked,
    };
  });

  games.sort(
    (a, b) => byValueDesc(a.top_impact, b.top_impact) || a.nba_game_id.localeCompare(b.nba_game_id)
  );

  return { date, run: runSummary, pool: poolDescriptor(players.length), games };
}
