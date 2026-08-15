import type { NumericLike, PredictionStatLine } from '../types';
import { toStatNumber, STAT_PLACEHOLDER } from './stats';

export type AvailabilityTier = 'out' | 'doubtful' | 'questionable' | 'likely' | 'unknown';

export interface AvailabilityBadge {
  tier: AvailabilityTier;
  label: string;
  className: string;
  percentText: string | null;
  hint: string;
}

// labels are hedged on purpose: this is a model estimate, not an official injury designation.
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
  primary: string;
  primarySource: 'p50' | 'expected' | 'none';
  band: string | null;
  unconditional: string | null;
  hint: string;
}

// quantile emission is per-stat, so a half-populated stat line is normal, not an error.
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
  label: string;
  weekday: string | null;
}

// the parts are split out because `new Date('YYYY-MM-DD')` parses as utc midnight, one day early west of greenwich.
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

export function opponentLabel(opponent: string | null, isHome: boolean | null): string {
  if (!opponent || isHome === null) return STAT_PLACEHOLDER;
  return `${isHome ? 'vs' : '@'} ${opponent}`;
}
