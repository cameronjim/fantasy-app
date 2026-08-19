import { query } from '../db.js';
import { percentRank, stddev } from './analytics.js';
import {
  MINUTES_QUANTILE,
  MINUTES_STAT,
  PROB_ACTIVE_STAT,
  PROJECTED_STATS,
  getLatestCompleteRun,
  impactScores,
  num,
  poolDescriptor,
  resolvePlayerName,
  round,
  rowsOrEmpty,
  toIsoDay,
  uncondStat,
  type ImpactInput,
  type ProjectedStat,
  type SlatePool,
  type SlateRun,
} from './slate.js';
import {
  MIN_BASELINE_GAMES,
  NOTABLE_MINUTES_DELTA,
  baselineDescriptor,
  daysSince,
  deltaOf,
  fetchBaselines,
  hasUsableBaseline,
  type BaselineDescriptor,
  type PlayerBaseline,
} from './baselines.js';

/**
 * The big-night detector: who is projected to do MORE THAN HE USUALLY DOES
 * tonight, weighted by whether "more than usual" would actually matter.
 *
 * This is the deliberate complement to the Projections tab. That page answers
 * "who is best tonight" in absolute terms and is therefore a list of stars every
 * night. This one answers a question a manager cannot get anywhere else: whose
 * SITUATION changed — a role increase, a teammate out, a return from absence —
 * such that tonight is unlike his own normal night.
 *
 * ===================== THE SCORE, PRE-REGISTERED ============================
 *
 *     score = max(0, upside) x relevance
 *
 *   upside     the weighted mean, over the stats the run emits, of each
 *              deviation DIVIDED BY THE SPREAD OF THAT DEVIATION ACROSS
 *              TONIGHT'S POOL. A deviation is `projected - usual`: the model's
 *              CONDITIONAL projection (minutes at P50, production as the
 *              expected value) minus his own per-played-game average over the
 *              trailing window that `baselines.ts` defines. Minutes carry the
 *              heaviest weight because minutes are the mechanism — production
 *              follows opportunity, and a projected points bump with no minutes
 *              bump is mostly model noise.
 *
 *   relevance  tonight's ABSOLUTE projected impact, expressed as its percentile
 *              inside the same pool `slate.ts` z-scores against, then ramped from
 *              `IMPACT_PERCENTILE_FLOOR` to 100 onto [0, 1]. At or below the
 *              floor it is exactly 0.
 *
 * WHY IT IS A PRODUCT, AND WHY THE FLOOR IS A HARD ZERO. Deviation alone ranks a
 * bench player going from 5 minutes to 15 above a rotation player going from 24
 * to 32, because 5 -> 15 is the larger relative jump by any measure. It is also
 * useless: tripling the minutes of a player who cannot produce still produces
 * nothing. The floor is what makes the page actionable — a player in the bottom
 * half of tonight's projected impact scores exactly 0 no matter how large his
 * jump, and a player projected at his usual level scores ~0 no matter how good
 * he is. Only the intersection ranks.
 *
 * WHY DEVIATIONS ARE SCALED BUT NOT CENTRED. Dividing by the pool's spread is
 * what lets minutes and points be averaged at all — six minutes and six points
 * are not the same size of surprise. SUBTRACTING the pool mean was tried and
 * rejected. It would make the score robust to a mis-calibrated run: the
 * cold-start run in the dev store projects nobody above 32 minutes, so every
 * player's raw minutes delta is negative, and centring would rescue the ranking
 * by re-reading "shrunk least" as "up most". That is the wrong trade. It puts
 * players at the top of a big-night list whose own numbers, printed on their own
 * row, say they are projected BELOW their usual — a page that contradicts itself
 * in the same line of text. Uncentred, the sign means what it says: if the run
 * projects nobody above their own baseline, this page is empty, and that is a
 * true statement about the run rather than a flattering re-scaling of it.
 * Correcting a run's calibration is the model's job, not this ranking's.
 *
 * WHY A WEIGHTED MEAN, NOT A SUM. `slate.ts::impactScores` sums z-scores because
 * it wants TOTAL impact, and it therefore requires a complete category set. Here
 * a mean is right: it is invariant to how many stats the run emits, so the
 * January backtest run (minutes/pts/ast) and a full nine-category run produce
 * upside numbers on the same scale, and a player missing one stat is still
 * comparable rather than dropped.
 *
 * WHAT THE REASON CODES ARE, AND ARE NOT. They are deterministic rules over the
 * same data, shown to explain a row. They carry NO weight in the score — that
 * was the previous design, and a weighted reason count cannot express "big
 * relative to himself but big enough to matter". A reason is a label on a number,
 * never the number.
 *
 * There is no Python mirror. `ml/fnba_ml/watchlist.py` mirrored the PREVIOUS
 * design (a weighted reason count) and was retired when this file replaced it;
 * this file is the single implementation and the single spec.
 *
 * ==================== THE WINDOW, AND WHY IT IS A SUM ====================
 *
 *     window score = SUM over his games in [date, date + days - 1] of
 *                        max(0, upside_g) x relevance_g
 *
 * The per-game term is unchanged, and each game is still scored against ITS OWN
 * night: `upside_g` divides by the spread of that deviation across THAT date's
 * pool, and `relevance_g` is the percentile ramp inside THAT date's slate. A
 * Tuesday two-game slate and a Wednesday eleven-game slate are different
 * comparisons, and collapsing them into one pool would let the size of a night
 * decide the ranking.
 *
 * THE AGGREGATION IS A SUM BECAUSE THE NUMBER OF GAMES IS THE POINT. The use
 * case is a streaming pickup: a starting guard is out for two weeks, and the
 * question is who produces the most over exactly those days. A player with five
 * games can out-earn a better player with two, and a per-game MEAN would erase
 * precisely that — it would rank the same on a one-game week as on a four-game
 * week, which is the opposite of the answer a manager needs. `games_count` is
 * carried on the row so the sum is never mistaken for per-game quality, and
 * `score_per_game` is carried beside it so the row can be read either way.
 *
 * EACH GAME IS CLAMPED AT ZERO SEPARATELY, not the window total. A night the run
 * projects him at or below his own usual contributes 0, never a debit: a flat
 * Thursday is not a reason to pass on a player whose Monday and Saturday are
 * both big, and letting it subtract would make an extra game a risk instead of
 * an opportunity. So adding games can only ever help — which is the claim the
 * page is making.
 *
 * WHAT IS AVERAGED RATHER THAN SUMMED, AND WHY. `upside`, `relevance`,
 * `impact_percentile`, `prob_active` and the vs-usual pairs are PER-GAME
 * INTENSITIES — "how big a night, and how much it matters" — so each is reported
 * as the mean over the games it is defined for. Summing them would make them
 * grow with the schedule and stop meaning anything on their own. `impact` and
 * `totals` ARE summed, because those are quantities of production and the window
 * total is what a manager is deciding on. Consequence, stated plainly: for a
 * window longer than one day `score` is NOT `upside x relevance` — that identity
 * holds per game, and the row's `score` is the sum of those products.
 *
 * ONE BASELINE FOR THE WHOLE WINDOW, taken as of `date`. A baseline recomputed
 * at date+3 would average in the games of date..date+2, which have not been
 * played — the same hindsight leak the `game_date < $1` cutoff in
 * `baselines.ts` exists to prevent. "Usual" is what was known when the question
 * was asked, and the question is asked once, at the start of the window.
 *
 * REASONS, EVIDENCE AND DRIVERS DESCRIBE THE BEST-SCORING GAME IN THE WINDOW,
 * and so do `game_date`, `nba_game_id` and `opponent_team_abbr`. A union of
 * reasons over five nights would put a badge on a row whose supporting numbers
 * belong to a different night; one game's worth of explanation that all agrees
 * with itself is worth more than five games' worth that does not. The rest of
 * the window is in `games`, per game, for the reader who wants it.
 *
 * ============================== POSITION ==============================
 * `players.position` is a comma-joined list of PG/SG/SF/PF/C. It is normalised
 * into specific positions AND into G/F/C buckets (see `parsePositions`), so
 * "SG,SF" answers a G filter, an F filter, an SG filter and an SF filter — a
 * combo forward-guard IS both, and making the manager guess which one this app
 * filed him under would be a worse answer than either.
 *
 * A player the run projects but `players` has no row for has NO position. He is
 * INCLUDED when no position filter is asked for and EXCLUDED from every specific
 * one: "unknown" must not be quietly rendered as "not a guard". The response
 * carries `position_coverage` so the page can say how many rows that is instead
 * of silently shortening the list.
 *
 * THE FILTER IS APPLIED AFTER SCORING, NEVER BEFORE. The pool every percentile
 * is measured against stays the whole slate — a guard is relevant relative to
 * everyone playing that night, not relative to other guards — and the limit is
 * applied last, so `?position=G` returns the top twenty GUARDS rather than the
 * guards among the top twenty.
 * ============================================================================
 */

export const REASON_CODES = [
  'ROLE_INCREASE',
  'SHOT_VOLUME_SURGE',
  'RETURNING_FROM_ABSENCE',
  'HOT_STREAK',
  'TEAMMATE_ABSENCE',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Stats the deviation term is computed over: every stat that exists both as a
 * projection and as a game-log column, MINUS turnovers. More turnovers than
 * usual is a deviation and is not upside, and folding it in with a flipped sign
 * would credit a player for a projected drop in turnovers as though it were a
 * bigger night.
 */
export const DEVIATION_STATS = [
  'minutes',
  'pts',
  'reb',
  'ast',
  'stl',
  'blk',
  'fg3m',
] as const;

export type DeviationStat = (typeof DEVIATION_STATS)[number];

/**
 * Relative weight of each deviation. Minutes are double-weighted because they
 * are the CAUSE — a coach granting minutes is a decision that has already been
 * made, while a projected points bump is a consequence the model may have
 * guessed. Points sit above the peripheral categories for the same reason a
 * fantasy manager reads points first: it is the highest-variance category and
 * the one a role change moves most.
 */
export const DEVIATION_WEIGHTS: Record<DeviationStat, number> = {
  minutes: 2,
  pts: 1.5,
  reb: 1,
  ast: 1,
  stl: 1,
  blk: 1,
  fg3m: 1,
};

/**
 * The absolute floor, as a percentile of tonight's projected-impact pool. Below
 * it, relevance is exactly zero and the row cannot appear at all — this is the
 * constant that enforces the product rule.
 *
 * WHY 70 AND NOT 50. "Above the pool median" sounds like the natural floor and is
 * far too generous, because the pool is not a pool of rotation players: it is
 * every player the run projects, which on a nine-game slate is ~29 per game
 * including everyone who will not leave the bench. The median of that is a
 * deep-bench night, so a modest 20-minute contributor clears the 80th percentile
 * and the five-to-fifteen-minute jump the floor exists to suppress ranks anyway.
 *
 * 70 is derived from a constant already in the product rather than fitted to a
 * metric: `slate.ts::TOP_PLAYERS_PER_GAME` is 8, so the Projections tab shows
 * roughly the top 8 of ~29 projected players per game — the top ~28%. A player
 * who would not make that cut is not someone tonight's lineup decision turns on,
 * however much his own night has changed, so "relevant" is defined as "good
 * enough tonight to be shown on the Projections tab at all".
 */
export const IMPACT_PERCENTILE_FLOOR = 70;

/** How many candidates the endpoint returns. */
export const WATCHLIST_LIMIT = 20;

/** How many of a row's upward deviations the payload carries. */
export const UPSIDE_DRIVERS_SHOWN = 3;

/** Days a window covers when `?days=` is absent — tonight, and nothing else. */
export const DEFAULT_WINDOW_DAYS = 1;

/**
 * The longest window the endpoint will answer for.
 *
 * 14 because the use case is a two-week absence, which is the modal length of the
 * injury a manager streams around; and because it is also about as far as the
 * NBA schedule is worth projecting — beyond two weeks the run's own uncertainty
 * dominates, and a longer window would mostly be a longer list of guesses. It
 * also bounds the cost: one window is one predictions query over a date range,
 * so the cap is what keeps that range from becoming a season scan.
 */
export const MAX_WINDOW_DAYS = 14;

/**
 * ============================ POSITION VOCABULARY ============================
 * `players.position` holds a comma-joined list — "PG,SG", "SF,PF", "C" — and the
 * ORDER carries the primary position first, which is why `parsePositions`
 * preserves it rather than sorting. `routes/players.ts` already filters that
 * column with `= ANY(string_to_array(position, ','))`, so this vocabulary is the
 * same one the player list uses, read in TypeScript instead of SQL because the
 * watchlist has to filter AFTER scoring rather than in the query.
 * ============================================================================
 */

/** The five positions the source data actually names. */
export const SPECIFIC_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'] as const;

export type SpecificPosition = (typeof SPECIFIC_POSITIONS)[number];

/** The three roster slots a fantasy manager streams into. */
export const POSITION_BUCKETS = ['G', 'F', 'C'] as const;

export type PositionBucket = (typeof POSITION_BUCKETS)[number];

/** Which bucket each specific position falls in. */
export const POSITION_BUCKET_OF: Record<SpecificPosition, PositionBucket> = {
  PG: 'G',
  SG: 'G',
  SF: 'F',
  PF: 'F',
  C: 'C',
};

/**
 * Every value `?position=` accepts, buckets first.
 *
 * `C` appears once rather than twice because the bucket and the specific
 * position are the SAME set: a player is in bucket C exactly when one of his
 * positions is C. Offering it twice would be two chips that filter identically.
 */
export const POSITION_FILTERS = ['G', 'F', 'C', 'PG', 'SG', 'SF', 'PF'] as const;

export type PositionFilter = (typeof POSITION_FILTERS)[number];

/** A player's positions, normalised out of one `players.position` cell. */
export interface PlayerPositions {
  /** Specific positions, primary first. Empty when the source names none. */
  positions: SpecificPosition[];
  /** G/F/C buckets, deduped, in `POSITION_BUCKETS` order. */
  buckets: PositionBucket[];
  /** What a row prints — "PG/SG". Null when nothing could be parsed at all. */
  label: string | null;
}

/** Nothing known. Shared so "no position" is one object, not several. */
const NO_POSITIONS: PlayerPositions = { positions: [], buckets: [], label: null };

/**
 * `players.position` -> positions and buckets.
 *
 * Splits on comma, slash, hyphen and whitespace, so "PG,SG", "PG/SG" and the
 * "G-F" shorthand a different scrape might write all parse. Unrecognised tokens
 * are dropped rather than guessed at.
 *
 * A BARE BUCKET TOKEN ("G", "F") yields a bucket and no specific position, which
 * is the honest reading: "he is a guard" does not say whether he is a point
 * guard, and inventing PG from G would put him under a filter the data never
 * claimed. "C" is treated as a specific position, because there it is one.
 */
export function parsePositions(raw: unknown): PlayerPositions {
  if (raw === null || raw === undefined) return NO_POSITIONS;
  const tokens = String(raw)
    .toUpperCase()
    .split(/[,/\-|\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const positions: SpecificPosition[] = [];
  const buckets = new Set<PositionBucket>();

  for (const token of tokens) {
    if ((SPECIFIC_POSITIONS as readonly string[]).includes(token)) {
      const specific = token as SpecificPosition;
      if (!positions.includes(specific)) positions.push(specific);
      buckets.add(POSITION_BUCKET_OF[specific]);
    } else if ((POSITION_BUCKETS as readonly string[]).includes(token)) {
      buckets.add(token as PositionBucket);
    }
  }

  const ordered = POSITION_BUCKETS.filter((bucket) => buckets.has(bucket));
  const label =
    positions.length > 0 ? positions.join('/') : ordered.length > 0 ? ordered.join('/') : null;

  return { positions, buckets: ordered, label };
}

/**
 * Whether a player answers a filter. `null` — no filter — matches everyone,
 * INCLUDING a player with no position at all; every specific filter excludes
 * him, because "unknown" is not "no".
 */
export function matchesPosition(
  player: PlayerPositions,
  filter: PositionFilter | null
): boolean {
  if (filter === null) return true;
  if ((POSITION_BUCKETS as readonly string[]).includes(filter)) {
    return player.buckets.includes(filter as PositionBucket);
  }
  return player.positions.includes(filter as SpecificPosition);
}

/**
 * Validates `?position=`. Absent, empty, or the explicit `any` means no filter
 * and returns null; an unknown value returns `false` so the route can 400 rather
 * than quietly answer for every position. Case-insensitive, because a chip in a
 * URL should not have to be shouted.
 */
export function parsePositionFilter(raw: unknown): PositionFilter | null | false {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toUpperCase();
  if (value === '' || value === 'ANY' || value === 'ALL') return null;
  return (POSITION_FILTERS as readonly string[]).includes(value)
    ? (value as PositionFilter)
    : false;
}

/**
 * Validates `?days=`. Absent means `DEFAULT_WINDOW_DAYS`; anything that is not a
 * whole number in `[1, MAX_WINDOW_DAYS]` returns null so the route can 400.
 *
 * Out-of-range is rejected rather than clamped, for the same reason
 * `parsePredictionDate` rejects Feb 31: answering for 14 days when 30 were asked
 * for is a wrong answer that looks like a right one.
 */
export function parseWindowDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_WINDOW_DAYS;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DAYS) return null;
  return value;
}

/** `n` days from an ISO day, in UTC so no local DST shift can move a date. */
export function shiftIsoDate(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) return date;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** The inclusive range a `date` + `days` request covers. */
export function windowRange(date: string, days: number): WatchlistWindow {
  return { from: date, to: shiftIsoDate(date, days - 1), days };
}

/**
 * The pool descriptor for a window.
 *
 * A one-day window echoes `slate.ts::poolDescriptor` VERBATIM — the numbers are
 * the slate's numbers and the page must not describe them in words of its own.
 * A longer one keeps the same key and sample count but restates the definition,
 * because "tonight's slate" is a false description of a fortnight and every
 * percentile in the payload was still measured one night at a time.
 */
export function watchlistPool(sampleSize: number, days: number): SlatePool {
  const pool = poolDescriptor(sampleSize);
  if (days <= 1) return pool;
  return {
    ...pool,
    label: "Each night's slate",
    definition:
      "every player the run projects for a date, across all of that date's games; " +
      'each night in the window is scored against its own slate',
  };
}

/**
 * ============================ REASON THRESHOLDS ============================
 * Each of these is a rule a reader can check against a box score plus the
 * published projection. They label rows; they do not score them.
 * ==========================================================================
 */

/**
 * Minutes the projection must exceed the baseline by. Shared with the
 * Projections chip through `baselines.ts::NOTABLE_MINUTES_DELTA`, so "worth a
 * chip over there" and "a role increase over here" are the same bar.
 */
export const ROLE_INCREASE_MIN_DELTA = NOTABLE_MINUTES_DELTA;

/** Field-goal attempts the projection must exceed the baseline by. */
export const SHOT_VOLUME_SURGE_FGA_DELTA = 2.5;

/** Days since his last appearance that count as an absence rather than a rest day. */
export const RETURN_GAP_DAYS = 7;

/**
 * The upper end of that window. Without it, EVERY player fires the rule on
 * opening night — the gap back to April is 190 days — which is an offseason, not
 * an absence. Wide enough to cover a real multi-week injury.
 */
export const RETURN_GAP_MAX_DAYS = 45;

/** A return is only news if the model also expects him on the floor. */
export const RETURN_MIN_PROB_ACTIVE = 0.6;

/** Multiples of the player's own scoring stddev that count as a hot streak. */
export const HOT_STREAK_STDDEV_MULTIPLE = 1.5;

/** Minutes a sidelined teammate must usually play to open real usage. */
export const TEAMMATE_ABSENCE_MIN_MINUTES = 28;

/**
 * `prob_active` at or below which the model is effectively saying a teammate
 * will not play.
 *
 * This replaces a `players.injury_status = 'Out'` check that could not work:
 * that column carries body parts ("Ankle", "Knee") on the data this app
 * actually has, so the old rule matched nothing, ever. The run's own
 * availability estimate is both present for every teammate and the number the
 * rest of the page is already built on.
 */
export const TEAMMATE_ABSENCE_MAX_PROB_ACTIVE = 0.35;

/** Conditional stats read for the deviation term, beyond minutes. */
const CONDITIONAL_STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'fg3m', 'fga'] as const;

type ConditionalStat = (typeof CONDITIONAL_STATS)[number];

/** `projected` against `usual`, with the difference precomputed for the UI. */
export interface VsUsual {
  usual: number | null;
  projected: number | null;
  delta: number | null;
}

/** A teammate the run does not expect to play. */
export interface AbsentTeammate {
  name: string;
  /** His own usual minutes — the usage actually up for grabs. */
  usual_minutes: number;
  prob_active: number;
}

/** Everything the rules and the score need about one projected player-game. */
export interface WatchlistCandidate {
  nba_player_id: string;
  name: string;
  name_is_placeholder: boolean;
  team_abbr: string | null;
  /** Normalised from `players.position`; all-empty when he has no roster row. */
  position: PlayerPositions;
  opponent_team_abbr: string | null;
  nba_game_id: string;
  game_date: string;
  prob_active: number | null;
  /** Tonight's absolute projected impact, from `slate.ts::impactScores`. */
  impact: number | null;
  /**
   * The UNCONDITIONAL projected points — the number the Projections tab prints.
   * Not in the response (a row carrying two different points projections is a
   * confusion, not a feature); it is here so `scripts/watchlistBacktest.ts` can
   * build its naive top-projected-points baseline from the exact rows this
   * ranking saw, rather than from a second query that might not agree.
   */
  proj_pts_uncond: number | null;
  /**
   * Every unconditional projection for this game, which is what the window
   * totals are summed from. `proj_pts_uncond` is `uncond.pts` and is kept
   * separately only because the backtest reads it by that name.
   */
  uncond: ImpactInput;
  /** Played games the baseline rests on. */
  baseline_games: number;
  /** `projected - usual` per deviation stat; absent where either half is missing. */
  deltas: Partial<Record<DeviationStat, number>>;
  minutes: VsUsual;
  points: VsUsual;
  shots: VsUsual;
  /** Days from his last appearance to tonight. */
  days_since_played: number | null;
  last_played_date: string | null;
  pts_recent: number | null;
  pts_sd: number | null;
  teammate_out: AbsentTeammate | null;
}

/** The numbers behind whichever reasons fired, and no others. */
export interface WatchlistEvidence {
  fga_usual?: number;
  fga_projected?: number;
  fga_delta?: number;
  days_since_played?: number;
  last_played_date?: string;
  pts_recent?: number;
  pts_sd?: number;
  pts_recent_delta?: number;
  teammate_out?: string;
  teammate_out_minutes?: number;
  teammate_out_prob_active?: number;
}

/** One game inside the window, for the row's expandable breakdown. */
export interface WatchlistGame {
  game_date: string;
  nba_game_id: string;
  opponent_team_abbr: string | null;
  /** Conditional P50 minutes — the same line the Projections tab prints. */
  minutes_p50: number | null;
  /** Unconditional projected points — the number the Projections tab ranks by. */
  proj_pts: number | null;
  /** This game's absolute projected impact, against its own night's slate. */
  impact: number | null;
  /** This game's contribution to the window total: `max(0, upside) x relevance`. */
  score: number;
}

export interface WatchlistPlayer {
  nba_player_id: string;
  name: string;
  /** True when `name` is a stand-in built from the id (see slate.ts). */
  name_is_placeholder: boolean;
  team_abbr: string | null;
  /**
   * His positions as one printable string — "PG/SG". Null when the run projects
   * him but `players` has no row for him, which is a different fact from "no
   * position" and is why the page prints it differently.
   */
  position: string | null;
  /**
   * The window's BEST-SCORING game, and so are `nba_game_id`,
   * `opponent_team_abbr`, `reasons`, `evidence` and `drivers` — one game's worth
   * of explanation that agrees with itself. See THE WINDOW at the top.
   */
  game_date: string;
  nba_game_id: string;
  opponent_team_abbr: string | null;
  /** Games the run projects for him inside the window. The streaming argument. */
  games_count: number;
  /** Every one of those games, earliest first. */
  games: WatchlistGame[];
  /**
   * The window TOTAL: the sum over `games` of `max(0, upside) x relevance`. For a
   * one-day window that is the single game's product; for longer ones it is not
   * `upside x relevance`, deliberately — see THE WINDOW.
   */
  score: number;
  /** `score / games_count`, so a row reads as rate as well as total. */
  score_per_game: number;
  /** The deviation term, averaged over his games in the window. */
  upside: number;
  /** Which deviations point up in his best game, biggest contribution first. */
  drivers: UpsideDriver[];
  /** The absolute floor term, 0-1, averaged over his games in the window. */
  relevance: number;
  /** Absolute projected impact SUMMED over the window — total, not per game. */
  impact: number | null;
  /** Mean over his games of where that night's impact sat in that night's pool. */
  impact_percentile: number;
  /**
   * Mean availability over his games in the window — read it as the share of
   * these games the run expects him to appear in. Null when it never had one.
   */
  prob_active: number | null;
  /** Usual is the one baseline; projected and delta are means over the window. */
  minutes: VsUsual;
  points: VsUsual;
  /** Unconditional projections SUMMED over the window, per stat. */
  totals: Partial<Record<ProjectedStat, number>>;
  baseline_games: number;
  reasons: ReasonCode[];
  evidence: WatchlistEvidence;
}

/** The days a request covers, echoed so the page never computes its own range. */
export interface WatchlistWindow {
  /** First date in the window — the `?date=` that was asked for. */
  from: string;
  /** Last date, inclusive. Equal to `from` for a one-day window. */
  to: string;
  days: number;
}

/** How many of the window's ranked-eligible candidates have a position at all. */
export interface PositionCoverage {
  known: number;
  unknown: number;
}

export interface WatchlistResponse {
  /** The window's first date, kept for callers that only ever asked for one day. */
  date: string;
  window: WatchlistWindow;
  /** Null until a run has completed — the page shows its own notice. */
  run: SlateRun | null;
  /** The pool the impact percentile is measured in — slate.ts's pool, per night. */
  pool: SlatePool;
  /** What "usual" means, so the page never states a definition of its own. */
  baseline: BaselineDescriptor;
  /** The position filter that was applied, or null for every position. */
  position: PositionFilter | null;
  /** Every filter this server honours, so the page never offers one it will not. */
  position_options: PositionFilter[];
  /**
   * Counted BEFORE the position filter, so the page can say how many candidates
   * a specific filter could not consider rather than silently shortening.
   */
  position_coverage: PositionCoverage;
  players: WatchlistPlayer[];
}

/**
 * The spread of each deviation across the pool — the unit each deviation is
 * measured in. A stat nobody in the pool has a deviation for is absent from the
 * map entirely, which is how a run emitting three stats scores on three.
 */
export function deviationScales(
  pool: Array<Partial<Record<DeviationStat, number>>>
): Map<DeviationStat, number> {
  const scales = new Map<DeviationStat, number>();
  for (const stat of DEVIATION_STATS) {
    const present = pool
      .map((deltas) => deltas[stat])
      .filter((v): v is number => v !== undefined && Number.isFinite(v));
    if (present.length === 0) continue;
    scales.set(stat, stddev(present));
  }
  return scales;
}

/** One deviation that points up, in both raw and scaled units. */
export interface UpsideDriver {
  stat: DeviationStat;
  /** `projected - usual`, in the stat's own units. */
  delta: number;
  /** That delta in units of the pool's spread — its contribution to `upside`. */
  scaled: number;
}

/**
 * One candidate's upside, plus the deviations that produced it.
 *
 * Each deviation is divided by the STANDARD DEVIATION of that same deviation
 * across the pool — a scale, not a z-score: the pool mean is deliberately NOT
 * subtracted (see WHY DEVIATIONS ARE SCALED BUT NOT CENTRED). The scaled
 * deviations are combined as a WEIGHTED MEAN over the stats this candidate
 * actually has.
 *
 * Because it is uncentred the sign survives: a positive upside means the run
 * projects him above his own baseline, and only positive upside can score
 * (`watchlistScore` clamps).
 *
 * `drivers` exists so a row can explain itself. The aggregate can be positive
 * while minutes and points — the two the UI always prints — are flat or down,
 * because five other categories are up. Without the drivers that row reads as a
 * self-contradiction; with them it reads as "same minutes, more of everything
 * else", which is what the numbers actually say.
 *
 * `upside` is null when the candidate has no deviation at all — no baseline, or
 * a run that projected nothing comparable for him. Null is "unknown", and
 * unknown never ranks.
 */
export function upsideOf(
  deltas: Partial<Record<DeviationStat, number>>,
  scales: Map<DeviationStat, number>
): { upside: number | null; drivers: UpsideDriver[] } {
  let weighted = 0;
  let weight = 0;
  const drivers: UpsideDriver[] = [];

  for (const [stat, sd] of scales) {
    const value = deltas[stat];
    if (value === undefined || !Number.isFinite(value)) continue;
    // a stat every candidate deviates on by the same amount separates nobody, so
    // it contributes 0 rather than a NaN (or an Infinity) from dividing by zero.
    const scaled = sd === 0 ? 0 : value / sd;
    weighted += DEVIATION_WEIGHTS[stat] * scaled;
    weight += DEVIATION_WEIGHTS[stat];
    if (scaled > 0) {
      drivers.push({ stat, delta: round(value, 1) as number, scaled: round(scaled, 3) as number });
    }
  }

  if (weight === 0) return { upside: null, drivers: [] };
  drivers.sort(
    (a, b) => DEVIATION_WEIGHTS[b.stat] * b.scaled - DEVIATION_WEIGHTS[a.stat] * a.scaled
  );
  return { upside: round(weighted / weight, 3), drivers };
}

/** `upsideOf` for a whole pool, returned aligned with it. */
export function upsideScores(
  pool: Array<Partial<Record<DeviationStat, number>>>
): Array<number | null> {
  if (pool.length === 0) return [];
  const scales = deviationScales(pool);
  return pool.map((deltas) => upsideOf(deltas, scales).upside);
}

/**
 * The absolute-relevance multiplier for one candidate: where his projected
 * impact sits in tonight's pool, ramped from the floor onto [0, 1].
 *
 * Percentile rather than the raw z-sum on purpose. The z-sum's scale depends on
 * how many categories the run emitted (nine categories reach +12, two reach
 * +3), so a fixed cutoff on it would mean different things for different runs.
 * A percentile means the same thing always: "better than this share of tonight's
 * player-games".
 *
 * Null when the run has no impact score for him — there is no floor to clear, so
 * he is unknown rather than bad.
 */
export function relevanceFor(impact: number | null, poolImpacts: number[]): number | null {
  if (impact === null) return null;
  const pct = percentRank(poolImpacts, impact);
  if (pct <= IMPACT_PERCENTILE_FLOOR) return 0;
  return round((pct - IMPACT_PERCENTILE_FLOOR) / (100 - IMPACT_PERCENTILE_FLOOR), 3) as number;
}

/**
 * `max(0, upside) x relevance`, or null when either factor is unknown.
 *
 * Negative upside is clamped rather than kept: a player projected BELOW his
 * usual is not a big-night candidate, and letting the product go negative would
 * make him sort above a merely-average one in a descending list only by accident
 * of the other factor's sign.
 */
export function watchlistScore(upside: number | null, relevance: number | null): number | null {
  if (upside === null || relevance === null) return null;
  return round(Math.max(0, upside) * relevance, 3) as number;
}

/** A projection meaningfully above his usual minutes. */
export function hasRoleIncrease(delta: number | null): boolean {
  return delta !== null && delta >= ROLE_INCREASE_MIN_DELTA;
}

/**
 * Shots, not minutes: a player can be on the floor longer without the ball.
 * Attempts are the part of usage a box score settles unambiguously, so this is
 * the rule that separates "more minutes" from "more of the offence".
 */
export function hasShotVolumeSurge(delta: number | null): boolean {
  return delta !== null && delta >= SHOT_VOLUME_SURGE_FGA_DELTA;
}

/**
 * A real absence he is expected back from. Both ends of the window matter: below
 * the lower bound it is a rest day, above the upper bound it is an offseason.
 * The availability check is what separates "back tonight" from "still out" —
 * without it the rule fires hardest for players who are not going to play.
 */
export function isReturningFromAbsence(
  daysSincePlayed: number | null,
  probActive: number | null
): boolean {
  if (daysSincePlayed === null) return false;
  if (daysSincePlayed < RETURN_GAP_DAYS || daysSincePlayed > RETURN_GAP_MAX_DAYS) return false;
  return probActive !== null && probActive >= RETURN_MIN_PROB_ACTIVE;
}

/**
 * Scored against the player's OWN volatility rather than a fixed points
 * threshold: +4 points from a metronome is a real change, +4 from someone who
 * swings 12 a night is Tuesday. A zero (or missing) stddev has nothing to scale
 * by, so it never fires.
 */
export function isHotStreak(
  ptsRecent: number | null,
  ptsUsual: number | null,
  ptsSd: number | null
): boolean {
  if (ptsRecent === null || ptsUsual === null || ptsSd === null || ptsSd <= 0) return false;
  return ptsRecent - ptsUsual >= HOT_STREAK_STDDEV_MULTIPLE * ptsSd;
}

/**
 * The highest-minutes teammate the run does not expect to play, or null. Highest
 * usual minutes wins because that is the usage actually up for grabs.
 *
 * Note this reads the RUN's availability estimate, not an injury report. On a
 * slate with no injury news — a preseason run, for instance — nothing here
 * fires, and that is the correct answer rather than a missing signal.
 */
export function findAbsentTeammate(
  teammates: Array<{ name: string; usual_minutes: number | null; prob_active: number | null }>
): AbsentTeammate | null {
  let best: AbsentTeammate | null = null;
  for (const mate of teammates) {
    const minutes = mate.usual_minutes;
    const prob = mate.prob_active;
    if (prob === null || prob > TEAMMATE_ABSENCE_MAX_PROB_ACTIVE) continue;
    if (minutes === null || minutes < TEAMMATE_ABSENCE_MIN_MINUTES) continue;
    if (!best || minutes > best.usual_minutes) {
      best = { name: mate.name, usual_minutes: minutes, prob_active: prob };
    }
  }
  return best;
}

/** Every reason that fires for a candidate, in REASON_CODES order. */
export function reasonsFor(candidate: WatchlistCandidate): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  if (hasRoleIncrease(candidate.minutes.delta)) reasons.push('ROLE_INCREASE');
  if (hasShotVolumeSurge(candidate.shots.delta)) reasons.push('SHOT_VOLUME_SURGE');
  if (isReturningFromAbsence(candidate.days_since_played, candidate.prob_active)) {
    reasons.push('RETURNING_FROM_ABSENCE');
  }
  if (isHotStreak(candidate.pts_recent, candidate.points.usual, candidate.pts_sd)) {
    reasons.push('HOT_STREAK');
  }
  if (candidate.teammate_out !== null) reasons.push('TEAMMATE_ABSENCE');
  return reasons;
}

/**
 * The supporting numbers for the reasons that actually fired, and no others.
 * Minutes and points are first-class payload fields rather than evidence — they
 * are shown on every row, whether or not a rule named them.
 */
export function evidenceFor(
  candidate: WatchlistCandidate,
  reasons: ReasonCode[]
): WatchlistEvidence {
  const evidence: WatchlistEvidence = {};
  const set = new Set<ReasonCode>(reasons);

  if (set.has('SHOT_VOLUME_SURGE') && candidate.shots.delta !== null) {
    evidence.fga_usual = round(candidate.shots.usual, 1) as number;
    evidence.fga_projected = round(candidate.shots.projected, 1) as number;
    evidence.fga_delta = round(candidate.shots.delta, 1) as number;
  }
  if (set.has('RETURNING_FROM_ABSENCE') && candidate.days_since_played !== null) {
    evidence.days_since_played = candidate.days_since_played;
    if (candidate.last_played_date) evidence.last_played_date = candidate.last_played_date;
  }
  if (
    set.has('HOT_STREAK') &&
    candidate.pts_recent !== null &&
    candidate.points.usual !== null &&
    candidate.pts_sd !== null
  ) {
    evidence.pts_recent = round(candidate.pts_recent, 1) as number;
    evidence.pts_sd = round(candidate.pts_sd, 1) as number;
    evidence.pts_recent_delta = round(candidate.pts_recent - candidate.points.usual, 1) as number;
  }
  if (set.has('TEAMMATE_ABSENCE') && candidate.teammate_out) {
    evidence.teammate_out = candidate.teammate_out.name;
    evidence.teammate_out_minutes = round(candidate.teammate_out.usual_minutes, 1) as number;
    evidence.teammate_out_prob_active = round(candidate.teammate_out.prob_active, 3) as number;
  }

  return evidence;
}

/** A candidate with both factors of its score resolved. */
export interface ScoredCandidate {
  candidate: WatchlistCandidate;
  upside: number | null;
  drivers: UpsideDriver[];
  relevance: number | null;
  /** `max(0, upside) x relevance`, or null when either factor is unknown. */
  score: number | null;
  impact_percentile: number;
}

/**
 * Every candidate scored against the pool it arrives in, in input order and
 * WITHOUT filtering.
 *
 * Split out from `rankCandidates` for the backtest harness, which has to see the
 * whole eligible universe — the baselines it compares against need the same
 * denominator the ranking drew from, and a precision@10 computed over a
 * pre-filtered list would be measuring a different question.
 */
export function scoreCandidates(candidates: WatchlistCandidate[]): ScoredCandidate[] {
  const scales = deviationScales(candidates.map((c) => c.deltas));
  const poolImpacts = candidates
    .map((c) => c.impact)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  return candidates.map((candidate) => {
    const { upside, drivers } = upsideOf(candidate.deltas, scales);
    const relevance = relevanceFor(candidate.impact, poolImpacts);
    return {
      candidate,
      upside,
      drivers,
      relevance,
      score: watchlistScore(upside, relevance),
      impact_percentile:
        candidate.impact === null ? 0 : percentRank(poolImpacts, candidate.impact),
    };
  });
}

/**
 * Candidates grouped by their own `game_date`, so each night is scored against
 * its own pool.
 *
 * This is what makes the window honest rather than convenient: scoring a
 * fortnight as one pool would set the deviation scales and the impact
 * percentiles from a mixture of two-game Tuesdays and eleven-game Wednesdays,
 * and a player's standing would then depend on which nights happened to be in
 * the request.
 */
export function groupByDate(
  candidates: WatchlistCandidate[]
): Array<{ date: string; candidates: WatchlistCandidate[] }> {
  const byDate = new Map<string, WatchlistCandidate[]>();
  for (const candidate of candidates) {
    const list = byDate.get(candidate.game_date) ?? [];
    list.push(candidate);
    byDate.set(candidate.game_date, list);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, group]) => ({ date, candidates: group }));
}

/** A running mean that ignores the games a term is not defined for. */
class Mean {
  private sum = 0;
  private count = 0;

  add(value: number | null | undefined): void {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    this.sum += value;
    this.count += 1;
  }

  get value(): number | null {
    return this.count === 0 ? null : this.sum / this.count;
  }
}

/** One player's window, accumulated a game at a time. */
interface WindowAccumulator {
  /** The best-scoring game so far — the one that explains the row. */
  best: ScoredCandidate;
  scoreTotal: number;
  upside: Mean;
  relevance: Mean;
  percentile: Mean;
  probActive: Mean;
  minutesProjected: Mean;
  pointsProjected: Mean;
  impactTotal: number;
  /** Null stays null: a run with no impact for any of his games has no total. */
  impactKnown: boolean;
  totals: Partial<Record<ProjectedStat, number>>;
  games: WatchlistGame[];
}

/**
 * The ranked list for a window, which may be a single day.
 *
 * Anything whose WINDOW TOTAL is 0 is DROPPED rather than shown at the bottom: a
 * zero means he is projected at or below his own usual on every night he plays,
 * or is below the impact floor on every one of them, and neither is a claim worth
 * a row. An empty list on a quiet week is the honest answer, not a bug.
 *
 * `position` filters the RANKED rows, after scoring and before the limit, so the
 * caller gets `limit` players at that position rather than the players at that
 * position who happened to make the overall top `limit`. Candidates with no
 * position survive a null filter and no other.
 *
 * A placeholder name loses a tie to a real one, matching
 * `slate.ts::rankSlatePlayers` — an unidentified player must never win a tie
 * just by being lexicographically small.
 */
export function rankCandidates(
  candidates: WatchlistCandidate[],
  limit: number = WATCHLIST_LIMIT,
  position: PositionFilter | null = null
): WatchlistPlayer[] {
  const accumulators = new Map<string, WindowAccumulator>();

  for (const { candidates: nightly } of groupByDate(candidates)) {
    for (const scored of scoreCandidates(nightly)) {
      const { candidate, score } = scored;
      const id = candidate.nba_player_id;
      // a null score is an unknown night, not a bad one: it still counts as a
      // game he plays, and contributes nothing to the total.
      const contribution = score ?? 0;

      let accumulator = accumulators.get(id);
      if (!accumulator) {
        accumulator = {
          best: scored,
          scoreTotal: 0,
          upside: new Mean(),
          relevance: new Mean(),
          percentile: new Mean(),
          probActive: new Mean(),
          minutesProjected: new Mean(),
          pointsProjected: new Mean(),
          impactTotal: 0,
          impactKnown: false,
          totals: {},
          games: [],
        };
        accumulators.set(id, accumulator);
      } else if (contribution > (accumulator.best.score ?? 0)) {
        accumulator.best = scored;
      }

      accumulator.scoreTotal += contribution;
      accumulator.upside.add(scored.upside === null ? null : Math.max(0, scored.upside));
      accumulator.relevance.add(scored.relevance);
      accumulator.percentile.add(scored.impact_percentile);
      accumulator.probActive.add(candidate.prob_active);
      accumulator.minutesProjected.add(candidate.minutes.projected);
      accumulator.pointsProjected.add(candidate.points.projected);
      if (candidate.impact !== null) {
        accumulator.impactTotal += candidate.impact;
        accumulator.impactKnown = true;
      }
      for (const stat of PROJECTED_STATS) {
        const value = candidate.uncond[stat];
        if (value === null || !Number.isFinite(value)) continue;
        accumulator.totals[stat] = (accumulator.totals[stat] ?? 0) + value;
      }
      accumulator.games.push({
        game_date: candidate.game_date,
        nba_game_id: candidate.nba_game_id,
        opponent_team_abbr: candidate.opponent_team_abbr,
        minutes_p50: round(candidate.minutes.projected, 1),
        proj_pts: round(candidate.uncond.pts, 1),
        impact: candidate.impact,
        score: round(contribution, 3) as number,
      });
    }
  }

  const ranked: WatchlistPlayer[] = [];

  for (const accumulator of accumulators.values()) {
    if (accumulator.scoreTotal <= 0) continue;
    const candidate = accumulator.best.candidate;
    if (!matchesPosition(candidate.position, position)) continue;

    const gamesCount = accumulator.games.length;
    const reasons = reasonsFor(candidate);
    const totals: Partial<Record<ProjectedStat, number>> = {};
    for (const stat of PROJECTED_STATS) {
      const value = accumulator.totals[stat];
      if (value !== undefined) totals[stat] = round(value, 1) as number;
    }
    const minutesProjected = accumulator.minutesProjected.value;
    const pointsProjected = accumulator.pointsProjected.value;
    const usualMinutes = candidate.minutes.usual;
    const usualPoints = candidate.points.usual;

    ranked.push({
      nba_player_id: candidate.nba_player_id,
      name: candidate.name,
      name_is_placeholder: candidate.name_is_placeholder,
      team_abbr: candidate.team_abbr,
      position: candidate.position.label,
      opponent_team_abbr: candidate.opponent_team_abbr,
      nba_game_id: candidate.nba_game_id,
      game_date: candidate.game_date,
      games_count: gamesCount,
      games: [...accumulator.games].sort((a, b) => a.game_date.localeCompare(b.game_date)),
      score: round(accumulator.scoreTotal, 3) as number,
      score_per_game: round(accumulator.scoreTotal / gamesCount, 3) as number,
      upside: round(accumulator.upside.value ?? 0, 3) as number,
      drivers: accumulator.best.drivers.slice(0, UPSIDE_DRIVERS_SHOWN),
      relevance: round(accumulator.relevance.value ?? 0, 3) as number,
      impact: accumulator.impactKnown ? (round(accumulator.impactTotal, 2) as number) : null,
      impact_percentile: round(accumulator.percentile.value ?? 0, 1) as number,
      prob_active: round(accumulator.probActive.value, 3),
      minutes: {
        usual: round(usualMinutes, 1),
        projected: round(minutesProjected, 1),
        delta: round(deltaOf(minutesProjected, usualMinutes), 1),
      },
      points: {
        usual: round(usualPoints, 1),
        projected: round(pointsProjected, 1),
        delta: round(deltaOf(pointsProjected, usualPoints), 1),
      },
      totals,
      baseline_games: candidate.baseline_games,
      reasons,
      evidence: evidenceFor(candidate, reasons),
    });
  }

  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.impact ?? 0) - (a.impact ?? 0) ||
        (a.name_is_placeholder === b.name_is_placeholder ? 0 : a.name_is_placeholder ? 1 : -1) ||
        a.name.localeCompare(b.name) ||
        a.nba_player_id.localeCompare(b.nba_player_id)
    )
    .slice(0, limit);
}

/** One pivoted (date, game, player) row: fixed columns, then one per stat read. */
type PredictionRow = {
  game_date: unknown;
  nba_game_id: unknown;
  nba_player_id: unknown;
  name: unknown;
  team_abbr: unknown;
  position: unknown;
  prob_active: unknown;
  proj_min_p50: unknown;
} & { [K in ProjectedStat as `u_${K}`]: unknown } & {
  [K in ConditionalStat as `c_${K}`]: unknown;
};

/**
 * Parameter layout: $1 run, $2 window start, $3 window end, $4 prob_active,
 * $5 minutes, $6 the minutes quantile, then one per unconditional stat, then one
 * per conditional stat.
 */
const UNCOND_PARAM_OFFSET = 7;
const COND_PARAM_OFFSET = UNCOND_PARAM_OFFSET + PROJECTED_STATS.length;

/**
 * Two pivots over the same rows, because the two halves of the score need
 * different series and asking for the wrong one is silently wrong rather than
 * an error (see the STAT VOCABULARY block in slate.ts):
 *
 *   `u_*`  the UNCONDITIONAL expectation, `<stat>_uncond`. Availability is
 *          already priced in, which is what makes the impact score comparable
 *          across a slate containing game-time decisions. Feeds `relevance`.
 *
 *   `c_*`  the CONDITIONAL expectation, the bare stat name — "given he plays".
 *          Feeds the deviations, because the baseline it is subtracted from is a
 *          per-APPEARANCE average. Comparing an unconditional projection against
 *          a per-appearance baseline would read a 60%-likely starter as losing
 *          minutes when nothing about his role changed; availability belongs in
 *          `relevance`, and pricing it in twice is not a smaller error for being
 *          applied consistently.
 *
 * Minutes are the exception, and deliberately: they come from the conditional
 * P50 quantile, which is the same number the Projections tab prints as its
 * minutes line. A page and a badge disagreeing about a player's projected
 * minutes is worse than the mean/median distinction they would disagree by.
 */
const UNCOND_PIVOT_SQL = PROJECTED_STATS.map(
  (stat, i) =>
    `MAX(CASE WHEN pgp.stat = $${UNCOND_PARAM_OFFSET + i} AND pgp.quantile IS NULL
                       THEN pgp.value END)::float AS u_${stat}`
).join(',\n              ');

const COND_PIVOT_SQL = CONDITIONAL_STATS.map(
  (stat, i) =>
    `MAX(CASE WHEN pgp.stat = $${COND_PARAM_OFFSET + i} AND pgp.quantile IS NULL
                       THEN pgp.value END)::float AS c_${stat}`
).join(',\n              ');

/**
 * Every projected player-game in `[from, to]`, in ONE round trip.
 *
 * A window is a date RANGE rather than a loop over `days` single-date queries:
 * fourteen round trips to Neon from a Lambda is fourteen times the latency for
 * the same rows, and the grouping the per-night pools need is something
 * `groupByDate` can do in memory for free. `game_date` joins the GROUP BY so a
 * player appears once per game rather than once per window.
 *
 * `players` is a LEFT JOIN for the reason `slate.ts::fetchPredictions` documents
 * — a run can project a player the roster scrape has not written yet. That is
 * also the only way `position` comes back NULL.
 */
async function fetchPredictions(
  runId: number,
  from: string,
  to: string
): Promise<PredictionRow[]> {
  return rowsOrEmpty<PredictionRow>(() =>
    query(
      `SELECT pgp.game_date,
              pgp.nba_game_id,
              pgp.nba_player_id,
              MAX(p.name) AS name,
              MAX(p.team) AS team_abbr,
              MAX(p.position) AS position,
              MAX(CASE WHEN pgp.stat = $4 AND pgp.quantile IS NULL
                       THEN pgp.value END)::float AS prob_active,
              MAX(CASE WHEN pgp.stat = $5 AND pgp.quantile = $6
                       THEN pgp.value END)::float AS proj_min_p50,
              ${UNCOND_PIVOT_SQL},
              ${COND_PIVOT_SQL}
       FROM player_game_predictions pgp
       LEFT JOIN players p ON p.nba_id = pgp.nba_player_id
       WHERE pgp.prediction_run_id = $1
         AND pgp.game_date >= $2
         AND pgp.game_date <= $3
       GROUP BY pgp.game_date, pgp.nba_game_id, pgp.nba_player_id`,
      [
        runId,
        from,
        to,
        PROB_ACTIVE_STAT,
        MINUTES_STAT,
        MINUTES_QUANTILE,
        ...PROJECTED_STATS.map(uncondStat),
        ...CONDITIONAL_STATS,
      ]
    )
  );
}

interface GameRow {
  nba_game_id: unknown;
  home_team_abbr: unknown;
  away_team_abbr: unknown;
}

/**
 * game id -> the two teams' abbreviations, for naming the opponent. Read from
 * `nba_schedule`, which carries both abbreviations directly; a game the schedule
 * has no row for simply has no opponent to name.
 *
 * Keyed by game id alone, so one range query serves the whole window: an
 * `nba_game_id` already identifies its date.
 */
async function fetchGameTeams(
  from: string,
  to: string
): Promise<Map<string, [string | null, string | null]>> {
  const rows = await rowsOrEmpty<GameRow>(() =>
    query(
      `SELECT nba_game_id, home_team_abbr, away_team_abbr
       FROM nba_schedule
       WHERE game_date >= $1
         AND game_date <= $2`,
      [from, to]
    )
  );

  const map = new Map<string, [string | null, string | null]>();
  for (const row of rows) {
    map.set(String(row.nba_game_id), [
      row.home_team_abbr === null || row.home_team_abbr === undefined
        ? null
        : String(row.home_team_abbr),
      row.away_team_abbr === null || row.away_team_abbr === undefined
        ? null
        : String(row.away_team_abbr),
    ]);
  }
  return map;
}

/** The other team in a game, or null when either side is unknown. */
export function opponentOf(
  teamAbbr: string | null,
  teams: [string | null, string | null] | undefined
): string | null {
  if (!teamAbbr || !teams) return null;
  const [home, away] = teams;
  if (teamAbbr === home) return away;
  if (teamAbbr === away) return home;
  return null;
}

/**
 * One candidate per projected player-game, with baselines attached. Exported so
 * the backtest harness ranks exactly what the endpoint ranks rather than a
 * reimplementation of it.
 *
 * Rows may span several dates, and the IMPACT POOL IS BUILT PER DATE: each
 * player-game's z-scores are measured against the other player-games on ITS OWN
 * night, matching `slate.ts`'s pool exactly. Pooling a window would let a quiet
 * Tuesday's rows be graded against a loaded Wednesday's.
 *
 * `date` is the fallback for a row whose `game_date` cannot be read — impossible
 * from the range query, which filters on that column, so it exists only so a
 * hand-built row is attributed somewhere rather than dropped.
 *
 * Players with no usable baseline are DROPPED: "more than usual" is undefined
 * without a usual, and inventing one from three games would put every call-up at
 * the top of the list. That is also what keeps rookies and offseason signings
 * off the page — they have projections and no NBA history, so there is nothing
 * to deviate from.
 *
 * One baseline serves every date in the window, taken as of its first day — see
 * ONE BASELINE FOR THE WHOLE WINDOW at the top of this file. `days_since_played`
 * is still computed against each row's OWN date, because the gap to a game three
 * days out really is three days longer.
 */
export function buildCandidates(
  rows: PredictionRow[],
  baselines: Map<string, PlayerBaseline>,
  gameTeams: Map<string, [string | null, string | null]>,
  date: string
): WatchlistCandidate[] {
  const dates = rows.map((row) => toIsoDay(row.game_date) ?? date);

  const inputs: ImpactInput[] = rows.map((row) => {
    const entry = {} as ImpactInput;
    for (const stat of PROJECTED_STATS) {
      entry[stat] = num((row as Record<string, unknown>)[`u_${stat}`]);
    }
    return entry;
  });

  // one pool per date, including the players without a baseline, so the impact
  // percentile is measured against the whole night's slate rather than against
  // the subset that happens to be rankable.
  const impacts: Array<number | null> = new Array(rows.length).fill(null);
  const indexByDate = new Map<string, number[]>();
  dates.forEach((day, i) => {
    const list = indexByDate.get(day) ?? [];
    list.push(i);
    indexByDate.set(day, list);
  });
  for (const indices of indexByDate.values()) {
    const nightly = impactScores(indices.map((i) => inputs[i]));
    indices.forEach((i, n) => {
      impacts[i] = nightly[n];
    });
  }

  // usual minutes per player, so a teammate's absence can be weighed by the
  // minutes it actually frees.
  const usualMinutes = new Map<string, number | null>();
  for (const row of rows) {
    const id = String(row.nba_player_id);
    usualMinutes.set(id, baselines.get(id)?.avg.minutes ?? null);
  }

  // keyed by game id, which already identifies a single date, so a window's
  // teams never bleed into each other.
  const byGameTeam = new Map<string, Array<{ id: string; name: string; prob: number | null }>>();
  rows.forEach((row) => {
    const team = row.team_abbr === null || row.team_abbr === undefined ? null : String(row.team_abbr);
    if (!team) return;
    const key = `${String(row.nba_game_id)}|${team}`;
    const list = byGameTeam.get(key) ?? [];
    const id = String(row.nba_player_id);
    list.push({ id, name: resolvePlayerName(row.name, id).name, prob: num(row.prob_active) });
    byGameTeam.set(key, list);
  });

  const candidates: WatchlistCandidate[] = [];

  rows.forEach((row, i) => {
    const id = String(row.nba_player_id);
    const baseline = baselines.get(id);
    if (!hasUsableBaseline(baseline)) return;
    const usual = (baseline as PlayerBaseline).avg;
    const gameDate = dates[i];

    const projMinutes = num(row.proj_min_p50);
    const deltas: Partial<Record<DeviationStat, number>> = {};
    for (const stat of DEVIATION_STATS) {
      const projected =
        stat === 'minutes' ? projMinutes : num((row as Record<string, unknown>)[`c_${stat}`]);
      const delta = deltaOf(projected, usual[stat]);
      if (delta !== null) deltas[stat] = delta;
    }

    const team = row.team_abbr === null || row.team_abbr === undefined ? null : String(row.team_abbr);
    const projPts = num((row as Record<string, unknown>).c_pts);
    const projFga = num((row as Record<string, unknown>).c_fga);

    // a player is never his own absent teammate.
    const teammates = (team ? byGameTeam.get(`${String(row.nba_game_id)}|${team}`) ?? [] : [])
      .filter((mate) => mate.id !== id)
      .map((mate) => ({
        name: mate.name,
        usual_minutes: usualMinutes.get(mate.id) ?? null,
        prob_active: mate.prob,
      }));

    const { name, placeholder } = resolvePlayerName(row.name, id);

    candidates.push({
      nba_player_id: id,
      name,
      name_is_placeholder: placeholder,
      team_abbr: team,
      position: parsePositions(row.position),
      opponent_team_abbr: opponentOf(team, gameTeams.get(String(row.nba_game_id))),
      nba_game_id: String(row.nba_game_id),
      game_date: gameDate,
      prob_active: num(row.prob_active),
      impact: impacts[i],
      proj_pts_uncond: inputs[i].pts,
      uncond: inputs[i],
      baseline_games: (baseline as PlayerBaseline).games,
      deltas,
      minutes: {
        usual: usual.minutes,
        projected: projMinutes,
        delta: deltaOf(projMinutes, usual.minutes),
      },
      points: { usual: usual.pts, projected: projPts, delta: deltaOf(projPts, usual.pts) },
      shots: { usual: usual.fga, projected: projFga, delta: deltaOf(projFga, usual.fga) },
      days_since_played: daysSince(gameDate, (baseline as PlayerBaseline).last_played_date),
      last_played_date: (baseline as PlayerBaseline).last_played_date,
      pts_recent: (baseline as PlayerBaseline).pts_recent,
      pts_sd: (baseline as PlayerBaseline).pts_sd,
      teammate_out: findAbsentTeammate(teammates),
    });
  });

  return candidates;
}

/** Options the endpoint passes through, plus the two the backtest harness needs. */
export interface WatchlistOptions {
  /** Score against THIS run instead of the newest complete one. */
  run?: (SlateRun & { id: number }) | null;
  limit?: number;
  /** Days the window covers, starting at `date`. Defaults to one. */
  days?: number;
  /** Keep only players answering this position. Null keeps every position. */
  position?: PositionFilter | null;
}

/** Everything one window's read produces, before scoring. */
export interface WatchlistCandidateWindow {
  /** Player-games the run has across the whole window — the summed pool size. */
  pool_size: number;
  /** Distinct rankable players with and without a position, before filtering. */
  position_coverage: PositionCoverage;
  candidates: WatchlistCandidate[];
}

/**
 * Every candidate one run has across a window, before scoring.
 *
 * Three round trips regardless of how many days the window covers: one ranged
 * predictions query, one baseline query as of the window's FIRST day, and one
 * ranged schedule query for the opponents.
 */
export async function fetchWatchlistWindow(
  window: WatchlistWindow,
  runId: number
): Promise<WatchlistCandidateWindow> {
  const empty: WatchlistCandidateWindow = {
    pool_size: 0,
    position_coverage: { known: 0, unknown: 0 },
    candidates: [],
  };

  const rows = await fetchPredictions(runId, window.from, window.to);
  if (rows.length === 0) return empty;

  const baselines = await fetchBaselines(window.from);
  const gameTeams = await fetchGameTeams(window.from, window.to);
  const candidates = buildCandidates(rows, baselines, gameTeams, window.from);

  // counted over distinct PLAYERS, not player-games, so a four-game week does
  // not report the same missing roster row four times.
  const known = new Set<string>();
  const unknown = new Set<string>();
  for (const candidate of candidates) {
    (candidate.position.label === null ? unknown : known).add(candidate.nba_player_id);
  }

  return {
    pool_size: rows.length,
    position_coverage: { known: known.size, unknown: unknown.size },
    candidates,
  };
}

/**
 * Every candidate one run has for ONE date, before scoring. Exported so
 * `scripts/watchlistBacktest.ts` evaluates the SHIPPED pipeline — the same
 * pivot, the same baseline query, the same eligibility rule — rather than a
 * reimplementation of it that could quietly diverge and make the backtest
 * measure the wrong thing.
 */
export async function fetchWatchlistCandidates(
  date: string,
  runId: number
): Promise<{ pool_size: number; candidates: WatchlistCandidate[] }> {
  const { pool_size, candidates } = await fetchWatchlistWindow(windowRange(date, 1), runId);
  return { pool_size, candidates };
}

/**
 * The ranked big-night list for a window of `days` starting at `date`.
 *
 * Degrades to an empty list, never an error: with no complete run there are no
 * projections to compare against a baseline, and with no game logs there are no
 * baselines. Both are ordinary states — the first is production before the first
 * model run — and each returns `players: []` with the window, pool and baseline
 * descriptors still echoed so the page can explain itself.
 *
 * Note the change in kind from the pre-projection version: this list cannot be
 * produced from game logs alone. The old page ranked rule hits and so had
 * something to say without a run; this one ranks projection-minus-baseline, and
 * without a projection there is nothing to rank.
 */
export async function getWatchlist(
  date: string,
  options: WatchlistOptions = {}
): Promise<WatchlistResponse> {
  const days = options.days ?? DEFAULT_WINDOW_DAYS;
  const position = options.position ?? null;
  const window = windowRange(date, days);
  const run = options.run !== undefined ? options.run : await getLatestCompleteRun();
  const runSummary = run
    ? { model_version: run.model_version, predicted_at: run.predicted_at }
    : null;
  const baseline = baselineDescriptor();
  const shared = {
    date,
    window,
    baseline,
    position,
    position_options: [...POSITION_FILTERS],
  };

  if (!run) {
    return {
      ...shared,
      run: null,
      pool: watchlistPool(0, days),
      position_coverage: { known: 0, unknown: 0 },
      players: [],
    };
  }

  const { pool_size, position_coverage, candidates } = await fetchWatchlistWindow(window, run.id);

  return {
    ...shared,
    run: runSummary,
    pool: watchlistPool(pool_size, days),
    position_coverage,
    players: rankCandidates(candidates, options.limit ?? WATCHLIST_LIMIT, position),
  };
}

export { MIN_BASELINE_GAMES };
