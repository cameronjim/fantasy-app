import { query } from '../db.js';
import { getLatestCompleteRun, num, round, rowsOrEmpty, toIsoDay, PROB_ACTIVE_STAT } from './slate.js';

/**
 * Waiver-wire discovery: which under-owned players just had something
 * measurable change about their situation.
 *
 * Every reason here is a DETERMINISTIC rule over game logs and injury status —
 * no model call, no prose. That is the point: a manager can check any badge on
 * this page against a box score. The model only ever scales the result, by
 * multiplying the rule score by the player's probability of actually playing.
 *
 * ============================ THRESHOLDS ============================
 * These constants are mirrored in ml/fnba_ml/watchlist.py, which is the
 * Python reference implementation of the same rules. THE TWO MUST STAY IN
 * SYNC — changing a threshold here means changing it there in the same commit,
 * or the notebook analysis and the shipped page will disagree about what a
 * "role increase" is.
 * ====================================================================
 */

export const REASON_CODES = [
  'ROLE_INCREASE',
  'SHOT_VOLUME_SURGE',
  'RETURNING_FROM_ABSENCE',
  'HOT_STREAK',
  'TEAMMATE_ABSENCE',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** Minutes the last-5 average must exceed the last-15 average by. */
export const ROLE_INCREASE_MIN_DELTA = 4;

/** Field-goal attempts the last-5 average must exceed the last-15 average by. */
export const SHOT_VOLUME_SURGE_FGA_DELTA = 2.5;

/** Days between the two most recent appearances that count as an absence. */
export const RETURN_GAP_DAYS = 7;

/** Multiples of the player's own game-to-game stddev that count as a hot streak. */
export const HOT_STREAK_STDDEV_MULTIPLE = 1.5;

/** Minutes per game a sidelined teammate must average to open real usage. */
export const TEAMMATE_ABSENCE_MIN_MINUTES = 28;

/** The only injury status that reliably means "will not play". */
export const TEAMMATE_ABSENCE_STATUS = 'Out';

/**
 * Season scoring average at or above which a player is not a discovery. A
 * 20-ppg player being hot is news; it is not a waiver claim, and leaving them
 * in would let stars crowd out every actual find.
 */
export const STAR_EXCLUSION_PPG = 20;

/** How many candidates the endpoint returns. */
export const WATCHLIST_LIMIT = 20;

/**
 * Relative weight of each reason in the score. Ordered by how directly the
 * signal implies future fantasy production: a minutes jump is opportunity
 * that has already been granted, while a hot streak is partly noise the
 * player may not repeat.
 */
export const REASON_WEIGHTS: Record<ReasonCode, number> = {
  ROLE_INCREASE: 3,
  TEAMMATE_ABSENCE: 2.5,
  SHOT_VOLUME_SURGE: 2,
  RETURNING_FROM_ABSENCE: 1.5,
  HOT_STREAK: 1,
};

/** A teammate whose absence opens usage. */
export interface AbsentTeammate {
  name: string;
  minutes_per_game: number;
}

/** Everything the rules need about one player. Plain data — no db types. */
export interface WatchlistCandidate {
  nba_player_id: string;
  name: string;
  team_abbr: string | null;
  /** Season points per game, used only for the star exclusion. */
  season_ppg: number | null;
  min_r5: number | null;
  min_r15: number | null;
  fga_r5: number | null;
  fga_r15: number | null;
  pts_r5: number | null;
  pts_season: number | null;
  pts_stddev: number | null;
  /** Days between the two most recent appearances, null with fewer than two. */
  gap_days: number | null;
  /** True when the most recent appearance was an actual appearance (minutes > 0). */
  played_last_game: boolean;
  last_game_date: string | null;
  teammate_out: AbsentTeammate | null;
  prob_active: number | null;
}

/** The numbers behind whichever reasons fired, for the UI to show on demand. */
export interface WatchlistEvidence {
  min_r5?: number;
  min_r15?: number;
  min_delta?: number;
  fga_r5?: number;
  fga_r15?: number;
  fga_delta?: number;
  gap_days?: number;
  last_game_date?: string;
  pts_r5?: number;
  pts_season?: number;
  pts_stddev?: number;
  pts_delta?: number;
  teammate_out?: string;
  teammate_out_minutes?: number;
}

export interface WatchlistPlayer {
  nba_player_id: string;
  name: string;
  team_abbr: string | null;
  score: number;
  prob_active: number | null;
  reasons: ReasonCode[];
  evidence: WatchlistEvidence;
}

export interface WatchlistResponse {
  date: string;
  players: WatchlistPlayer[];
}

/** Both averages are needed — a player with no 15-game baseline has no trend. */
export function hasRoleIncrease(minR5: number | null, minR15: number | null): boolean {
  if (minR5 === null || minR15 === null) return false;
  return minR5 - minR15 >= ROLE_INCREASE_MIN_DELTA;
}

/**
 * Shots, not minutes: a player can be on the floor longer without the ball.
 * Attempts are the part of usage the box score settles unambiguously.
 */
export function hasShotVolumeSurge(fgaR5: number | null, fgaR15: number | null): boolean {
  if (fgaR5 === null || fgaR15 === null) return false;
  return fgaR5 - fgaR15 >= SHOT_VOLUME_SURGE_FGA_DELTA;
}

/**
 * A long gap followed by an appearance. Both halves matter: the gap alone
 * describes someone still hurt, which is the opposite of a pickup.
 */
export function isReturningFromAbsence(gapDays: number | null, playedLastGame: boolean): boolean {
  if (gapDays === null) return false;
  return gapDays >= RETURN_GAP_DAYS && playedLastGame;
}

/**
 * Scored against the player's OWN volatility rather than a fixed points
 * threshold: +4 points from a metronome is a real change, +4 from someone who
 * swings 12 a night is Tuesday. A zero (or missing) stddev has nothing to
 * scale by, so it never fires.
 */
export function isHotStreak(
  ptsR5: number | null,
  seasonAvg: number | null,
  stddev: number | null
): boolean {
  if (ptsR5 === null || seasonAvg === null || stddev === null || stddev <= 0) return false;
  return ptsR5 - seasonAvg >= HOT_STREAK_STDDEV_MULTIPLE * stddev;
}

/**
 * The highest-minutes teammate who is ruled Out and plays a real rotation
 * role, or null. Highest minutes wins because that is the usage actually up
 * for grabs.
 */
export function findAbsentTeammate(
  teammates: Array<{ name: string; minutes_per_game: number | null; injury_status: string | null }>
): AbsentTeammate | null {
  let best: AbsentTeammate | null = null;
  for (const mate of teammates) {
    const minutes = mate.minutes_per_game;
    if (mate.injury_status !== TEAMMATE_ABSENCE_STATUS) continue;
    if (minutes === null || minutes < TEAMMATE_ABSENCE_MIN_MINUTES) continue;
    if (!best || minutes > best.minutes_per_game) {
      best = { name: mate.name, minutes_per_game: minutes };
    }
  }
  return best;
}

/**
 * Established scorers are excluded — they are already rostered everywhere, so
 * surfacing them would be a worse use of the twenty slots. An unknown average
 * is treated as a candidate, since "no season line yet" describes exactly the
 * rookie or call-up this page exists to find.
 */
export function isDiscoveryCandidate(seasonPpg: number | null): boolean {
  if (seasonPpg === null) return true;
  return seasonPpg < STAR_EXCLUSION_PPG;
}

/** Every reason that fires for a candidate, in REASON_CODES order. */
export function reasonsFor(candidate: WatchlistCandidate): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  if (hasRoleIncrease(candidate.min_r5, candidate.min_r15)) reasons.push('ROLE_INCREASE');
  if (hasShotVolumeSurge(candidate.fga_r5, candidate.fga_r15)) reasons.push('SHOT_VOLUME_SURGE');
  if (isReturningFromAbsence(candidate.gap_days, candidate.played_last_game)) {
    reasons.push('RETURNING_FROM_ABSENCE');
  }
  if (isHotStreak(candidate.pts_r5, candidate.pts_season, candidate.pts_stddev)) {
    reasons.push('HOT_STREAK');
  }
  if (candidate.teammate_out !== null) reasons.push('TEAMMATE_ABSENCE');
  return reasons;
}

/** The supporting numbers for the reasons that actually fired, and no others. */
export function evidenceFor(
  candidate: WatchlistCandidate,
  reasons: ReasonCode[]
): WatchlistEvidence {
  const evidence: WatchlistEvidence = {};
  const set = new Set<ReasonCode>(reasons);

  if (set.has('ROLE_INCREASE') && candidate.min_r5 !== null && candidate.min_r15 !== null) {
    evidence.min_r5 = round(candidate.min_r5, 1) as number;
    evidence.min_r15 = round(candidate.min_r15, 1) as number;
    evidence.min_delta = round(candidate.min_r5 - candidate.min_r15, 1) as number;
  }
  if (set.has('SHOT_VOLUME_SURGE') && candidate.fga_r5 !== null && candidate.fga_r15 !== null) {
    evidence.fga_r5 = round(candidate.fga_r5, 1) as number;
    evidence.fga_r15 = round(candidate.fga_r15, 1) as number;
    evidence.fga_delta = round(candidate.fga_r5 - candidate.fga_r15, 1) as number;
  }
  if (set.has('RETURNING_FROM_ABSENCE') && candidate.gap_days !== null) {
    evidence.gap_days = candidate.gap_days;
    if (candidate.last_game_date) evidence.last_game_date = candidate.last_game_date;
  }
  if (
    set.has('HOT_STREAK') &&
    candidate.pts_r5 !== null &&
    candidate.pts_season !== null &&
    candidate.pts_stddev !== null
  ) {
    evidence.pts_r5 = round(candidate.pts_r5, 1) as number;
    evidence.pts_season = round(candidate.pts_season, 1) as number;
    evidence.pts_stddev = round(candidate.pts_stddev, 1) as number;
    evidence.pts_delta = round(candidate.pts_r5 - candidate.pts_season, 1) as number;
  }
  if (set.has('TEAMMATE_ABSENCE') && candidate.teammate_out) {
    evidence.teammate_out = candidate.teammate_out.name;
    evidence.teammate_out_minutes = round(candidate.teammate_out.minutes_per_game, 1) as number;
  }

  return evidence;
}

/**
 * Weighted reason count, scaled by the chance the player is actually available.
 * With no prediction run the score degrades to the reason weights alone rather
 * than to zero — the rules are still true, we just cannot discount them.
 *
 * `prob_active` is clamped to [0, 1] so a malformed prediction row can never
 * inflate a player above the rules that justify them.
 */
export function scoreFor(reasons: ReasonCode[], probActive: number | null): number {
  let weight = 0;
  for (const reason of reasons) weight += REASON_WEIGHTS[reason];
  const scale = probActive === null ? 1 : Math.min(1, Math.max(0, probActive));
  return round(weight * scale, 3) as number;
}

/**
 * Candidates with at least one reason, best score first, capped at `limit`.
 * Stars are dropped here rather than in SQL so the exclusion is testable
 * without a database.
 */
export function rankCandidates(
  candidates: WatchlistCandidate[],
  limit: number = WATCHLIST_LIMIT
): WatchlistPlayer[] {
  const ranked: WatchlistPlayer[] = [];

  for (const candidate of candidates) {
    if (!isDiscoveryCandidate(candidate.season_ppg)) continue;
    const reasons = reasonsFor(candidate);
    if (reasons.length === 0) continue;
    ranked.push({
      nba_player_id: candidate.nba_player_id,
      name: candidate.name,
      team_abbr: candidate.team_abbr,
      score: scoreFor(reasons, candidate.prob_active),
      prob_active: round(candidate.prob_active, 3),
      reasons,
      evidence: evidenceFor(candidate, reasons),
    });
  }

  return ranked
    .sort((a, b) => b.score - a.score || b.reasons.length - a.reasons.length || a.name.localeCompare(b.name))
    .slice(0, limit);
}

interface PlayerMetaRow {
  nba_id: unknown;
  name: unknown;
  team: unknown;
  injury_status: unknown;
  minutes_per_game: unknown;
  points_per_game: unknown;
}

interface LogAggregateRow {
  nba_player_id: unknown;
  min_r5: unknown;
  min_r15: unknown;
  fga_r5: unknown;
  fga_r15: unknown;
  pts_r5: unknown;
  pts_season: unknown;
  pts_stddev: unknown;
  last_game_date: unknown;
  prev_game_date: unknown;
  last_game_minutes: unknown;
}

// the logs table spans seasons; "this season" is whichever the scraper wrote
// last, and season labels sort lexicographically. same convention as
// analytics.ts.
const CURRENT_SEASON = '(SELECT MAX(season) FROM player_game_logs)';

/**
 * Rolling windows per player, computed entirely in SQL over the games played
 * STRICTLY BEFORE the requested date. That cutoff is what keeps the watchlist
 * a forecast: including the target day's box score would make every rule
 * trivially correct after the fact.
 */
async function fetchLogAggregates(date: string): Promise<LogAggregateRow[]> {
  return rowsOrEmpty<LogAggregateRow>(() =>
    query(
      `WITH logs AS (
           SELECT g.nba_player_id,
                  g.game_date,
                  g.minutes::float AS minutes,
                  g.pts::float     AS pts,
                  g.fga::float     AS fga,
                  ROW_NUMBER() OVER (
                    PARTITION BY g.nba_player_id ORDER BY g.game_date DESC
                  ) AS rn,
                  LEAD(g.game_date) OVER (
                    PARTITION BY g.nba_player_id ORDER BY g.game_date DESC
                  ) AS prev_date
           FROM player_game_logs g
           WHERE g.season = ${CURRENT_SEASON}
             AND g.season_type = 'Regular Season'
             AND g.game_date < $1
         )
         SELECT nba_player_id,
                AVG(minutes) FILTER (WHERE rn <= 5)  AS min_r5,
                AVG(minutes) FILTER (WHERE rn <= 15) AS min_r15,
                AVG(fga)     FILTER (WHERE rn <= 5)  AS fga_r5,
                AVG(fga)     FILTER (WHERE rn <= 15) AS fga_r15,
                AVG(pts)     FILTER (WHERE rn <= 5)  AS pts_r5,
                AVG(pts)                             AS pts_season,
                STDDEV_POP(pts)                      AS pts_stddev,
                MAX(game_date) FILTER (WHERE rn = 1) AS last_game_date,
                MAX(prev_date) FILTER (WHERE rn = 1) AS prev_game_date,
                MAX(minutes)   FILTER (WHERE rn = 1) AS last_game_minutes
         FROM logs
         GROUP BY nba_player_id`,
      [date]
    )
  );
}

async function fetchPlayerMeta(): Promise<PlayerMetaRow[]> {
  const result = await query(
    `SELECT nba_id, name, team, injury_status,
            minutes_per_game::float AS minutes_per_game,
            points_per_game::float  AS points_per_game
     FROM players
     WHERE nba_id IS NOT NULL`
  );
  return result.rows as PlayerMetaRow[];
}

/**
 * `prob_active` for the requested day, from the newest complete run. Missing
 * entirely before the first run, which the scoring handles.
 */
async function fetchProbActive(runId: number, date: string): Promise<Map<string, number>> {
  const rows = await rowsOrEmpty<{ nba_player_id: unknown; prob_active: unknown }>(() =>
    query(
      `SELECT nba_player_id, MAX(value)::float AS prob_active
       FROM player_game_predictions
       WHERE prediction_run_id = $1
         AND game_date = $2
         AND stat = $3
         AND quantile IS NULL
       GROUP BY nba_player_id`,
      [runId, date, PROB_ACTIVE_STAT]
    )
  );

  const map = new Map<string, number>();
  for (const row of rows) {
    const value = num(row.prob_active);
    if (value !== null) map.set(String(row.nba_player_id), value);
  }
  return map;
}

/** Whole days between two ISO days, or null when either is missing. */
export function dayGap(later: string | null, earlier: string | null): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/**
 * The ranked discovery list for one date. Degrades cleanly: without a
 * prediction run every score is rules-only, and without game logs the list is
 * simply empty.
 */
export async function getWatchlist(date: string): Promise<WatchlistResponse> {
  const meta = await fetchPlayerMeta();
  const aggregates = await fetchLogAggregates(date);
  const run = await getLatestCompleteRun();
  const probActive = run ? await fetchProbActive(run.id, date) : new Map<string, number>();

  const metaById = new Map<string, PlayerMetaRow>();
  const byTeam = new Map<string, PlayerMetaRow[]>();
  for (const row of meta) {
    const id = String(row.nba_id);
    metaById.set(id, row);
    const team = row.team === null || row.team === undefined ? '' : String(row.team);
    if (!team) continue;
    const list = byTeam.get(team) ?? [];
    list.push(row);
    byTeam.set(team, list);
  }

  const candidates: WatchlistCandidate[] = [];
  for (const row of aggregates) {
    const id = String(row.nba_player_id);
    const player = metaById.get(id);
    // a logged player we have no roster row for has no name, team or season
    // average to reason about, so there is nothing to show.
    if (!player) continue;

    const team = player.team === null || player.team === undefined ? null : String(player.team);
    // a player is never their own absent teammate.
    const teammates = (team ? byTeam.get(team) ?? [] : [])
      .filter((mate) => String(mate.nba_id) !== id)
      .map((mate) => ({
        name: String(mate.name ?? ''),
        minutes_per_game: num(mate.minutes_per_game),
        injury_status:
          mate.injury_status === null || mate.injury_status === undefined
            ? null
            : String(mate.injury_status),
      }));

    const lastGameDate = toIsoDay(row.last_game_date);

    candidates.push({
      nba_player_id: id,
      name: String(player.name ?? ''),
      team_abbr: team,
      season_ppg: num(player.points_per_game),
      min_r5: num(row.min_r5),
      min_r15: num(row.min_r15),
      fga_r5: num(row.fga_r5),
      fga_r15: num(row.fga_r15),
      pts_r5: num(row.pts_r5),
      pts_season: num(row.pts_season),
      pts_stddev: num(row.pts_stddev),
      gap_days: dayGap(lastGameDate, toIsoDay(row.prev_game_date)),
      played_last_game: (num(row.last_game_minutes) ?? 0) > 0,
      last_game_date: lastGameDate,
      teammate_out: findAbsentTeammate(teammates),
      prob_active: probActive.get(id) ?? null,
    });
  }

  return { date, players: rankCandidates(candidates) };
}
