/**
 * Display helpers for the player analytics payload. Pure functions only —
 * every formatting decision for percentiles, distributions and trends lives
 * here rather than in the chart components.
 */

import type { AnalyticsStat, NumericLike } from '../types';
import { toStatNumber } from './stats';

/** Short column/axis label for each analytics stat key. */
const STAT_LABELS: Record<AnalyticsStat, string> = {
  pts: 'PTS',
  reb: 'REB',
  ast: 'AST',
  stl: 'STL',
  blk: 'BLK',
  fg3m: '3PM',
  tov: 'TOV',
  fg_impact: 'FG Impact',
  ft_impact: 'FT Impact',
  minutes: 'MIN',
};

/** Extra explanation surfaced as a tooltip next to the label. */
const STAT_HINTS: Partial<Record<AnalyticsStat, string>> = {
  fg_impact:
    'Attempt-weighted excess makes: field goals made above what an average shooter would make on the same volume, so efficiency on real volume outranks a perfect 1-for-1.',
  ft_impact:
    'Attempt-weighted excess makes: free throws made above what an average shooter would make on the same volume, so efficiency on real volume outranks a perfect 1-for-1.',
  tov: 'Percentile is inverted for turnovers — a higher percentile means fewer giveaways.',
};

export function statLabel(stat: string): string {
  return STAT_LABELS[stat as AnalyticsStat] ?? stat.replace(/_/g, ' ').toUpperCase();
}

export function statHint(stat: string): string | null {
  return STAT_HINTS[stat as AnalyticsStat] ?? null;
}

/**
 * Charts need real numbers, and Postgres NUMERIC (plus bigint COUNT) columns
 * can arrive as strings. Missing values collapse to 0 so a gap never breaks
 * an axis scale.
 */
export function chartNumber(value: NumericLike | null | undefined): number {
  return toStatNumber(value) ?? 0;
}

/** 0-100 clamped, for progress bars that must never overflow their track. */
export function clampPercentile(value: NumericLike | null | undefined): number {
  const parsed = toStatNumber(value) ?? 0;
  return Math.min(100, Math.max(0, parsed));
}

/** "72nd", "1st", "13th" — reads better than "72%" for a percentile rank. */
export function ordinal(value: number): string {
  const n = Math.round(value);
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * daisyUI semantic color for a percentile tier. Semantic classes keep the
 * scale readable on all seven themes without hardcoding a palette.
 */
export function percentileTier(percentile: number): 'success' | 'primary' | 'warning' | 'error' {
  if (percentile >= 75) return 'success';
  if (percentile >= 50) return 'primary';
  if (percentile >= 25) return 'warning';
  return 'error';
}

/** "Feb 4" — the axis and table format for a game date. */
export function formatGameDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Feb 4, 3:20 PM" — the freshness footer format, matching StatusBadge. */
export function formatTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Bucket axis label. Whole-number ranges read as "10-12", fractional as "0.5-1.0". */
export function bucketLabel(lo: NumericLike, hi: NumericLike): string {
  const loNum = chartNumber(lo);
  const hiNum = chartNumber(hi);
  const decimals = Number.isInteger(loNum) && Number.isInteger(hiNum) ? 0 : 1;
  return `${loNum.toFixed(decimals)}-${hiNum.toFixed(decimals)}`;
}

export interface DeltaDisplay {
  /** ▲ / ▼ / — depending on the direction of the change. */
  arrow: string;
  /** signed delta, e.g. "+2.4". */
  text: string;
  /** daisyUI text color class; muted when the move isn't meaningful. */
  className: string;
  /** true when |z| > 1 — a move big enough to call out. */
  notable: boolean;
}

/**
 * Renders a last-10-vs-season delta. Color intensity comes from `z`, not from
 * the raw delta, so a two-point swing on a volatile scorer doesn't shout as
 * loudly as the same swing on a steady one. A null `z` means the sample is too
 * small to standardize, which stays deliberately grey.
 *
 * `lowerIsBetter` flips the coloring for turnovers, where a drop is good.
 */
export function deltaDisplay(
  delta: NumericLike,
  z: NumericLike | null,
  lowerIsBetter: boolean
): DeltaDisplay {
  const deltaNum = toStatNumber(delta) ?? 0;
  const zNum = toStatNumber(z);
  const arrow = deltaNum > 0 ? '▲' : deltaNum < 0 ? '▼' : '—';
  const text = `${deltaNum > 0 ? '+' : ''}${deltaNum.toFixed(1)}`;

  if (zNum === null) return { arrow, text, className: 'opacity-40', notable: false };

  const notable = Math.abs(zNum) > 1;
  const improved = lowerIsBetter ? deltaNum < 0 : deltaNum > 0;
  if (!notable) return { arrow, text, className: 'opacity-60', notable };
  return {
    arrow,
    text,
    className: improved ? 'text-success font-semibold' : 'text-error font-semibold',
    notable,
  };
}
