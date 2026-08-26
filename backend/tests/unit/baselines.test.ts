import { describe, it, expect } from 'vitest';
import {
  BASELINE_RECENT_GAMES,
  BASELINE_STATS,
  BASELINE_WINDOW_GAMES,
  MIN_BASELINE_GAMES,
  NOTABLE_MINUTES_DELTA,
  baselineDescriptor,
  daysSince,
  deltaOf,
  hasUsableBaseline,
  type BaselineStat,
  type PlayerBaseline,
} from '../../src/services/baselines.js';

function baseline(overrides: Partial<PlayerBaseline> = {}): PlayerBaseline {
  const avg = {} as Record<BaselineStat, number | null>;
  for (const stat of BASELINE_STATS) avg[stat] = 1;
  return {
    nba_player_id: '1001',
    games: BASELINE_WINDOW_GAMES,
    avg,
    pts_recent: 12,
    pts_sd: 4,
    last_played_date: '2026-02-03',
    ...overrides,
  };
}

describe('hasUsableBaseline', () => {
  it('accepts a baseline exactly at the minimum', () => {
    expect(hasUsableBaseline(baseline({ games: MIN_BASELINE_GAMES }))).toBe(true);
  });

  it('rejects one game short — that is the rookie with no usual to deviate from', () => {
    expect(hasUsableBaseline(baseline({ games: MIN_BASELINE_GAMES - 1 }))).toBe(false);
  });

  it('rejects a player with no baseline row at all', () => {
    expect(hasUsableBaseline(undefined)).toBe(false);
  });
});

describe('deltaOf', () => {
  it('subtracts usual from projected', () => {
    expect(deltaOf(31, 22)).toBe(9);
    expect(deltaOf(18, 26)).toBe(-8);
  });

  it('is null rather than zero when either half is missing', () => {
    expect(deltaOf(31, null)).toBeNull();
    expect(deltaOf(null, 22)).toBeNull();
  });

  it('reports a genuine zero as zero', () => {
    expect(deltaOf(24, 24)).toBe(0);
  });
});

describe('daysSince', () => {
  it('counts whole days from the last appearance to the date', () => {
    expect(daysSince('2026-02-10', '2026-02-01')).toBe(9);
  });

  it('spans a month boundary', () => {
    expect(daysSince('2026-03-02', '2026-02-25')).toBe(5);
  });

  it('is null when there is no appearance on record', () => {
    expect(daysSince('2026-02-10', null)).toBeNull();
  });

  it('is null for an unparseable day rather than NaN days', () => {
    expect(daysSince('2026-02-10', 'not-a-day')).toBeNull();
  });
});

describe('baselineDescriptor', () => {
  it('publishes the window, the minimum and the threshold the pages read', () => {
    const descriptor = baselineDescriptor();

    expect(descriptor.window_games).toBe(BASELINE_WINDOW_GAMES);
    expect(descriptor.min_games).toBe(MIN_BASELINE_GAMES);
    expect(descriptor.notable_min_delta).toBe(NOTABLE_MINUTES_DELTA);
    expect(descriptor.definition).toContain(String(BASELINE_WINDOW_GAMES));
    expect(descriptor.definition).toContain(String(MIN_BASELINE_GAMES));
    expect(descriptor.label).toBeTruthy();
  });
});

describe('the baseline window', () => {
  it('keeps the hot-streak window inside the baseline window', () => {
    expect(BASELINE_RECENT_GAMES).toBeLessThan(BASELINE_WINDOW_GAMES);
  });

  it('covers every stat the projections can be compared against', () => {
    expect([...BASELINE_STATS]).toEqual(
      expect.arrayContaining(['minutes', 'pts', 'reb', 'ast', 'stl', 'blk', 'fg3m', 'fga'])
    );
  });
});
