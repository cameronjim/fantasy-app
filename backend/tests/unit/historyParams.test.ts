import { describe, it, expect } from 'vitest';
import {
  clampLimit,
  clampOffset,
  isValidSeason,
  searchPattern,
  DEFAULT_PLAYER_LIMIT,
  MAX_PLAYER_LIMIT,
} from '../../src/services/historyParams.js';

describe('isValidSeason', () => {
  it('accepts the NBA YYYY-YY season label', () => {
    // act + assert
    expect(isValidSeason('1996-97')).toBe(true);
    expect(isValidSeason('1999-00')).toBe(true);
    expect(isValidSeason('2025-26')).toBe(true);
  });

  it('rejects malformed labels and non-strings', () => {
    // act + assert
    expect(isValidSeason('1996')).toBe(false);
    expect(isValidSeason('1996-1997')).toBe(false);
    expect(isValidSeason('96-97')).toBe(false);
    expect(isValidSeason('abcd-ef')).toBe(false);
    expect(isValidSeason('')).toBe(false);
    expect(isValidSeason(undefined)).toBe(false);
    expect(isValidSeason(1996)).toBe(false);
    expect(isValidSeason(['1996-97'])).toBe(false);
  });

  it('rejects a label with sql appended', () => {
    // act + assert — validation is belt-and-braces; the value is also bound
    expect(isValidSeason("1996-97'; DROP TABLE player_season_stats--")).toBe(false);
  });
});

describe('clampLimit', () => {
  it('defaults when nothing usable is supplied', () => {
    // act + assert
    expect(clampLimit(undefined)).toBe(DEFAULT_PLAYER_LIMIT);
    expect(clampLimit('')).toBe(DEFAULT_PLAYER_LIMIT);
    expect(clampLimit('abc')).toBe(DEFAULT_PLAYER_LIMIT);
  });

  it('passes through a value inside the allowed range', () => {
    // act + assert
    expect(clampLimit('25')).toBe(25);
    expect(clampLimit(MAX_PLAYER_LIMIT)).toBe(MAX_PLAYER_LIMIT);
  });

  it('caps anything above the maximum', () => {
    // act + assert
    expect(clampLimit('99999')).toBe(MAX_PLAYER_LIMIT);
    expect(clampLimit(MAX_PLAYER_LIMIT + 1)).toBe(MAX_PLAYER_LIMIT);
  });

  it('floors zero and negatives at one row', () => {
    // act + assert
    expect(clampLimit('0')).toBe(1);
    expect(clampLimit('-40')).toBe(1);
  });
});

describe('clampOffset', () => {
  it('defaults to zero for missing, unparseable, and negative values', () => {
    // act + assert
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset('nope')).toBe(0);
    expect(clampOffset('-10')).toBe(0);
  });

  it('passes through a non-negative offset', () => {
    // act + assert
    expect(clampOffset('200')).toBe(200);
    expect(clampOffset(0)).toBe(0);
  });
});

describe('searchPattern', () => {
  it('wraps a trimmed term in ILIKE wildcards', () => {
    // act + assert
    expect(searchPattern('  Jordan ')).toBe('%Jordan%');
  });

  it('returns null when there is nothing to filter on', () => {
    // act + assert
    expect(searchPattern('')).toBeNull();
    expect(searchPattern('   ')).toBeNull();
    expect(searchPattern(undefined)).toBeNull();
    expect(searchPattern(['a'])).toBeNull();
  });
});
