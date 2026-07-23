/**
 * Coercion and display helpers for stat values that arrive from Postgres
 * NUMERIC columns, which `pg` serializes as strings. Pure functions — no
 * formatting decisions live in the components that render historical rows.
 */

import type { NumericLike } from '../types';

/** what a missing stat renders as, so nulls never surface as "null"/"NaN". */
export const STAT_PLACEHOLDER = '-';

/**
 * Coerces a possibly-string NUMERIC to a number. null, undefined, empty
 * strings, and unparseable values all collapse to null so callers can tell
 * "no data" apart from a real zero.
 */
export function toStatNumber(value: NumericLike | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Fixed-decimal display for a stat, or a dash when there's no value. */
export function formatStat(value: NumericLike | null | undefined, decimals = 1): string {
  const parsed = toStatNumber(value);
  return parsed === null ? STAT_PLACEHOLDER : parsed.toFixed(decimals);
}

/** Non-numeric text display: trims to a dash when blank or missing. */
export function formatText(value: string | null | undefined): string {
  return value ? value : STAT_PLACEHOLDER;
}

/**
 * Comparator for sorting stat columns. Missing values always sort last
 * regardless of direction, so a season with sparse data never crowds out
 * the rows that actually have numbers.
 */
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
