import { describe, it, expect } from 'vitest';
import { compareStats, formatStat, formatText, toStatNumber } from '../../src/utils/stats';

describe('toStatNumber', () => {
  it('parses the strings pg returns for NUMERIC columns', () => {
    // act + assert
    expect(toStatNumber('27.30')).toBe(27.3);
    expect(toStatNumber(27.3)).toBe(27.3);
  });

  it('returns null for missing or unparseable values, but keeps a real zero', () => {
    // act + assert
    expect(toStatNumber(null)).toBeNull();
    expect(toStatNumber(undefined)).toBeNull();
    expect(toStatNumber('')).toBeNull();
    expect(toStatNumber('n/a')).toBeNull();
    expect(toStatNumber('0.0')).toBe(0);
  });
});

describe('formatStat', () => {
  it('formats string and number inputs to fixed decimals', () => {
    // act + assert
    expect(formatStat('27.349')).toBe('27.3');
    expect(formatStat('82', 0)).toBe('82');
    expect(formatStat(0)).toBe('0.0');
  });

  it('renders a dash instead of NaN or null for missing stats', () => {
    // act + assert
    expect(formatStat(null)).toBe('-');
    expect(formatStat(undefined)).toBe('-');
    expect(formatStat('')).toBe('-');
  });
});

describe('formatText', () => {
  it('falls back to a dash for blank values', () => {
    // act + assert
    expect(formatText('LAL')).toBe('LAL');
    expect(formatText(null)).toBe('-');
    expect(formatText('')).toBe('-');
  });
});

describe('compareStats', () => {
  it('compares string numerics numerically, not lexically', () => {
    // act + assert — '9' > '10' as strings, but not as numbers
    expect(compareStats('9', '10', 'asc')).toBeLessThan(0);
    expect(compareStats('9', '10', 'desc')).toBeGreaterThan(0);
  });

  it('sorts missing values last in both directions', () => {
    // act + assert
    expect(compareStats(null, '5', 'asc')).toBeGreaterThan(0);
    expect(compareStats(null, '5', 'desc')).toBeGreaterThan(0);
    expect(compareStats('5', null, 'desc')).toBeLessThan(0);
    expect(compareStats(null, null, 'asc')).toBe(0);
  });
});
