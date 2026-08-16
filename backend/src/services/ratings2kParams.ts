// pure query-parameter parsing and name normalization for the /api/ratings2k
// routes. kept out of the route file so the rules can be unit tested without http.

/**
 * Canonical attribution for the 2K data. The ratings are Take-Two's and the
 * data is third-party, so every /api/ratings2k response carries this string as
 * `source` and the frontend renders what it is given — the text is not
 * duplicated client-side, so correcting it here corrects it everywhere.
 */
export const RATINGS_2K_ATTRIBUTION =
  '2K ratings via nba2kapi.com (data from 2kratings.com). Not affiliated with ' +
  'or endorsed by 2K Sports, Take-Two, or the NBA.';

/** 2K's three roster types: current NBA, classic teams, all-time teams. */
/**
 * Page-size ceiling for the 2K listing, above the shared 500 default. The
 * largest roster is `class` at ~767 cards, and the UI pages once per roster and
 * filters in memory — a 500 cap would make the lowest-rated third of classic
 * players unreachable by search. 1000 covers every roster with headroom.
 */
export const MAX_RATINGS_2K_LIMIT = 1000;

export const TEAM_TYPES = ['curr', 'class', 'allt'] as const;
export type Team2kType = (typeof TEAM_TYPES)[number];

export const DEFAULT_TEAM_TYPE: Team2kType = 'curr';

/**
 * Result of parsing `teamType`. Unlike limit/offset, an unrecognized value is
 * rejected rather than defaulted: silently serving current players to someone
 * who asked for all-time ones is a wrong answer, not a clamped one.
 * `teamType: null` means "every roster type" (the caller passed `all`).
 */
export type TeamTypeResult =
  | { ok: true; teamType: Team2kType | null }
  | { ok: false };

export function parseTeamType(raw: unknown): TeamTypeResult {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, teamType: DEFAULT_TEAM_TYPE };
  }
  if (raw === 'all') return { ok: true, teamType: null };
  if (typeof raw === 'string' && (TEAM_TYPES as readonly string[]).includes(raw)) {
    return { ok: true, teamType: raw as Team2kType };
  }
  return { ok: false };
}

export const SORTS = ['overall', 'name'] as const;
export type Ratings2kSort = (typeof SORTS)[number];

export const DEFAULT_SORT: Ratings2kSort = 'overall';

/**
 * Whitelisted sort key. Ordering can't be bound as a parameter, so the raw
 * value never reaches SQL — it only selects one of the fixed clauses in
 * ORDER_BY_SQL. An unknown value falls back to the default, since a different
 * row order is not a wrong answer.
 */
export function parseSort(raw: unknown): Ratings2kSort {
  if (typeof raw === 'string' && (SORTS as readonly string[]).includes(raw)) {
    return raw as Ratings2kSort;
  }
  return DEFAULT_SORT;
}

/** Fixed ORDER BY clauses, keyed by the whitelisted sort. No user input here. */
export const ORDER_BY_SQL: Record<Ratings2kSort, string> = {
  overall: 'overall DESC NULLS LAST, name ASC',
  name: 'name ASC, overall DESC NULLS LAST',
};

// suffixes 2K and stats.nba.com disagree about (LeBron James Jr., Gary Payton II).
const NAME_SUFFIX_PATTERN = /\b(jr\.?|sr\.?|iii|ii|iv)\b/g;

/**
 * Accent-, suffix-, and punctuation-stripped name, used to link an app player
 * to their 2K card. 2K publishes no NBA player id, so this is the only join key.
 *
 * Must stay byte-for-byte equivalent to `_normalize_name` in
 * `scraper/run_scraper.py`, which writes `nba_2k_players.normalized_name`: this
 * side normalizes the incoming query, that side normalized the stored value, and
 * the two are compared for equality.
 */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    // drop the combining marks NFKD just split off, so Şengün -> Sengun
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(NAME_SUFFIX_PATTERN, '')
    .replace(/[.']/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
