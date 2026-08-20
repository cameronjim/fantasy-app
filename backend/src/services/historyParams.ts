
const SEASON_PATTERN = /^\d{4}-\d{2}$/;

export {
  DEFAULT_PLAYER_LIMIT,
  MAX_PLAYER_LIMIT,
  clampLimit,
  clampOffset,
  searchPattern,
} from './queryParams.js';

// a season is loaded and filtered in memory in one request, and modern seasons can exceed 500 players
export const MAX_SEASON_PLAYERS_LIMIT = 1000;

export function isValidSeason(season: unknown): season is string {
  return typeof season === 'string' && SEASON_PATTERN.test(season);
}
