/**
 * Display helpers for the per-player prediction surface. Pure functions only.
 *
 * The one policy decision encoded here: AN INJURED PLAYER'S PROJECTIONS ARE
 * NEVER BLANKED OUT. `prob_active` already carries the absence — a 4%-to-play
 * player is shown with a red badge and his full "if he plays" line intact,
 * because "what would he give me if he suits up" is exactly the question a
 * manager is asking about a doubtful player. Nulling the numbers would answer
 * a question nobody asked and look identical to a model that has nothing.
 */

import type { NumericLike, PredictionStatLine } from '../types';
import { toStatNumber, STAT_PLACEHOLDER } from './stats';

export type AvailabilityTier = 'out' | 'doubtful' | 'questionable' | 'likely' | 'unknown';

export interface AvailabilityBadge {
  tier: AvailabilityTier;
  label: string;
  /** daisyUI badge classes — semantic, so every theme reads the same. */
  className: string;
  /** "91%", or null when the run did not model availability for this game. */
  percentText: string | null;
  /** Tooltip copy. Always says the number is a model estimate. */
  hint: string;
}

/**
 * The badge for one game's `prob_active`.
 *
 * The thresholds intentionally borrow the vocabulary of an injury report
 * without borrowing its authority: an official designation is published by a
 * team, and this is a model reading a schedule. The labels are hedged
 * ("OUT-ish") and every tooltip says so, because a page that looks like an
 * injury report will be read as one.
 */
export function availabilityBadge(prob: NumericLike | null | undefined): AvailabilityBadge {
  const value = toStatNumber(prob);
  if (value === null) {
    return {
      tier: 'unknown',
      label: 'No estimate',
      className: 'badge-ghost',
      percentText: null,
      hint: 'No availability estimate for this game.',
    };
  }

  const clamped = Math.min(Math.max(value, 0), 1);
  const percentText = `${Math.round(clamped * 100)}%`;
  const hint = `Model estimate: ${percentText} chance he plays. Not an official injury designation.`;

  if (clamped < 0.15) {
    return { tier: 'out', label: 'OUT-ish', className: 'badge-error', percentText, hint };
  }
  if (clamped < 0.5) {
    return { tier: 'doubtful', label: 'Doubtful', className: 'badge-warning', percentText, hint };
  }
  if (clamped <= 0.75) {
    return {
      tier: 'questionable',
      label: 'Questionable',
      className: 'badge-warning badge-outline',
      percentText,
      hint,
    };
  }
  return { tier: 'likely', label: 'Likely', className: 'badge-success', percentText, hint };
}

export interface StatCellDisplay {
  /** The headline number: the median when there is one, else the mean. */
  primary: string;
  /** Which of the two `primary` came from — the tooltip has to be honest. */
  primarySource: 'p50' | 'expected' | 'none';
  /** "26.0-41.0", or null when the run has no complete band for this stat. */
  band: string | null;
  /** The schedule-level number, shown secondary. Null when the run omits it. */
  unconditional: string | null;
  /** Tooltip copy spelling out conditional vs unconditional. */
  hint: string;
}

/**
 * One stat cell. The median leads because it is the number a start/sit call
 * turns on; the mean is the fallback for a run that stores no quantiles at all
 * (the store's `_uncond`/quantile emission is per-stat, so half-populated stats
 * are the normal case rather than an error).
 */
export function statCellDisplay(
  label: string,
  line: PredictionStatLine | undefined
): StatCellDisplay {
  const p50 = toStatNumber(line?.p50 ?? null);
  const p10 = toStatNumber(line?.p10 ?? null);
  const p90 = toStatNumber(line?.p90 ?? null);
  const expected = toStatNumber(line?.expected ?? null);
  const uncond = toStatNumber(line?.unconditional ?? null);

  const headline = p50 ?? expected;
  const primarySource = p50 !== null ? 'p50' : expected !== null ? 'expected' : 'none';
  const band = p10 !== null && p90 !== null ? `${p10.toFixed(1)}-${p90.toFixed(1)}` : null;

  const parts: string[] = [];
  if (headline !== null) {
    parts.push(`${label} if he plays: ${headline.toFixed(1)}`);
  }
  if (band) parts.push(`Likely range ${band}`);
  if (uncond !== null) {
    parts.push(`Counting the chance he sits: ${uncond.toFixed(1)}`);
  }

  return {
    primary: headline === null ? STAT_PLACEHOLDER : headline.toFixed(1),
    primarySource,
    band,
    unconditional: uncond === null ? null : uncond.toFixed(1),
    hint: parts.length > 0 ? parts.join('. ') + '.' : `No ${label} in this run.`,
  };
}

export interface PredictionDateParts {
  /** "Jan 15" */
  label: string;
  /** "Thu", or null when the string is not a calendar day. */
  weekday: string | null;
}

/**
 * A game date for the table.
 *
 * Not `analytics.formatGameDate` because the table also needs the weekday,
 * returned separately so it can be styled apart from the date. Both split the
 * `YYYY-MM-DD` string and build a local date: `new Date()` would parse a bare
 * calendar day as UTC midnight, rendering one day early west of Greenwich.
 */
export function formatPredictionDate(iso: string): PredictionDateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return { label: iso, weekday: null };
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return { label: iso, weekday: null };
  return {
    label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    weekday: date.toLocaleDateString('en-US', { weekday: 'short' }),
  };
}

/** "vs CHA" / "@ POR" / a placeholder when the schedule row could not be matched. */
export function opponentLabel(opponent: string | null, isHome: boolean | null): string {
  if (!opponent || isHome === null) return STAT_PLACEHOLDER;
  return `${isHome ? 'vs' : '@'} ${opponent}`;
}
