import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TOP_PLAYERS_PER_GAME,
  isMissingRelation,
  num,
  parsePredictionDate,
  rankSlatePlayers,
  round,
  toIsoDay,
  type SlatePlayer,
} from '../../src/services/slate.js';

function player(overrides: Partial<SlatePlayer> = {}): SlatePlayer {
  return {
    nba_player_id: '1',
    name: 'Test Player',
    team_abbr: 'LAL',
    prob_active: 0.9,
    proj_pts: 10,
    proj_min_p50: 25,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parsePredictionDate', () => {
  it('defaults to the ET calendar day, not the UTC one', () => {
    // arrange — 03:30 UTC on Feb 5 is still Feb 4 in New York
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-05T03:30:00Z'));

    // act + assert
    expect(parsePredictionDate(undefined)).toBe('2026-02-04');
    expect(parsePredictionDate('')).toBe('2026-02-04');
  });

  it('accepts a well-formed calendar day', () => {
    // act + assert
    expect(parsePredictionDate('2026-02-04')).toBe('2026-02-04');
    expect(parsePredictionDate('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects a date that is not a real calendar day', () => {
    // act + assert — clamping Feb 31 onto Mar 3 would answer for another day
    expect(parsePredictionDate('2026-02-31')).toBeNull();
    expect(parsePredictionDate('2025-02-29')).toBeNull();
    expect(parsePredictionDate('2026-13-01')).toBeNull();
  });

  it('rejects anything that is not a YYYY-MM-DD string', () => {
    // act + assert
    expect(parsePredictionDate('02/04/2026')).toBeNull();
    expect(parsePredictionDate('2026-2-4')).toBeNull();
    expect(parsePredictionDate('tomorrow')).toBeNull();
    expect(parsePredictionDate(20260204)).toBeNull();
    expect(parsePredictionDate(['2026-02-04'])).toBeNull();
  });
});

describe('num', () => {
  it('parses the strings pg returns for NUMERIC columns', () => {
    // act + assert
    expect(num('12.5')).toBe(12.5);
    expect(num(3)).toBe(3);
  });

  it('distinguishes missing from zero', () => {
    // act + assert
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(0)).toBe(0);
  });
});

describe('round', () => {
  it('rounds to the requested precision', () => {
    // act + assert
    expect(round(12.3456, 1)).toBe(12.3);
    expect(round(0.98765, 3)).toBe(0.988);
  });

  it('keeps null as null rather than collapsing it to zero', () => {
    // act + assert
    expect(round(null, 2)).toBeNull();
  });
});

describe('toIsoDay', () => {
  it('reads the local calendar fields of a pg DATE', () => {
    // arrange — local midnight; toISOString would shift this a day east of UTC
    const date = new Date(2026, 1, 4);

    // act + assert
    expect(toIsoDay(date)).toBe('2026-02-04');
  });

  it('takes the day off a timestamp string', () => {
    // act + assert
    expect(toIsoDay('2026-02-04T00:00:00.000Z')).toBe('2026-02-04');
  });

  it('is null for anything else', () => {
    // act + assert
    expect(toIsoDay(null)).toBeNull();
    expect(toIsoDay(42)).toBeNull();
  });
});

describe('isMissingRelation', () => {
  it('recognizes an unapplied migration', () => {
    // act + assert
    expect(isMissingRelation({ code: '42P01' })).toBe(true);
    expect(isMissingRelation({ code: '42703' })).toBe(true);
  });

  it('does not swallow a real database failure', () => {
    // act + assert — a connection error must surface, not read as "no games"
    expect(isMissingRelation({ code: '08006' })).toBe(false);
    expect(isMissingRelation(new Error('db down'))).toBe(false);
    expect(isMissingRelation(null)).toBe(false);
  });
});

describe('rankSlatePlayers', () => {
  it('orders by projected points, best first', () => {
    // act
    const ranked = rankSlatePlayers([
      player({ nba_player_id: '1', name: 'Low', proj_pts: 8 }),
      player({ nba_player_id: '2', name: 'High', proj_pts: 26 }),
      player({ nba_player_id: '3', name: 'Mid', proj_pts: 17 }),
    ]);

    // assert
    expect(ranked.map((p) => p.name)).toEqual(['High', 'Mid', 'Low']);
  });

  it('sorts unprojected players to the bottom — a null is unknown, not zero', () => {
    // act
    const ranked = rankSlatePlayers([
      player({ nba_player_id: '1', name: 'Unknown', proj_pts: null }),
      player({ nba_player_id: '2', name: 'Known', proj_pts: 2 }),
    ]);

    // assert
    expect(ranked.map((p) => p.name)).toEqual(['Known', 'Unknown']);
  });

  it('breaks ties by name so the order is stable', () => {
    // act
    const ranked = rankSlatePlayers([
      player({ nba_player_id: '1', name: 'Zeb', proj_pts: 12 }),
      player({ nba_player_id: '2', name: 'Abe', proj_pts: 12 }),
    ]);

    // assert
    expect(ranked.map((p) => p.name)).toEqual(['Abe', 'Zeb']);
  });

  it('caps each game at the published depth', () => {
    // arrange
    const many = Array.from({ length: 14 }, (_, i) =>
      player({ nba_player_id: String(i), name: `P${i}`, proj_pts: i })
    );

    // act + assert
    expect(rankSlatePlayers(many)).toHaveLength(TOP_PLAYERS_PER_GAME);
  });

  it('does not mutate the input array', () => {
    // arrange
    const input = [
      player({ nba_player_id: '1', name: 'Low', proj_pts: 4 }),
      player({ nba_player_id: '2', name: 'High', proj_pts: 30 }),
    ];

    // act
    rankSlatePlayers(input);

    // assert
    expect(input.map((p) => p.name)).toEqual(['Low', 'High']);
  });
});
