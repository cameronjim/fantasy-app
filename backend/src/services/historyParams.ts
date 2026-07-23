// pure query-parameter parsing for the /api/history routes. kept out of the
// route file so the clamping rules can be unit tested without http.

// NBA season labels are "YYYY-YY" (e.g. "1996-97"). we only check the shape —
// which seasons actually exist is whatever the backfill managed to write.
const SEASON_PATTERN = /^\d{4}-\d{2}$/;

// limit/offset/search clamping is identical for every public listing route, so
// it lives in queryParams and is re-exported here for the history callers.
export {
  DEFAULT_PLAYER_LIMIT,
  MAX_PLAYER_LIMIT,
  clampLimit,
  clampOffset,
  searchPattern,
} from './queryParams.js';

/**
 * Page-size ceiling for a single season's player list, above the shared 500
 * default. A season is one bounded set that the UI loads in one request and
 * filters in memory, and modern seasons exceed 500: two-way contracts and
 * 10-days pushed 2021-22 to 605. Capping at 500 silently dropped the tail, so
 * the lowest-scoring players in a season could not be seen or searched at all.
 */
export const MAX_SEASON_PLAYERS_LIMIT = 1000;

export function isValidSeason(season: unknown): season is string {
  return typeof season === 'string' && SEASON_PATTERN.test(season);
}
