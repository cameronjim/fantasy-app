
export const DEFAULT_PLAYER_LIMIT = 100;
export const MAX_PLAYER_LIMIT = 500;

// max is overridable since a fixed 500 hides the tail of larger listings (e.g. the 767-card 2K classic roster) from a client that pages once
export function clampLimit(raw: unknown, max: number = MAX_PLAYER_LIMIT): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return Math.min(DEFAULT_PLAYER_LIMIT, max);
  if (parsed < 1) return 1;
  return Math.min(parsed, max);
}

export function clampOffset(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function searchPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return `%${trimmed}%`;
}
