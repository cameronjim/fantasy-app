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

export interface WatchlistPlayer {
  nba_player_id: string;
  name: string;
  /** True when `name` is a stand-in built from the id (see slate.ts). */
  name_is_placeholder: boolean;
  team_abbr: string | null;
  opponent_team_abbr: string | null;
  nba_game_id: string;
  game_date: string;
  /** `max(0, upside) x relevance`. See THE SCORE at the top of this file. */
  score: number;
  /** The deviation term: scaled projection-minus-usual, weighted mean. */
  upside: number;
  /** Which deviations point up, biggest contribution first. Capped. */
  drivers: UpsideDriver[];
  /** The absolute floor term, 0-1. Exactly 0 below the impact percentile floor. */
  relevance: number;
  /** Tonight's absolute projected impact — the same number the slate shows. */
  impact: number | null;
  /** Where that impact sits in tonight's pool, 0-100. */
  impact_percentile: number;
  prob_active: number | null;
  minutes: VsUsual;
  points: VsUsual;
  baseline_games: number;
  reasons: ReasonCode[];
  evidence: WatchlistEvidence;
}

export interface WatchlistResponse {
  date: string;
  /** Null until a run has completed — the page shows its own notice. */
  run: SlateRun | null;
  /** The pool the impact percentile is measured in — slate.ts's pool, verbatim. */
  pool: SlatePool;
  /** What "usual" means, so the page never states a definition of its own. */
  baseline: BaselineDescriptor;
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
 * The ranked list. Anything scoring 0 is DROPPED rather than shown at the
 * bottom: a zero means either "not projected above his own usual" or "in the
 * bottom half of tonight's slate", and neither is a claim worth a row. An empty
 * list on a quiet night is the honest answer, not a bug.
 *
 * A placeholder name loses a tie to a real one, matching
 * `slate.ts::rankSlatePlayers` — an unidentified player must never win a tie
 * just by being lexicographically small.
 */
export function rankCandidates(
  candidates: WatchlistCandidate[],
  limit: number = WATCHLIST_LIMIT
): WatchlistPlayer[] {
  const ranked: WatchlistPlayer[] = [];

  for (const scored of scoreCandidates(candidates)) {
    const { candidate, score, upside, drivers, relevance } = scored;
    if (score === null || score <= 0) continue;

    const reasons = reasonsFor(candidate);
    ranked.push({
      nba_player_id: candidate.nba_player_id,
      name: candidate.name,
      name_is_placeholder: candidate.name_is_placeholder,
      team_abbr: candidate.team_abbr,
      opponent_team_abbr: candidate.opponent_team_abbr,
      nba_game_id: candidate.nba_game_id,
      game_date: candidate.game_date,
      score,
      upside: round(Math.max(0, upside as number), 3) as number,
      drivers: drivers.slice(0, UPSIDE_DRIVERS_SHOWN),
      relevance: relevance as number,
      impact: candidate.impact,
      impact_percentile: scored.impact_percentile,
      prob_active: round(candidate.prob_active, 3),
      minutes: {
        usual: round(candidate.minutes.usual, 1),
        projected: round(candidate.minutes.projected, 1),
        delta: round(candidate.minutes.delta, 1),
      },
      points: {
        usual: round(candidate.points.usual, 1),
        projected: round(candidate.points.projected, 1),
        delta: round(candidate.points.delta, 1),
      },
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

/** One pivoted (game, player) row: fixed columns, then one per stat read. */
type PredictionRow = {
  nba_game_id: unknown;
  nba_player_id: unknown;
  name: unknown;
  team_abbr: unknown;
  prob_active: unknown;
  proj_min_p50: unknown;
} & { [K in ProjectedStat as `u_${K}`]: unknown } & {
  [K in ConditionalStat as `c_${K}`]: unknown;
};

/**
 * Parameter layout: $1 run, $2 date, $3 prob_active, $4 minutes, $5 the minutes
 * quantile, then one per unconditional stat, then one per conditional stat.
 */
const UNCOND_PARAM_OFFSET = 6;
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
              ${UNCOND_PIVOT_SQL},
              ${COND_PIVOT_SQL}
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
 */
async function fetchGameTeams(date: string): Promise<Map<string, [string | null, string | null]>> {
  const rows = await rowsOrEmpty<GameRow>(() =>
    query(
      `SELECT nba_game_id, home_team_abbr, away_team_abbr
       FROM nba_schedule
       WHERE game_date = $1`,
      [date]
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
 * Players with no usable baseline are DROPPED: "more than usual" is undefined
 * without a usual, and inventing one from three games would put every call-up at
 * the top of the list. That is also what keeps rookies and offseason signings
 * off the page — they have projections and no NBA history, so there is nothing
 * to deviate from.
 */
export function buildCandidates(
  rows: PredictionRow[],
  baselines: Map<string, PlayerBaseline>,
  gameTeams: Map<string, [string | null, string | null]>,
  date: string
): WatchlistCandidate[] {
  // the pool is every player-game the run has for this date, matching
  // slate.ts's pool exactly — including the players without a baseline, so the
  // impact percentile is measured against the whole slate rather than against
  // the subset that happens to be rankable.
  const inputs: ImpactInput[] = rows.map((row) => {
    const entry = {} as ImpactInput;
    for (const stat of PROJECTED_STATS) {
      entry[stat] = num((row as Record<string, unknown>)[`u_${stat}`]);
    }
    return entry;
  });
  const impacts = impactScores(inputs);

  // usual minutes per player-game, so a teammate's absence can be weighed by
  // the minutes it actually frees.
  const usualMinutes = new Map<string, number | null>();
  for (const row of rows) {
    const id = String(row.nba_player_id);
    usualMinutes.set(id, baselines.get(id)?.avg.minutes ?? null);
  }

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
      opponent_team_abbr: opponentOf(team, gameTeams.get(String(row.nba_game_id))),
      nba_game_id: String(row.nba_game_id),
      game_date: date,
      prob_active: num(row.prob_active),
      impact: impacts[i],
      proj_pts_uncond: inputs[i].pts,
      baseline_games: (baseline as PlayerBaseline).games,
      deltas,
      minutes: {
        usual: usual.minutes,
        projected: projMinutes,
        delta: deltaOf(projMinutes, usual.minutes),
      },
      points: { usual: usual.pts, projected: projPts, delta: deltaOf(projPts, usual.pts) },
      shots: { usual: usual.fga, projected: projFga, delta: deltaOf(projFga, usual.fga) },
      days_since_played: daysSince(date, (baseline as PlayerBaseline).last_played_date),
      last_played_date: (baseline as PlayerBaseline).last_played_date,
      pts_recent: (baseline as PlayerBaseline).pts_recent,
      pts_sd: (baseline as PlayerBaseline).pts_sd,
      teammate_out: findAbsentTeammate(teammates),
    });
  });

  return candidates;
}

/** Options the backtest harness needs and the endpoint does not. */
export interface WatchlistOptions {
  /** Score against THIS run instead of the newest complete one. */
  run?: (SlateRun & { id: number }) | null;
  limit?: number;
}

/**
 * Every candidate one run has for one date, before scoring. Exported so
 * `scripts/watchlistBacktest.ts` evaluates the SHIPPED pipeline — the same
 * pivot, the same baseline query, the same eligibility rule — rather than a
 * reimplementation of it that could quietly diverge and make the backtest
 * measure the wrong thing.
 */
export async function fetchWatchlistCandidates(
  date: string,
  runId: number
): Promise<{ pool_size: number; candidates: WatchlistCandidate[] }> {
  const rows = await fetchPredictions(runId, date);
  if (rows.length === 0) return { pool_size: 0, candidates: [] };

  const baselines = await fetchBaselines(date);
  const gameTeams = await fetchGameTeams(date);
  return { pool_size: rows.length, candidates: buildCandidates(rows, baselines, gameTeams, date) };
}

/**
 * The ranked big-night list for one date.
 *
 * Degrades to an empty list, never an error: with no complete run there are no
 * projections to compare against a baseline, and with no game logs there are no
 * baselines. Both are ordinary states — the first is production before the first
 * model run — and each returns `players: []` with the pool and baseline
 * descriptors still echoed so the page can explain itself.
 *
 * Note the change in kind from the previous version: this list cannot be
 * produced from game logs alone. The old page ranked rule hits and so had
 * something to say without a run; this one ranks projection-minus-baseline, and
 * without a projection there is nothing to rank.
 */
export async function getWatchlist(
  date: string,
  options: WatchlistOptions = {}
): Promise<WatchlistResponse> {
  const run = options.run !== undefined ? options.run : await getLatestCompleteRun();
  const runSummary = run
    ? { model_version: run.model_version, predicted_at: run.predicted_at }
    : null;
  const baseline = baselineDescriptor();

  if (!run) {
    return { date, run: null, pool: poolDescriptor(0), baseline, players: [] };
  }

  const { pool_size, candidates } = await fetchWatchlistCandidates(date, run.id);

  return {
    date,
    run: runSummary,
    pool: poolDescriptor(pool_size),
    baseline,
    players: rankCandidates(candidates, options.limit ?? WATCHLIST_LIMIT),
  };
}

export { MIN_BASELINE_GAMES };
