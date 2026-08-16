import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SORT,
  DEFAULT_TEAM_TYPE,
  ORDER_BY_SQL,
  RATINGS_2K_ATTRIBUTION,
  SORTS,
  TEAM_TYPES,
  normalizeName,
  parseSort,
  parseTeamType,
} from '../../src/services/ratings2kParams.js';

describe('parseTeamType', () => {
  it('defaults to current players when nothing is supplied', () => {
    // act + assert
    expect(parseTeamType(undefined)).toEqual({ ok: true, teamType: 'curr' });
    expect(parseTeamType('')).toEqual({ ok: true, teamType: 'curr' });
    expect(parseTeamType(null)).toEqual({ ok: true, teamType: DEFAULT_TEAM_TYPE });
  });

  it("accepts each of 2K's roster types", () => {
    // act + assert
    for (const teamType of TEAM_TYPES) {
      expect(parseTeamType(teamType)).toEqual({ ok: true, teamType });
    }
  });

  it('treats "all" as no roster filter', () => {
    // act + assert
    expect(parseTeamType('all')).toEqual({ ok: true, teamType: null });
  });

  it('rejects anything unrecognized instead of defaulting', () => {
    // act + assert — a wrong roster is a wrong answer, not a clamped one
    expect(parseTeamType('current')).toEqual({ ok: false });
    expect(parseTeamType('CURR')).toEqual({ ok: false });
    expect(parseTeamType('curr,class')).toEqual({ ok: false });
    expect(parseTeamType(7)).toEqual({ ok: false });
    expect(parseTeamType(['curr'])).toEqual({ ok: false });
  });

  it("rejects a roster type with sql appended", () => {
    // act + assert
    expect(parseTeamType("curr'; DROP TABLE nba_2k_players--")).toEqual({ ok: false });
  });
});

describe('parseSort', () => {
  it('accepts the whitelisted sort keys', () => {
    // act + assert
    for (const sort of SORTS) {
      expect(parseSort(sort)).toBe(sort);
    }
  });

  it('falls back to the default for anything else', () => {
    // act + assert — a different row order is not a wrong answer
    expect(parseSort(undefined)).toBe(DEFAULT_SORT);
    expect(parseSort('')).toBe(DEFAULT_SORT);
    expect(parseSort('threePointShot')).toBe(DEFAULT_SORT);
    expect(parseSort(['overall'])).toBe(DEFAULT_SORT);
  });

  it('never lets an injected ordering clause through', () => {
    // arrange
    const injected = 'overall; DROP TABLE nba_2k_players--';

    // act
    const sort = parseSort(injected);

    // assert — the raw value is discarded, so it can't reach the ORDER BY
    expect(sort).toBe(DEFAULT_SORT);
    expect(ORDER_BY_SQL[sort]).not.toContain('DROP');
  });
});

describe('ORDER_BY_SQL', () => {
  it('has a fixed clause for every whitelisted sort', () => {
    // act + assert
    expect(Object.keys(ORDER_BY_SQL).sort()).toEqual([...SORTS].sort());
  });

  it('orders by rating then name by default', () => {
    // act + assert
    expect(ORDER_BY_SQL.overall).toBe('overall DESC NULLS LAST, name ASC');
  });
});

describe('normalizeName', () => {
  // parity fixtures: every expected value below is the output of
  // _normalize_name in scraper/run_scraper.py, which writes the stored
  // normalized_name these are compared against.
  it('strips accents so a diacritic spelling still matches', () => {
    // act + assert
    expect(normalizeName('Alperen Şengün')).toBe('alperen sengun');
    expect(normalizeName('Nikola Jokić')).toBe('nikola jokic');
    expect(normalizeName('Luka Dončić')).toBe('luka doncic');
    expect(normalizeName('Kristaps Porziņģis')).toBe('kristaps porzingis');
  });

  it('drops generational suffixes', () => {
    // act + assert
    expect(normalizeName('Michael Porter Jr.')).toBe('michael porter');
    expect(normalizeName('Larry Nance Jr')).toBe('larry nance');
    expect(normalizeName('Gary Payton II')).toBe('gary payton');
    expect(normalizeName('Marvin Bagley III')).toBe('marvin bagley');
    expect(normalizeName('O\'Neal-Smith Sr.')).toBe('oneal smith');
  });

  it('drops punctuation and folds hyphens to spaces', () => {
    // act + assert
    expect(normalizeName('P.J. Tucker')).toBe('pj tucker');
    expect(normalizeName("D'Angelo Russell")).toBe('dangelo russell');
    expect(normalizeName('Karl-Anthony Towns')).toBe('karl anthony towns');
    expect(normalizeName('Shai Gilgeous-Alexander')).toBe('shai gilgeous alexander');
  });

  it('collapses surrounding and repeated whitespace', () => {
    // act + assert
    expect(normalizeName('  Spaced   Out  ')).toBe('spaced out');
  });

  it('leaves an already-plain name alone apart from casing', () => {
    // act + assert
    expect(normalizeName('LeBron James')).toBe('lebron james');
  });

  it('returns an empty string for anything unusable', () => {
    // act + assert — the route treats this as a 400 rather than querying
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
    expect(normalizeName(42)).toBe('');
    expect(normalizeName(['LeBron James'])).toBe('');
  });
});

describe('RATINGS_2K_ATTRIBUTION', () => {
  it('credits the data source and disclaims affiliation', () => {
    // act + assert — the frontend renders this verbatim, so it lives in one place
    expect(RATINGS_2K_ATTRIBUTION).toContain('nba2kapi.com');
    expect(RATINGS_2K_ATTRIBUTION).toContain('2kratings.com');
    expect(RATINGS_2K_ATTRIBUTION).toMatch(/not affiliated/i);
    expect(RATINGS_2K_ATTRIBUTION).toContain('Take-Two');
  });
});
