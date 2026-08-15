import type { NumericLike } from '../types';

export const STAT_PLACEHOLDER = '-';

// postgres NUMERIC arrives as a string, and null is kept distinct from a real zero.
export function toStatNumber(value: NumericLike | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatStat(value: NumericLike | null | undefined, decimals = 1): string {
  const parsed = toStatNumber(value);
  return parsed === null ? STAT_PLACEHOLDER : parsed.toFixed(decimals);
}

export function formatText(value: string | null | undefined): string {
  return value ? value : STAT_PLACEHOLDER;
}

// missing values sort last in both directions.
export function compareStats(
  a: NumericLike | null | undefined,
  b: NumericLike | null | undefined,
  dir: 'asc' | 'desc'
): number {
  const aNum = toStatNumber(a);
  const bNum = toStatNumber(b);
  if (aNum === null && bNum === null) return 0;
  if (aNum === null) return 1;
  if (bNum === null) return -1;
  const diff = aNum - bNum;
  return dir === 'asc' ? diff : -diff;
}
