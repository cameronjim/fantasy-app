import { query } from '../db.js';
import { num, rowsOrEmpty, toIsoDay } from './slate.js';

/**
 * A player's OWN recent baseline — what "usual" means for him — read from
 * `player_game_logs`.
 *
 * This file exists so the two surfaces that compare a projection against a
 * player's usual level read the SAME numbers from the SAME window:
 *   - `watchlist.ts`, where the whole ranking is projection-minus-usual;
 *   - `slate.ts`, where a row gets a "+6.2 min vs usual" chip.
 * Two independent baseline queries would eventually disagree, and the first
 * symptom would be a chip on the Projections tab contradicting a ROLE_INCREASE
 * badge on the Watchlist for the same player on the same night.
 *
 * ========================= WHY GAME LOGS, NOT `players` =========================
 * `players` carries season averages, which are cheaper to read and wrong for
 * this. They are a season-to-date figure that keeps moving after the fact, so a
 * backtest run as-of January would compare a January projection against an
 * average that includes April. Game logs can be cut off at a date, which is the
 * only way "usual" stays a statement about what was known at the time.
 * ================================================================================
 *
 * ============================== PLAYED GAMES ONLY ==============================
 * The window is his last N games PLAYED (`minutes > 0`), not his last N
 * scheduled games. That makes the baseline a per-appearance rate, directly
 * comparable to the model's CONDITIONAL ("given he plays") projections. Mixing
 * in DNPs would drag the baseline toward zero and turn every returning player
 * into a fake role increase.
 * ================================================================================
 */

/**
 * Stats a baseline is computed for. Every one of them exists both as a column on
 * `player_game_logs` and as a stat name in the prediction store, which is what
 * makes projection-minus-usual well defined for each.
 *
 * `fga` is here only so the shot-volume rule has something to compare against;
 * it is never displayed as a projection.
 */
export const BASELINE_STATS = [
  'minutes',
  'pts',
  'reb',
  'ast',
  'stl',
  'blk',
  'fg3m',
  'fga',
] as const;

export type BaselineStat = (typeof BASELINE_STATS)[number];

/** Games played the baseline averages over. */
export const BASELINE_WINDOW_GAMES = 15;

/**
 * Below this many played games there is no "usual" to deviate from, and the
 * player is dropped from every vs-usual comparison rather than compared against
 * a two-game average. This is also what keeps a rookie with no NBA history out
 * of the Watchlist entirely: he has no baseline, so he cannot have an upside
 * relative to one.
 */
export const MIN_BASELINE_GAMES = 5;

/** The short window the hot-streak rule reads. */
export const BASELINE_RECENT_GAMES = 5;

/**
 * How far back the scan looks for those games. Wide enough to cross an
 * offseason — an opening-week slate has to compare against LAST season's last
 * fifteen games or it has nothing at all — and narrow enough that the query
 * touches one season rather than the whole table.
 */
export const BASELINE_LOOKBACK_DAYS = 400;

/**
 * Minutes of deviation from the baseline that count as worth pointing at. Shared
 * deliberately: it is the Projections chip's threshold AND the Watchlist's
 * ROLE_INCREASE bar, so the two pages can never disagree about what a minutes
 * jump is.
 */
export const NOTABLE_MINUTES_DELTA = 4;

/** Echoed in both payloads so no page states a definition of its own. */
export const BASELINE_LABEL = 'his own recent form';
export const BASELINE_DEFINITION =
  `per-game averages over his last ${BASELINE_WINDOW_GAMES} games played before this date, ` +
  `requiring at least ${MIN_BASELINE_GAMES}`;

/** The baseline descriptor carried in a response. */
export interface BaselineDescriptor {
  window_games: number;
  min_games: number;
  /** Minutes of deviation a surface should bother showing. */
  notable_min_delta: number;
  label: string;
  definition: string;
}

export function baselineDescriptor(): BaselineDescriptor {
  return {
    window_games: BASELINE_WINDOW_GAMES,
    min_games: MIN_BASELINE_GAMES,
    notable_min_delta: NOTABLE_MINUTES_DELTA,
    label: BASELINE_LABEL,
    definition: BASELINE_DEFINITION,
  };
}

/** One player's usual level, as of a date. */
export interface PlayerBaseline {
  nba_player_id: string;
  /** Played games the averages cover, capped at `BASELINE_WINDOW_GAMES`. */
  games: number;
  /** Per-game averages over the window. Null for a stat the source never had. */
  avg: Record<BaselineStat, number | null>;
  /** Scoring over the last `BASELINE_RECENT_GAMES`, for the hot-streak rule. */
  pts_recent: number | null;
  /** His own game-to-game scoring stddev over the window. */
  pts_sd: number | null;
  /** The most recent game he actually played before the date. */
  last_played_date: string | null;
}

/** True when the baseline rests on enough games to compare against. */
export function hasUsableBaseline(baseline: PlayerBaseline | undefined): boolean {
  return baseline !== undefined && baseline.games >= MIN_BASELINE_GAMES;
}

/**
 * `projected - usual`, or null when either half is missing. Null is not zero:
 * "we do not know whether this is a jump" and "this is not a jump" are different
 * claims, and only the second one belongs on a badge.
 */
export function deltaOf(projected: number | null, usual: number | null): number | null {
  if (projected === null || usual === null) return null;
  return projected - usual;
}

/**
 * Whole days from a player's last appearance to the date in question, or null
 * with no appearance on record.
 */
export function daysSince(date: string, lastPlayed: string | null): number | null {
  if (!lastPlayed) return null;
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${lastPlayed}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

// the aggregate and projection lists are generated from BASELINE_STATS so a stat
// added to that array is read without editing SQL. The only interpolated text is
// this file's own constants — never request input. Same convention as
// slate.ts::PROJECTED_PIVOT_SQL.
const LOG_COLUMNS_SQL = BASELINE_STATS.map((stat) => `g.${stat}::float AS ${stat}`).join(',\n              ');
const LOG_AVERAGES_SQL = BASELINE_STATS.map((stat) => `AVG(${stat}) AS ${stat}`).join(',\n              ');

interface BaselineRow {
  nba_player_id: unknown;
  games: unknown;
  pts_recent: unknown;
  pts_sd: unknown;
  last_played_date: unknown;
}

/**
 * Every player's baseline as of `date`, keyed by `nba_player_id`.
 *
 * The `game_date < $1` cutoff is what keeps a vs-usual comparison a FORECAST:
 * including the target day's own box score would make every deviation trivially
 * correct after the fact, which is exactly the failure mode the append-only
 * prediction store (migration 014) exists to prevent.
 *
 * Deliberately NOT filtered to the current season. A season boundary is not a
 * boundary on "what is usual for this player" — on opening night the honest
 * answer is last season's last fifteen games, and a season filter would leave
 * the entire opening week with no baseline at all.
 *
 * Degrades to an empty map when `player_game_logs` does not exist yet.
 */
export async function fetchBaselines(date: string): Promise<Map<string, PlayerBaseline>> {
  const rows = await rowsOrEmpty<BaselineRow & Record<BaselineStat, unknown>>(() =>
    query(
      `WITH played AS (
           SELECT g.nba_player_id,
                  g.game_date,
                  g.nba_game_id,
                  ${LOG_COLUMNS_SQL},
                  ROW_NUMBER() OVER (
                    PARTITION BY g.nba_player_id
                    ORDER BY g.game_date DESC, g.nba_game_id DESC
                  ) AS rn
           FROM player_game_logs g
           WHERE g.season_type = 'Regular Season'
             AND g.game_date < $1
             AND g.game_date >= $1::date - $2::int
             AND g.minutes IS NOT NULL
             AND g.minutes > 0
         )
         SELECT nba_player_id,
                COUNT(*)::int AS games,
                ${LOG_AVERAGES_SQL},
                AVG(pts) FILTER (WHERE rn <= $4) AS pts_recent,
                STDDEV_POP(pts) AS pts_sd,
                MAX(game_date) FILTER (WHERE rn = 1) AS last_played_date
         FROM played
         WHERE rn <= $3
         GROUP BY nba_player_id`,
      [date, BASELINE_LOOKBACK_DAYS, BASELINE_WINDOW_GAMES, BASELINE_RECENT_GAMES]
    )
  );

  const map = new Map<string, PlayerBaseline>();
  for (const row of rows) {
    const id = String(row.nba_player_id);
    const avg = {} as Record<BaselineStat, number | null>;
    for (const stat of BASELINE_STATS) avg[stat] = num(row[stat]);
    map.set(id, {
      nba_player_id: id,
      games: num(row.games) ?? 0,
      avg,
      pts_recent: num(row.pts_recent),
      pts_sd: num(row.pts_sd),
      last_played_date: toIsoDay(row.last_played_date),
    });
  }
  return map;
}
