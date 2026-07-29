import { query } from '../db.js';

// current-season analytics for a single player: where they sit inside the
// rotation pool, what that pool's distribution looks like, and how their recent
// form compares to their own baseline.
//
// every piece of math lives in an exported pure function operating on plain
// arrays, so the rules can be unit tested without a database. only the
// `get*` functions at the bottom of the file touch pg.

/** Stat keys the percentile + distribution views are computed over. */
export const ANALYTICS_STATS = [
  'pts',
  'reb',
  'ast',
  'stl',
  'blk',
  'fg3m',
  'tov',
  'fg_impact',
  'ft_impact',
  'minutes',
] as const;

export type AnalyticsStat = (typeof ANALYTICS_STATS)[number];

// turnovers are the only category where less is better, so their percentile is
// flipped — the player who coughs it up least sits at the top of the scale.
const REVERSED_STATS: ReadonlySet<string> = new Set<AnalyticsStat>(['tov']);

/**
 * Stats the recent-form comparison covers. FG/FT impact are excluded: they are
 * pool-relative measures, so a 10-game slice of them would be comparing the
 * player against a season-long pool percentage rather than against themselves.
 */
export const TREND_STATS = [
  'pts',
  'reb',
  'ast',
  'stl',
  'blk',
  'fg3m',
  'tov',
  'minutes',
] as const;

export type TrendStat = (typeof TREND_STATS)[number];

export const POOL_KEY = 'rotation';
export const POOL_LABEL = 'Rotation players';
export const POOL_MIN_GAMES = 15;
export const POOL_MIN_MINUTES = 12;

/**
 * Deliberately softer than `benchmarks.ts`'s 30 games / 20 minutes. That pool
 * feeds AI prompts in the back half of a season; this one has to produce a
 * usable comparison set in November, when nobody has 30 games yet.
 */
export const POOL_DEFINITION = 'GP >= 15 and MPG >= 12 this season';

/** Equal-width buckets per distribution — enough shape to read, few enough to render. */
export const BUCKET_COUNT = 20;

/** How many recent games the trends view returns. */
export const TREND_GAME_COUNT = 20;

/**
 * Below this many logged games a player's own game-to-game stddev is too noisy
 * to divide by, so the hot/cold z-score is reported as null instead of a number
 * nobody should act on.
 */
export const MIN_GAMES_FOR_Z = 15;

const TTL_MS = 60 * 60 * 1000; // 1 hour, matching benchmarks.ts

export type StatValues = Record<AnalyticsStat, number>;
export type TrendValues = Record<TrendStat, number>;

export interface AnalyticsPool {
  key: string;
  label: string;
  definition: string;
  sample_size: number;
}

export interface StatPercentile {
  stat: AnalyticsStat;
  value: number;
  percentile: number;
}

export interface DistributionBucket {
  lo: number;
  hi: number;
  count: number;
}

export interface StatDistribution {
  stat: AnalyticsStat;
  mean: number;
  stddev: number;
  buckets: DistributionBucket[];
  player_value: number;
}

export interface Last10Comparison {
  stat: TrendStat;
  last10: number;
  season: number;
  delta: number;
  z: number | null;
}

export interface TrendGame extends TrendValues {
  game_date: string | null;
  opponent_team_abbr: string | null;
  is_home: boolean | null;
  fga: number;
  fg3a: number;
  fgm: number;
  ftm: number;
  fta: number;
}

/**
 * One aligned point per returned game: `<stat>_r5` and `<stat>_r10` trailing
 * means for every trend stat (minutes shortens to `min_`). Null while the
 * window isn't full yet.
 */
export interface RollingPoint {
  game_date: string | null;
  [rollingKey: string]: number | string | null;
}

export interface PlayerAnalytics {
  player: {
    id: number;
    nba_id: string | null;
    name: string;
    team: string | null;
    position: string | null;
    headshot_url: string | null;
    injury_status: string | null;
    injury_detail: string | null;
  };
  as_of: { logs: string | null; distributions: string };
  pool: AnalyticsPool;
  percentiles: StatPercentile[];
  distributions: StatDistribution[];
  trends: {
    games: TrendGame[];
    rolling: RollingPoint[];
    last10_vs_season: Last10Comparison[];
  };
  prediction: null;
}

export interface LeagueDistribution {
  stat: AnalyticsStat;
  pool: AnalyticsPool;
  mean: number;
  stddev: number;
  buckets: DistributionBucket[];
  players: Array<{ id: number; name: string; value: number; percentile: number }>;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Arithmetic mean. An empty sample has no mean, so it reports 0. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Population standard deviation, matching `zScoreRank`'s convention. */
export function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) ** 2;
  return Math.sqrt(sum / values.length);
}

/**
 * Empirical percent-rank of `value` within `values`, 0-100. Ties split the
 * difference (everything strictly below counts fully, equal values count half),
 * so a pool of identical values leaves everyone at the neutral 50 rather than
 * all at 0 or all at 100. No normality assumption — this is the raw position in
 * the sample, which is what a "top 12% of rotation players" claim should mean.
 *
 * `reversed` flips the scale for stats where less is better. An empty pool
 * carries no information at all, so it also reports 50.
 */
export function percentRank(values: number[], value: number, reversed = false): number {
  if (values.length === 0) return 50;

  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }

  const pct = ((below + equal / 2) / values.length) * 100;
  return round(reversed ? 100 - pct : pct, 1);
}

/**
 * Equal-width histogram over [min, max]. A sample where every value is
 * identical has no width to divide, so it collapses to a single bucket instead
 * of 20 degenerate zero-width ones.
 */
export function buildBuckets(values: number[], bucketCount: number = BUCKET_COUNT): DistributionBucket[] {
  if (values.length === 0 || bucketCount < 1) return [];

  let lo = values[0];
  let hi = values[0];
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi === lo) return [{ lo: round(lo, 3), hi: round(hi, 3), count: values.length }];

  const width = (hi - lo) / bucketCount;
  const counts = new Array<number>(bucketCount).fill(0);
  for (const v of values) {
    // the top value lands exactly on the upper edge; clamp it into the last bucket
    const index = Math.min(bucketCount - 1, Math.floor((v - lo) / width));
    counts[index] += 1;
  }

  return counts.map((count, i) => ({
    lo: round(lo + i * width, 3),
    hi: round(lo + (i + 1) * width, 3),
    count,
  }));
}

/**
 * Trailing mean over `window` values, aligned index-for-index with the input.
 * Positions without a full window are null rather than a short-window average,
 * so a 10-game line never starts on 3 games of data.
 */
export function rollingMean(values: number[], window: number): Array<number | null> {
  if (window < 1) return values.map(() => null);

  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(i + 1 < window ? null : round(sum / window, 2));
  }
  return out;
}

/**
 * Attempt-weighted excess makes per game: how many more (or fewer) shots a
 * player converts than a pool-average shooter would on the same volume.
 *
 * A raw FG% percentile rewards a center who takes three dunks a game over a
 * high-volume guard shooting the same rate on 20 attempts; this doesn't.
 */
export function attemptWeightedImpact(
  made: number,
  attempted: number,
  poolPct: number,
  games: number
): number {
  if (games <= 0) return 0;
  return round((made - attempted * poolPct) / games, 3);
}

/**
 * Recent form against the player's own season baseline. `z` divides the delta
 * by the player's own game-to-game stddev, so "up 4 points" reads differently
 * for a metronome than for a player who swings 20 points a night. It is null
 * below `minGamesForZ` games, and null when the player's stddev is 0 (nothing
 * to normalize by).
 */
export function last10VsSeason(
  games: TrendValues[],
  minGamesForZ: number = MIN_GAMES_FOR_Z
): Last10Comparison[] {
  if (games.length === 0) return [];

  const recent = games.slice(-10);

  return TREND_STATS.map((stat) => {
    const all = games.map((g) => g[stat]);
    const last10 = mean(recent.map((g) => g[stat]));
    const season = mean(all);
    const sd = stddev(all);
    const delta = last10 - season;
    const z = games.length < minGamesForZ || sd === 0 ? null : round(delta / sd, 2);

    return {
      stat,
      last10: round(last10, 2),
      season: round(season, 2),
      delta: round(delta, 2),
      z,
    };
  });
}

export interface PoolPlayer {
  id: number;
  name: string;
  values: StatValues;
}

export interface PoolSnapshot {
  fetchedAt: number;
  players: PoolPlayer[];
  /** pool-wide FG% / FT% as fractions, used as the impact baseline. */
  fgPct: number;
  ftPct: number;
  teamAbbrById: Map<string, string>;
}

/** Pool descriptor echoed verbatim in every response so the UI never hardcodes it. */
export function poolDescriptor(sampleSize: number): AnalyticsPool {
  return {
    key: POOL_KEY,
    label: POOL_LABEL,
    definition: POOL_DEFINITION,
    sample_size: sampleSize,
  };
}

function poolValues(snapshot: PoolSnapshot, stat: AnalyticsStat): number[] {
  return snapshot.players.map((p) => p.values[stat]);
}

/** Each stat's percentile for one player against the pool. */
export function buildPercentiles(snapshot: PoolSnapshot, values: StatValues): StatPercentile[] {
  return ANALYTICS_STATS.map((stat) => ({
    stat,
    value: round(values[stat], 3),
    percentile: percentRank(poolValues(snapshot, stat), values[stat], REVERSED_STATS.has(stat)),
  }));
}

/** Each stat's pool-wide shape, with the player's own value marked on it. */
export function buildDistributions(snapshot: PoolSnapshot, values: StatValues): StatDistribution[] {
  return ANALYTICS_STATS.map((stat) => {
    const pool = poolValues(snapshot, stat);
    return {
      stat,
      mean: round(mean(pool), 3),
      stddev: round(stddev(pool), 3),
      buckets: buildBuckets(pool),
      player_value: round(values[stat], 3),
    };
  });
}

/**
 * Whitelisted stat key. An unknown stat is rejected rather than defaulted —
 * silently charting points for someone who asked for blocks is a wrong answer,
 * not a clamped one.
 */
export function parseAnalyticsStat(raw: unknown): AnalyticsStat | null {
  if (typeof raw === 'string' && (ANALYTICS_STATS as readonly string[]).includes(raw)) {
    return raw as AnalyticsStat;
  }
  return null;
}

/** Whitelisted pool key. Only the rotation pool exists today; absent means rotation. */
export function isValidPoolKey(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '' || raw === POOL_KEY;
}

/** Positive integer players.id, or null when the path segment isn't one. */
export function parsePlayerId(raw: unknown): number | null {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return parsed;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * `YYYY-MM-DD` for a pg DATE. Read off the local calendar fields rather than
 * `toISOString()`, which shifts a local-midnight date onto the previous day for
 * any timezone east of UTC.
 */
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

let cache: PoolSnapshot | null = null;

/** Drops the cached pool so the next request rebuilds it. Used by tests. */
export function clearAnalyticsCache(): void {
  cache = null;
}

// the logs table spans seasons; everything here is "this season", which is
// whichever season the scraper has most recently written. season labels sort
// lexicographically ("2025-26" > "2024-25"), so MAX is the current one.
const CURRENT_SEASON = '(SELECT MAX(season) FROM player_game_logs)';

/**
 * Pool membership, its season averages, and the game-log totals behind the
 * FG/FT impact measures. Three aggregate queries over the whole pool, so it is
 * cached for an hour — the scraper only writes every six.
 */
export async function getPoolSnapshot(): Promise<PoolSnapshot> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;

  const [seasonResult, totalsResult, teamsResult] = await Promise.all([
    query(
      `SELECT id,
              nba_id,
              name,
              points_per_game::float     AS pts,
              rebounds_per_game::float   AS reb,
              assists_per_game::float    AS ast,
              steals_per_game::float     AS stl,
              blocks_per_game::float     AS blk,
              three_pointers_made::float AS fg3m,
              turnovers_per_game::float  AS tov,
              minutes_per_game::float    AS minutes
       FROM players
       WHERE games_played >= $1
         AND minutes_per_game >= $2
       ORDER BY id`,
      [POOL_MIN_GAMES, POOL_MIN_MINUTES]
    ),
    query(
      `SELECT g.nba_player_id,
              SUM(g.fgm)::float AS fgm,
              SUM(g.fga)::float AS fga,
              SUM(g.ftm)::float AS ftm,
              SUM(g.fta)::float AS fta,
              COUNT(*)::int     AS games
       FROM player_game_logs g
       JOIN players p ON p.nba_id = g.nba_player_id
       WHERE p.games_played >= $1
         AND p.minutes_per_game >= $2
         AND g.season = ${CURRENT_SEASON}
         AND g.season_type = 'Regular Season'
       GROUP BY g.nba_player_id`,
      [POOL_MIN_GAMES, POOL_MIN_MINUTES]
    ),
    query(
      `SELECT DISTINCT team_id, team_abbr
       FROM player_game_logs
       WHERE team_abbr IS NOT NULL`
    ),
  ]);

  interface Totals {
    fgm: number;
    fga: number;
    ftm: number;
    fta: number;
    games: number;
  }

  const totalsByNbaId = new Map<string, Totals>();
  let poolFgm = 0;
  let poolFga = 0;
  let poolFtm = 0;
  let poolFta = 0;

  for (const row of totalsResult.rows) {
    const totals: Totals = {
      fgm: num(row.fgm),
      fga: num(row.fga),
      ftm: num(row.ftm),
      fta: num(row.fta),
      games: num(row.games),
    };
    totalsByNbaId.set(String(row.nba_player_id), totals);
    poolFgm += totals.fgm;
    poolFga += totals.fga;
    poolFtm += totals.ftm;
    poolFta += totals.fta;
  }

  // no attempts anywhere means no logs yet; a 0 baseline makes every impact 0,
  // which is the honest "we can't tell" answer rather than a fabricated edge.
  const fgPct = poolFga > 0 ? poolFgm / poolFga : 0;
  const ftPct = poolFta > 0 ? poolFtm / poolFta : 0;

  const players: PoolPlayer[] = seasonResult.rows.map((row) => {
    const totals = totalsByNbaId.get(String(row.nba_id));
    return {
      id: num(row.id),
      name: String(row.name ?? ''),
      values: {
        pts: num(row.pts),
        reb: num(row.reb),
        ast: num(row.ast),
        stl: num(row.stl),
        blk: num(row.blk),
        fg3m: num(row.fg3m),
        tov: num(row.tov),
        minutes: num(row.minutes),
        fg_impact: totals
          ? attemptWeightedImpact(totals.fgm, totals.fga, fgPct, totals.games)
          : 0,
        ft_impact: totals
          ? attemptWeightedImpact(totals.ftm, totals.fta, ftPct, totals.games)
          : 0,
      },
    };
  });

  const teamAbbrById = new Map<string, string>();
  for (const row of teamsResult.rows) {
    teamAbbrById.set(String(row.team_id), String(row.team_abbr));
  }

  cache = { fetchedAt: Date.now(), players, fgPct, ftPct, teamAbbrById };
  return cache;
}

interface GameLogRow extends TrendValues {
  game_date: string | null;
  opponent_team_id: string | null;
  is_home: boolean | null;
  fgm: number;
  fga: number;
  fg3a: number;
  ftm: number;
  fta: number;
}

async function fetchPlayerLogs(nbaPlayerId: string | null): Promise<GameLogRow[]> {
  const result = await query(
    `SELECT game_date,
            opponent_team_id,
            is_home,
            minutes::float AS minutes,
            pts, reb, ast, stl, blk, tov,
            fgm, fga, fg3m, fg3a, ftm, fta
     FROM player_game_logs
     WHERE nba_player_id = $1
       AND season = ${CURRENT_SEASON}
       AND season_type = 'Regular Season'
     ORDER BY game_date ASC`,
    [nbaPlayerId]
  );

  return result.rows.map((row) => ({
    game_date: toIsoDay(row.game_date),
    opponent_team_id: row.opponent_team_id === null || row.opponent_team_id === undefined
      ? null
      : String(row.opponent_team_id),
    is_home: typeof row.is_home === 'boolean' ? row.is_home : null,
    minutes: num(row.minutes),
    pts: num(row.pts),
    reb: num(row.reb),
    ast: num(row.ast),
    stl: num(row.stl),
    blk: num(row.blk),
    tov: num(row.tov),
    fg3m: num(row.fg3m),
    fgm: num(row.fgm),
    fga: num(row.fga),
    fg3a: num(row.fg3a),
    ftm: num(row.ftm),
    fta: num(row.fta),
  }));
}

/**
 * Everything the player analytics view needs. Null when no such player exists.
 *
 * A player with no game logs still gets percentiles and distributions — those
 * come from the season-average table — and simply has empty trends.
 */
export async function getPlayerAnalytics(playerId: number): Promise<PlayerAnalytics | null> {
  const playerResult = await query(
    `SELECT id, nba_id, name, team, position, headshot_url,
            injury_status, injury_detail,
            points_per_game::float     AS pts,
            rebounds_per_game::float   AS reb,
            assists_per_game::float    AS ast,
            steals_per_game::float     AS stl,
            blocks_per_game::float     AS blk,
            three_pointers_made::float AS fg3m,
            turnovers_per_game::float  AS tov,
            minutes_per_game::float    AS minutes
     FROM players
     WHERE id = $1`,
    [playerId]
  );

  const row = playerResult.rows[0];
  if (!row) return null;

  const nbaId = row.nba_id === null || row.nba_id === undefined ? null : String(row.nba_id);
  const snapshot = await getPoolSnapshot();
  const logs = await fetchPlayerLogs(nbaId);

  // the player's own impacts come from their own logs rather than the pool
  // snapshot, so a player outside the pool still gets a real number.
  let fgm = 0;
  let fga = 0;
  let ftm = 0;
  let fta = 0;
  for (const log of logs) {
    fgm += log.fgm;
    fga += log.fga;
    ftm += log.ftm;
    fta += log.fta;
  }

  const values: StatValues = {
    pts: num(row.pts),
    reb: num(row.reb),
    ast: num(row.ast),
    stl: num(row.stl),
    blk: num(row.blk),
    fg3m: num(row.fg3m),
    tov: num(row.tov),
    minutes: num(row.minutes),
    fg_impact: attemptWeightedImpact(fgm, fga, snapshot.fgPct, logs.length),
    ft_impact: attemptWeightedImpact(ftm, fta, snapshot.ftPct, logs.length),
  };

  // rolling averages are computed across the whole season and then sliced to the
  // same window as `games`, so the two arrays line up index-for-index and the
  // 10-game line is already correct at the left edge of the chart. every trend
  // stat gets a 5- and 10-game series so the chart's stat picker can switch
  // between categories without a refetch.
  const rollingAll: Record<string, Array<number | null>> = {};
  for (const stat of TREND_STATS) {
    const series = logs.map((g) => g[stat]);
    const key = stat === 'minutes' ? 'min' : stat;
    rollingAll[`${key}_r5`] = rollingMean(series, 5);
    rollingAll[`${key}_r10`] = rollingMean(series, 10);
  }

  const windowStart = Math.max(0, logs.length - TREND_GAME_COUNT);
  const recent = logs.slice(windowStart);

  const games: TrendGame[] = recent.map((g) => ({
    game_date: g.game_date,
    opponent_team_abbr: g.opponent_team_id
      ? snapshot.teamAbbrById.get(g.opponent_team_id) ?? null
      : null,
    is_home: g.is_home,
    minutes: g.minutes,
    pts: g.pts,
    reb: g.reb,
    ast: g.ast,
    stl: g.stl,
    blk: g.blk,
    tov: g.tov,
    fgm: g.fgm,
    fga: g.fga,
    fg3m: g.fg3m,
    fg3a: g.fg3a,
    ftm: g.ftm,
    fta: g.fta,
  }));

  const rolling: RollingPoint[] = recent.map((g, i) => {
    const point: RollingPoint = { game_date: g.game_date };
    for (const [key, series] of Object.entries(rollingAll)) {
      point[key] = series[windowStart + i];
    }
    return point;
  });

  const lastLoggedDay = logs.length > 0 ? logs[logs.length - 1].game_date : null;

  return {
    player: {
      id: num(row.id),
      nba_id: nbaId,
      name: String(row.name ?? ''),
      team: row.team === null || row.team === undefined ? null : String(row.team),
      position: row.position === null || row.position === undefined ? null : String(row.position),
      headshot_url:
        row.headshot_url === null || row.headshot_url === undefined
          ? null
          : String(row.headshot_url),
      injury_status:
        row.injury_status === null || row.injury_status === undefined
          ? null
          : String(row.injury_status),
      injury_detail:
        row.injury_detail === null || row.injury_detail === undefined
          ? null
          : String(row.injury_detail),
    },
    as_of: {
      logs: lastLoggedDay ? `${lastLoggedDay}T00:00:00.000Z` : null,
      distributions: new Date(snapshot.fetchedAt).toISOString(),
    },
    pool: poolDescriptor(snapshot.players.length),
    percentiles: buildPercentiles(snapshot, values),
    distributions: buildDistributions(snapshot, values),
    trends: {
      games,
      rolling,
      last10_vs_season: last10VsSeason(logs),
    },
    prediction: null,
  };
}

/** League-wide shape of one stat, plus every pool player's value and percentile. */
export async function getStatDistribution(stat: AnalyticsStat): Promise<LeagueDistribution> {
  const snapshot = await getPoolSnapshot();
  const values = poolValues(snapshot, stat);
  const reversed = REVERSED_STATS.has(stat);

  const players = snapshot.players
    .map((p) => ({
      id: p.id,
      name: p.name,
      value: round(p.values[stat], 3),
      percentile: percentRank(values, p.values[stat], reversed),
    }))
    // best first regardless of direction, so the reversed turnover scale reads
    // the same way as every other stat.
    .sort((a, b) => b.percentile - a.percentile || a.name.localeCompare(b.name));

  return {
    stat,
    pool: poolDescriptor(snapshot.players.length),
    mean: round(mean(values), 3),
    stddev: round(stddev(values), 3),
    buckets: buildBuckets(values),
    players,
  };
}
