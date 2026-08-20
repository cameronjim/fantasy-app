
export const RATINGS_2K_ATTRIBUTION =
  '2K ratings via nba2kapi.com (data from 2kratings.com). Not affiliated with ' +
  'or endorsed by 2K Sports, Take-Two, or the NBA.';

export const MAX_RATINGS_2K_LIMIT = 1000;

export const TEAM_TYPES = ['curr', 'class', 'allt'] as const;
export type Team2kType = (typeof TEAM_TYPES)[number];

export const DEFAULT_TEAM_TYPE: Team2kType = 'curr';

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

export function parseSort(raw: unknown): Ratings2kSort {
  if (typeof raw === 'string' && (SORTS as readonly string[]).includes(raw)) {
    return raw as Ratings2kSort;
  }
  return DEFAULT_SORT;
}

export const ORDER_BY_SQL: Record<Ratings2kSort, string> = {
  overall: 'overall DESC NULLS LAST, name ASC',
  name: 'name ASC, overall DESC NULLS LAST',
};

const NAME_SUFFIX_PATTERN = /\b(jr\.?|sr\.?|iii|ii|iv)\b/g;

export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(NAME_SUFFIX_PATTERN, '')
    .replace(/[.']/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
