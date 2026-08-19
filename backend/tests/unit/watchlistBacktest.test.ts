import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KS,
  LEAGUE_PERCENTILE,
  MIN_TRAILING_GAMES,
  PERSONAL_PERCENTILE,
  TRAILING_GAMES,
  parseArgs,
  precisionAt,
  quantile,
} from '../../scripts/watchlistBacktest.js';

// the script guards its own `main()` behind a direct-invocation check, so
// importing it here reaches no database.

describe('parseArgs', () => {
  it('defaults to run 1 against the primary database', () => {
    // act
    const args = parseArgs([]);

    // assert
    expect(args).toEqual({ runId: 1, dev: false, ks: [...DEFAULT_KS], verbose: false });
  });

  it('reads the run, the dev switch and the cut-offs', () => {
    // act
    const args = parseArgs(['--run', '7', '--dev', '--k', '3,5,20', '--verbose']);

    // assert
    expect(args).toEqual({ runId: 7, dev: true, ks: [3, 5, 20], verbose: true });
  });

  it('rejects a malformed run id rather than silently backtesting run NaN', () => {
    // act + assert
    expect(() => parseArgs(['--run', 'latest'])).toThrow(/--run/);
    expect(() => parseArgs(['--run', '0'])).toThrow(/--run/);
  });

  it('rejects a malformed cut-off list', () => {
    // act + assert
    expect(() => parseArgs(['--k', '5,ten'])).toThrow(/--k/);
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    // act + assert — a typo'd flag must not quietly run the default backtest
    expect(() => parseArgs(['--production'])).toThrow(/unknown argument/);
  });
});

describe('quantile', () => {
  it('interpolates between the bracketing samples', () => {
    // act + assert
    expect(quantile([0, 10], 50)).toBe(5);
    expect(quantile([0, 1, 2, 3, 4], 75)).toBe(3);
  });

  it('returns the endpoints at 0 and 100', () => {
    // act + assert
    expect(quantile([4, 1, 9], 0)).toBe(1);
    expect(quantile([4, 1, 9], 100)).toBe(9);
  });

  it('does not require its input to be sorted', () => {
    // act + assert
    expect(quantile([9, 1, 5], 50)).toBe(5);
  });

  it('handles a single sample and an empty one', () => {
    // act + assert
    expect(quantile([3], 75)).toBe(3);
    expect(Number.isNaN(quantile([], 75))).toBe(true);
  });
});

describe('precisionAt', () => {
  it('counts hits among the first k picks', () => {
    // act
    const { hits, picks } = precisionAt([true, false, true, false, false], 3);

    // assert
    expect(hits).toBe(2);
    expect(picks).toBe(3);
  });

  it('reports the picks it actually had when the list is shorter than k', () => {
    // act — a night with two eligible players cannot be graded at 10
    const { hits, picks } = precisionAt([true, false], 10);

    // assert
    expect(hits).toBe(1);
    expect(picks).toBe(2);
  });

  it('is zero over an empty ranking', () => {
    // act + assert
    expect(precisionAt([], 5)).toEqual({ hits: 0, picks: 0 });
  });
});

describe('the big-night definition', () => {
  it('requires both halves to be a real bar', () => {
    // act + assert — a personal-only test would reward a bench player's best
    // game of the month, which is the failure the relevance term exists to stop
    expect(PERSONAL_PERCENTILE).toBeGreaterThan(50);
    expect(LEAGUE_PERCENTILE).toBeGreaterThan(50);
  });

  it('needs enough trailing games for a personal percentile to mean anything', () => {
    // act + assert
    expect(MIN_TRAILING_GAMES).toBeGreaterThan(5);
    expect(MIN_TRAILING_GAMES).toBeLessThanOrEqual(TRAILING_GAMES);
  });
});
