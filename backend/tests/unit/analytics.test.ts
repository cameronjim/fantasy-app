import { describe, it, expect } from 'vitest';
import {
  ANALYTICS_STATS,
  BUCKET_COUNT,
  POOL_DEFINITION,
  POOL_KEY,
  TREND_STATS,
  attemptWeightedImpact,
  buildBuckets,
  buildDistributions,
  buildPercentiles,
  isValidPoolKey,
  last10VsSeason,
  mean,
  parseAnalyticsStat,
  parsePlayerId,
  percentRank,
  poolDescriptor,
  rollingMean,
  stddev,
  type PoolPlayer,
  type PoolSnapshot,
  type StatValues,
  type TrendValues,
} from '../../src/services/analytics.js';

function statValues(overrides: Partial<StatValues> = {}): StatValues {
  return {
    pts: 0, reb: 0, ast: 0, stl: 0, blk: 0,
    fg3m: 0, tov: 0, fg_impact: 0, ft_impact: 0, minutes: 0,
    ...overrides,
  };
}

function poolPlayer(id: number, name: string, overrides: Partial<StatValues>): PoolPlayer {
  return { id, name, values: statValues(overrides) };
}

function snapshotOf(players: PoolPlayer[]): PoolSnapshot {
  return {
    fetchedAt: Date.UTC(2026, 0, 15),
    players,
    fgPct: 0.47,
    ftPct: 0.78,
    teamAbbrById: new Map(),
  };
}

function game(overrides: Partial<TrendValues> = {}): TrendValues {
  return {
    pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0, tov: 0, minutes: 0,
    ...overrides,
  };
}

describe('mean', () => {
  it('averages the sample', () => {
    // act + assert
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('reports 0 for an empty sample', () => {
    // act + assert
    expect(mean([])).toBe(0);
  });
});

describe('stddev', () => {
  it('computes the population standard deviation', () => {
    // act + assert — mean 4, deviations 4/1/1/4 -> sqrt(2.5)
    expect(stddev([2, 3, 5, 6])).toBeCloseTo(Math.sqrt(2.5), 10);
  });

  it('is 0 when every value is identical', () => {
    // act + assert
    expect(stddev([7, 7, 7])).toBe(0);
  });

  it('reports 0 for an empty sample', () => {
    // act + assert
    expect(stddev([])).toBe(0);
  });
});

describe('percentRank', () => {
  it('places a value by how much of the sample it beats', () => {
    // arrange
    const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    // act + assert — 9 below, 1 tie counted half
    expect(percentRank(pool, 10)).toBe(95);
    expect(percentRank(pool, 1)).toBe(5);
  });

  it('splits ties so an all-identical pool sits at the neutral 50', () => {
    // act + assert
    expect(percentRank([5, 5, 5, 5], 5)).toBe(50);
  });

  it('puts a lone player in their own pool at 50', () => {
    // act + assert
    expect(percentRank([12.5], 12.5)).toBe(50);
  });

  it('returns the neutral 50 for an empty pool', () => {
    // act + assert — no pool means no information, not "worst in the league"
    expect(percentRank([], 30)).toBe(50);
    expect(percentRank([], 30, true)).toBe(50);
  });

  it('flips the scale when reversed, so fewer turnovers rank higher', () => {
    // arrange
    const turnovers = [1, 2, 3, 4];

    // act + assert
    expect(percentRank(turnovers, 1)).toBe(12.5);
    expect(percentRank(turnovers, 1, true)).toBe(87.5);
    expect(percentRank(turnovers, 4, true)).toBe(12.5);
  });

  it('ranks a value outside the pool against it', () => {
    // act + assert — a sub-pool player is still placed on the pool's scale
    expect(percentRank([10, 20, 30], 40)).toBe(100);
    expect(percentRank([10, 20, 30], 1)).toBe(0);
  });
});

describe('buildBuckets', () => {
  it('spreads the sample over equal-width buckets', () => {
    // arrange
    const values = [0, 5, 10];

    // act
    const buckets = buildBuckets(values, 2);

    // assert
    expect(buckets).toEqual([
      { lo: 0, hi: 5, count: 1 },
      { lo: 5, hi: 10, count: 2 },
    ]);
  });

  it('defaults to 20 buckets spanning min to max', () => {
    // arrange
    const values = Array.from({ length: 100 }, (_, i) => i);

    // act
    const buckets = buildBuckets(values);

    // assert
    expect(buckets).toHaveLength(BUCKET_COUNT);
    expect(buckets[0].lo).toBe(0);
    expect(buckets[BUCKET_COUNT - 1].hi).toBe(99);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(100);
  });

  it('collapses to a single bucket when every value is identical', () => {
    // act + assert — 20 zero-width buckets would be noise, not a histogram
    expect(buildBuckets([4, 4, 4])).toEqual([{ lo: 4, hi: 4, count: 3 }]);
  });

  it('returns no buckets for an empty sample', () => {
    // act + assert
    expect(buildBuckets([])).toEqual([]);
  });

  it('handles a single-player pool', () => {
    // act + assert
    expect(buildBuckets([22.4])).toEqual([{ lo: 22.4, hi: 22.4, count: 1 }]);
  });
});

describe('rollingMean', () => {
  it('averages the trailing window', () => {
    // act
    const result = rollingMean([1, 2, 3, 4, 5], 3);

    // assert
    expect(result).toEqual([null, null, 2, 3, 4]);
  });

  it('is all nulls until the window is full', () => {
    // act + assert — a 10-game line must not start on 3 games of data
    expect(rollingMean([10, 20, 30], 10)).toEqual([null, null, null]);
  });

  it('returns an aligned array for an empty series', () => {
    // act + assert
    expect(rollingMean([], 5)).toEqual([]);
  });

  it('nulls everything for a non-positive window', () => {
    // act + assert
    expect(rollingMean([1, 2], 0)).toEqual([null, null]);
  });
});

describe('attemptWeightedImpact', () => {
  it('reports excess makes per game against the pool rate', () => {
    // arrange — 100/200 shooting against a 45% pool over 20 games
    // act
    const impact = attemptWeightedImpact(100, 200, 0.45, 20);

    // assert — 100 - 90 = 10 extra makes, spread over 20 games
    expect(impact).toBe(0.5);
  });

  it('goes negative for a below-pool shooter on volume', () => {
    // act + assert
    expect(attemptWeightedImpact(80, 200, 0.45, 20)).toBe(-0.5);
  });

  it('is 0 for a pool-average shooter regardless of volume', () => {
    // act + assert — the whole point: efficiency only counts with attempts
    expect(attemptWeightedImpact(90, 200, 0.45, 20)).toBe(0);
    expect(attemptWeightedImpact(9, 20, 0.45, 20)).toBe(0);
  });

  it('is 0 when the player has no games', () => {
    // act + assert
    expect(attemptWeightedImpact(0, 0, 0.45, 0)).toBe(0);
  });
});

describe('last10VsSeason', () => {
  it('compares the last ten games to the full season', () => {
    // arrange — 10 cold games then 10 hot ones
    const games = [
      ...Array.from({ length: 10 }, () => game({ pts: 10 })),
      ...Array.from({ length: 10 }, () => game({ pts: 20 })),
    ];

    // act
    const points = last10VsSeason(games).find((c) => c.stat === 'pts');

    // assert
    expect(points).toMatchObject({ last10: 20, season: 15, delta: 5 });
    expect(points?.z).toBe(1);
  });

  it('covers every trend stat', () => {
    // arrange
    const games = Array.from({ length: 20 }, () => game({ pts: 12, tov: 2 }));

    // act
    const result = last10VsSeason(games);

    // assert
    expect(result.map((c) => c.stat)).toEqual([...TREND_STATS]);
  });

  it('returns nothing when the player has no logged games', () => {
    // act + assert
    expect(last10VsSeason([])).toEqual([]);
  });

  it('nulls the z-score below the minimum sample', () => {
    // arrange — 14 games, one short of the threshold
    const games = Array.from({ length: 14 }, (_, i) => game({ pts: i }));

    // act
    const points = last10VsSeason(games).find((c) => c.stat === 'pts');

    // assert
    expect(points?.last10).toBeGreaterThan(0);
    expect(points?.z).toBeNull();
  });

  it('nulls the z-score when the player has no variance to normalize by', () => {
    // arrange — 20 identical games
    const games = Array.from({ length: 20 }, () => game({ pts: 14 }));

    // act
    const points = last10VsSeason(games).find((c) => c.stat === 'pts');

    // assert
    expect(points).toMatchObject({ last10: 14, season: 14, delta: 0 });
    expect(points?.z).toBeNull();
  });

  it('uses every game when the player has fewer than ten', () => {
    // arrange
    const games = [game({ reb: 4 }), game({ reb: 6 })];

    // act
    const rebounds = last10VsSeason(games).find((c) => c.stat === 'reb');

    // assert
    expect(rebounds).toMatchObject({ last10: 5, season: 5, delta: 0, z: null });
  });

  it('reports a turnover rise as a positive delta, leaving direction to the caller', () => {
    // arrange
    const games = [
      ...Array.from({ length: 10 }, () => game({ tov: 1 })),
      ...Array.from({ length: 10 }, () => game({ tov: 3 })),
    ];

    // act
    const turnovers = last10VsSeason(games).find((c) => c.stat === 'tov');

    // assert
    expect(turnovers).toMatchObject({ last10: 3, season: 2, delta: 1 });
  });
});

describe('buildPercentiles', () => {
  it('ranks the player on every analytics stat', () => {
    // arrange
    const snapshot = snapshotOf([
      poolPlayer(1, 'Low', { pts: 10, tov: 1 }),
      poolPlayer(2, 'Mid', { pts: 20, tov: 2 }),
      poolPlayer(3, 'High', { pts: 30, tov: 3 }),
    ]);

    // act
    const result = buildPercentiles(snapshot, statValues({ pts: 30, tov: 3 }));

    // assert
    expect(result.map((p) => p.stat)).toEqual([...ANALYTICS_STATS]);
    expect(result.find((p) => p.stat === 'pts')).toEqual({
      stat: 'pts',
      value: 30,
      percentile: 83.3,
    });
  });

  it('reverses turnovers so the worst volume ranks lowest', () => {
    // arrange
    const snapshot = snapshotOf([
      poolPlayer(1, 'Careful', { tov: 1 }),
      poolPlayer(2, 'Loose', { tov: 5 }),
    ]);

    // act
    const careful = buildPercentiles(snapshot, statValues({ tov: 1 }));
    const loose = buildPercentiles(snapshot, statValues({ tov: 5 }));

    // assert
    expect(careful.find((p) => p.stat === 'tov')?.percentile).toBe(75);
    expect(loose.find((p) => p.stat === 'tov')?.percentile).toBe(25);
  });

  it('still returns every stat against an empty pool', () => {
    // act
    const result = buildPercentiles(snapshotOf([]), statValues({ pts: 25 }));

    // assert
    expect(result).toHaveLength(ANALYTICS_STATS.length);
    expect(result.every((p) => p.percentile === 50)).toBe(true);
  });
});

describe('buildDistributions', () => {
  it('describes each stat and marks the player on it', () => {
    // arrange
    const snapshot = snapshotOf([
      poolPlayer(1, 'A', { pts: 10 }),
      poolPlayer(2, 'B', { pts: 20 }),
      poolPlayer(3, 'C', { pts: 30 }),
    ]);

    // act
    const points = buildDistributions(snapshot, statValues({ pts: 20 })).find(
      (d) => d.stat === 'pts'
    );

    // assert
    expect(points?.mean).toBe(20);
    expect(points?.stddev).toBeCloseTo(8.165, 3);
    expect(points?.player_value).toBe(20);
    expect(points?.buckets).toHaveLength(BUCKET_COUNT);
  });

  it('returns empty buckets when the pool is empty', () => {
    // act
    const result = buildDistributions(snapshotOf([]), statValues());

    // assert
    expect(result).toHaveLength(ANALYTICS_STATS.length);
    expect(result.every((d) => d.buckets.length === 0)).toBe(true);
    expect(result.every((d) => d.mean === 0 && d.stddev === 0)).toBe(true);
  });

  it('collapses a single-player pool to one bucket', () => {
    // arrange
    const snapshot = snapshotOf([poolPlayer(1, 'Only', { pts: 18 })]);

    // act
    const points = buildDistributions(snapshot, statValues({ pts: 18 })).find(
      (d) => d.stat === 'pts'
    );

    // assert
    expect(points?.buckets).toEqual([{ lo: 18, hi: 18, count: 1 }]);
    expect(points?.stddev).toBe(0);
  });
});

describe('poolDescriptor', () => {
  it('carries the definition the response advertises', () => {
    // act
    const pool = poolDescriptor(212);

    // assert
    expect(pool).toEqual({
      key: POOL_KEY,
      label: 'Rotation players',
      definition: POOL_DEFINITION,
      sample_size: 212,
    });
  });
});

describe('parseAnalyticsStat', () => {
  it('accepts every whitelisted stat', () => {
    // act + assert
    for (const stat of ANALYTICS_STATS) {
      expect(parseAnalyticsStat(stat)).toBe(stat);
    }
  });

  it('rejects anything not on the whitelist', () => {
    // act + assert — the raw value never reaches SQL, but reject it anyway
    expect(parseAnalyticsStat('points')).toBeNull();
    expect(parseAnalyticsStat('pts; DROP TABLE players--')).toBeNull();
    expect(parseAnalyticsStat('')).toBeNull();
    expect(parseAnalyticsStat(undefined)).toBeNull();
    expect(parseAnalyticsStat(['pts'])).toBeNull();
  });
});

describe('isValidPoolKey', () => {
  it('accepts the rotation pool and an absent pool', () => {
    // act + assert
    expect(isValidPoolKey('rotation')).toBe(true);
    expect(isValidPoolKey(undefined)).toBe(true);
    expect(isValidPoolKey('')).toBe(true);
  });

  it('rejects an unknown pool', () => {
    // act + assert
    expect(isValidPoolKey('starters')).toBe(false);
    expect(isValidPoolKey(['rotation'])).toBe(false);
  });
});

describe('parsePlayerId', () => {
  it('accepts a positive integer id', () => {
    // act + assert
    expect(parsePlayerId('42')).toBe(42);
    expect(parsePlayerId(7)).toBe(7);
  });

  it('rejects non-numeric and non-positive ids', () => {
    // act + assert
    expect(parsePlayerId('abc')).toBeNull();
    expect(parsePlayerId('0')).toBeNull();
    expect(parsePlayerId('-3')).toBeNull();
    expect(parsePlayerId(undefined)).toBeNull();
  });
});
