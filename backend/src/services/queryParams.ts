// pure query-parameter parsing shared by the public listing routes. kept out of
// the route files so the clamping rules can be unit tested without http.

export const DEFAULT_PLAYER_LIMIT = 100;
export const MAX_PLAYER_LIMIT = 500;

/**
 * Page size for a listing, clamped to 1..max (default MAX_PLAYER_LIMIT).
 * Anything unparseable falls back to the default rather than 400ing — the
 * ceiling is the part that matters, since it bounds the payload.
 *
 * `max` is overridable because a fixed 500 is not right for every listing: the
 * 2K classic roster is 767 cards, and capping it at 500 silently hides the
 * bottom third from a client that pages once and filters in memory.
 */
export function clampLimit(raw: unknown, max: number = MAX_PLAYER_LIMIT): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return Math.min(DEFAULT_PLAYER_LIMIT, max);
  if (parsed < 1) return 1;
  return Math.min(parsed, max);
}

/** Row offset for a listing. Negative and unparseable values become 0. */
export function clampOffset(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * `%term%` pattern for a case-insensitive ILIKE name filter, or null when the
 * caller supplied nothing usable. The `%` wrappers are added here so the term
 * itself always travels as a bound parameter.
 */
export function searchPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return `%${trimmed}%`;
}
