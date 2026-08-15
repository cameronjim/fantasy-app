import { describe, it, expect } from 'vitest';
import {
  availabilityBadge,
  formatPredictionDate,
  opponentLabel,
  statCellDisplay,
} from '../../src/utils/predictions';

describe('availabilityBadge', () => {
  it('maps each probability band to its tier, including the boundaries', () => {
    expect(availabilityBadge(0).tier).toBe('out');
    expect(availabilityBadge(0.149).tier).toBe('out');
    expect(availabilityBadge(0.15).tier).toBe('doubtful');
    expect(availabilityBadge(0.499).tier).toBe('doubtful');
    expect(availabilityBadge(0.5).tier).toBe('questionable');
    expect(availabilityBadge(0.75).tier).toBe('questionable');
    expect(availabilityBadge(0.751).tier).toBe('likely');
    expect(availabilityBadge(1).tier).toBe('likely');
  });

  it('uses semantic daisyUI colors so every theme reads the same', () => {
    expect(availabilityBadge(0.04).className).toContain('badge-error');
    expect(availabilityBadge(0.3).className).toContain('badge-warning');
    expect(availabilityBadge(0.6).className).toContain('badge-outline');
    expect(availabilityBadge(0.9).className).toContain('badge-success');
  });

  it('always says the number is a model estimate rather than a designation', () => {
    const badge = availabilityBadge(0.82);

    expect(badge.percentText).toBe('82%');
    expect(badge.hint).toMatch(/model estimate/i);
    expect(badge.hint).toMatch(/not an official injury designation/i);
  });

  it('degrades to an explicit "no estimate" rather than to a number', () => {
    const badge = availabilityBadge(null);

    expect(badge.tier).toBe('unknown');
    expect(badge.label).toBe('No estimate');
    expect(badge.percentText).toBeNull();
  });

  it('accepts the string form a pg NUMERIC arrives as, and clamps out-of-range', () => {
    expect(availabilityBadge('0.91').tier).toBe('likely');
    expect(availabilityBadge(1.4).percentText).toBe('100%');
    expect(availabilityBadge(-0.2).percentText).toBe('0%');
  });
});

describe('statCellDisplay', () => {
  it('leads with the median and carries the band and schedule-level twin', () => {
    const cell = statCellDisplay('MIN', {
      expected: 36.33,
      p10: 28.48,
      p50: 36.17,
      p90: 43.5,
      unconditional: 33.23,
    });

    expect(cell.primary).toBe('36.2');
    expect(cell.primarySource).toBe('p50');
    expect(cell.band).toBe('28.5-43.5');
    expect(cell.unconditional).toBe('33.2');
    expect(cell.hint).toMatch(/if he plays/i);
    expect(cell.hint).toMatch(/chance he sits/i);
  });

  it('falls back to the expected value when the run stores no quantiles', () => {
    const cell = statCellDisplay('AST', {
      expected: 9.1,
      p10: null,
      p50: null,
      p90: null,
      unconditional: 8.33,
    });

    expect(cell.primary).toBe('9.1');
    expect(cell.primarySource).toBe('expected');
    expect(cell.band).toBeNull();
    expect(cell.hint).toMatch(/AST if he plays: 9\.1/);
  });

  it('drops a half-populated band rather than rendering a one-sided interval', () => {
    const cell = statCellDisplay('PTS', {
      expected: null,
      p10: 14,
      p50: 24.5,
      p90: null,
      unconditional: null,
    });

    expect(cell.primary).toBe('24.5');
    expect(cell.band).toBeNull();
  });

  it('renders a placeholder for a stat the run has nothing for', () => {
    const missing = statCellDisplay('BLK', undefined);

    expect(missing.primary).toBe('-');
    expect(missing.primarySource).toBe('none');
    expect(missing.hint).toMatch(/No BLK in this run/);
  });
});

describe('formatPredictionDate', () => {
  it('reads a calendar day on the local calendar, not as UTC midnight', () => {
    // parsing an iso date string with new Date() lands a day early west of greenwich.
    const parts = formatPredictionDate('2026-01-15');

    expect(parts.label).toBe('Jan 15');
    expect(parts.weekday).toBe('Thu');
  });

  it('passes an unparseable string through untouched', () => {
    expect(formatPredictionDate('later')).toEqual({ label: 'later', weekday: null });
  });
});

describe('opponentLabel', () => {
  it('distinguishes home from away', () => {
    expect(opponentLabel('CHA', true)).toBe('vs CHA');
    expect(opponentLabel('POR', false)).toBe('@ POR');
  });

  it('placeholders rather than guessing when the side is unknown', () => {
    expect(opponentLabel('CHA', null)).toBe('-');
    expect(opponentLabel(null, true)).toBe('-');
  });
});
