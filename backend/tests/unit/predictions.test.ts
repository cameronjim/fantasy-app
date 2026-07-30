import { describe, it, expect } from 'vitest';
import {
  pivotPredictionRows,
  type PredictionRow,
} from '../../src/services/predictions.js';

// the prediction store is long format — one row per (run, player, game, stat,
// quantile) — and the page wants one object. everything that can go wrong in
// between is a reshaping question, so it is tested here as a pure function over
// rows rather than through the endpoint.

const PREDICTED_AT = new Date('2026-03-01T13:30:00.000Z');
const GAME_DATE = new Date(2026, 2, 2); // local midnight, as pg returns a DATE

function row(overrides: Partial<PredictionRow> = {}): PredictionRow {
  return {
    model_version: '2026-02-28',
    predicted_at: PREDICTED_AT,
    game_date: GAME_DATE,
    stat: 'pts',
    quantile: null,
    value: 20,
    conditional: true,
    ...overrides,
  };
}

/** The row set one player-game of a real run produces. */
function fullRowSet(): PredictionRow[] {
  return [
    row({ stat: 'prob_active', value: 0.82, conditional: false }),
    row({ stat: 'minutes', value: 34 }),
    row({ stat: 'minutes_uncond', value: 27.88, conditional: false }),
    row({ stat: 'pts', value: 25 }),
    row({ stat: 'pts_uncond', value: 20.5, conditional: false }),
    row({ stat: 'ast', value: 8 }),
    row({ stat: 'ast_uncond', value: 6.56, conditional: false }),
    row({ stat: 'minutes', quantile: 0.1, value: 26 }),
    row({ stat: 'minutes', quantile: 0.5, value: 34.5 }),
    row({ stat: 'minutes', quantile: 0.9, value: 41 }),
    row({ stat: 'pts', quantile: 0.1, value: 14 }),
    row({ stat: 'pts', quantile: 0.5, value: 24.5 }),
    row({ stat: 'pts', quantile: 0.9, value: 37 }),
  ];
}

describe('pivotPredictionRows', () => {
  it('pivots a full row set into the served shape', () => {
    // act
    const result = pivotPredictionRows(fullRowSet());

    // assert
    expect(result).toEqual({
      as_of: '2026-03-01T13:30:00.000Z',
      model_version: '2026-02-28',
      game_date: '2026-03-02',
      prob_active: 0.82,
      projected: {
        minutes: { p10: 26, p50: 34.5, p90: 41 },
        pts: { p10: 14, p50: 24.5, p90: 37 },
        reb: null,
        ast: 8,
        stl: null,
        blk: null,
        tov: null,
        fg3m: null,
      },
      conditional: true,
      unconditional_pts: 20.5,
      summary:
        '82% to play, 34.5 min (26.0-41.0), 24.5 pts (14.0-37.0) if he plays, ' +
        '20.5 pts averaged over the schedule.',
    });
  });

  it('returns null for an empty row set, so the page hides the card', () => {
    // act + assert
    expect(pivotPredictionRows([])).toBeNull();
  });

  it('reads the expected value, not the median, as the point estimate', () => {
    // arrange — the conditional mean (8) and a P50 that would disagree with it
    const rows = [row({ stat: 'ast', value: 8 }), row({ stat: 'ast', quantile: 0.5, value: 6 })];

    // act
    const result = pivotPredictionRows(rows);

    // assert
    expect(result?.projected.ast).toBe(8);
  });

  it('keeps the conditional estimate separate from the unconditional one', () => {
    // arrange — the distinction the whole decomposition exists to preserve
    const rows = [
      row({ stat: 'pts', quantile: 0.1, value: 14 }),
      row({ stat: 'pts', quantile: 0.5, value: 24.5 }),
      row({ stat: 'pts', quantile: 0.9, value: 37 }),
      row({ stat: 'pts_uncond', value: 20.5, conditional: false }),
    ];

    // act
    const result = pivotPredictionRows(rows);

    // assert
    expect(result?.projected.pts).toEqual({ p10: 14, p50: 24.5, p90: 37 });
    expect(result?.unconditional_pts).toBe(20.5);
    expect(result?.conditional).toBe(true);
  });

  it('coerces the NUMERIC strings pg returns into numbers', () => {
    // arrange — pg serializes NUMERIC as a string to avoid precision loss
    const rows = [
      row({ stat: 'prob_active', value: '0.8200', quantile: null, conditional: false }),
      row({ stat: 'reb', value: '7.25' }),
      row({ stat: 'pts', quantile: '0.10', value: '14.00' }),
      row({ stat: 'pts', quantile: '0.50', value: '24.50' }),
      row({ stat: 'pts', quantile: '0.90', value: '37.00' }),
    ];

    // act
    const result = pivotPredictionRows(rows);

    // assert
    expect(result?.prob_active).toBe(0.82);
    expect(result?.projected.reb).toBe(7.25);
    expect(result?.projected.pts).toEqual({ p10: 14, p50: 24.5, p90: 37 });
  });

  it('accepts ISO strings for the dates as well as Date objects', () => {
    // act
    const result = pivotPredictionRows([
      row({ predicted_at: '2026-03-01T13:30:00.000Z', game_date: '2026-03-02' }),
    ]);

    // assert
    expect(result?.as_of).toBe('2026-03-01T13:30:00.000Z');
    expect(result?.game_date).toBe('2026-03-02');
  });

  it('drops a range that is missing one of its three quantiles', () => {
    // arrange — a half range is not a narrower range, it is an unreadable one
    const rows = [
      row({ stat: 'pts', quantile: 0.1, value: 14 }),
      row({ stat: 'pts', quantile: 0.5, value: 24.5 }),
    ];

    // act
    const result = pivotPredictionRows(rows);

    // assert
    expect(result?.projected.pts).toBeNull();
  });

  it('sorts a crossed range rather than serving it backwards', () => {
    // arrange — P90 stored below P10
    const rows = [
      row({ stat: 'minutes', quantile: 0.1, value: 41 }),
      row({ stat: 'minutes', quantile: 0.5, value: 34.5 }),
      row({ stat: 'minutes', quantile: 0.9, value: 26 }),
    ];

    // act
    const result = pivotPredictionRows(rows);

    // assert
    expect(result?.projected.minutes).toEqual({ p10: 26, p50: 34.5, p90: 41 });
  });

  it('clamps a probability that arrived outside [0,1]', () => {
    // act
    const high = pivotPredictionRows([
      row({ stat: 'prob_active', value: 1.0000002, conditional: false }),
    ]);
    const low = pivotPredictionRows([
      row({ stat: 'prob_active', value: -0.5, conditional: false }),
    ]);

    // assert
    expect(high?.prob_active).toBe(1);
    expect(low?.prob_active).toBe(0);
  });

  it('nulls every projection the run did not emit', () => {
    // arrange — only a probability, which is what a run with no EWMA state gives
    const result = pivotPredictionRows([
      row({ stat: 'prob_active', value: 0.4, conditional: false }),
    ]);

    // assert
    expect(result?.projected).toEqual({
      minutes: null, pts: null, reb: null, ast: null,
      stl: null, blk: null, tov: null, fg3m: null,
    });
    expect(result?.unconditional_pts).toBeNull();
    expect(result?.summary).toBe('40% to play if he plays.');
  });

  it('nulls prob_active when the run emitted no probability for him', () => {
    // act
    const result = pivotPredictionRows([row({ stat: 'ast', value: 5 })]);

    // assert
    expect(result?.prob_active).toBeNull();
    expect(result?.summary).toBeNull();
  });

  it('ignores a row whose value is not a number', () => {
    // arrange — value is NOT NULL in the schema, but the pivot must not trust it
    const rows = [
      row({ stat: 'reb', value: 'n/a' }),
      row({ stat: 'ast', value: 5 }),
    ];

    // act
    const result = pivotPredictionRows(rows);

    // assert
    expect(result?.projected.reb).toBeNull();
    expect(result?.projected.ast).toBe(5);
  });

  it('returns null when the run timestamp is unreadable', () => {
    // arrange — an object with no valid as_of cannot claim a projection time
    const result = pivotPredictionRows([row({ predicted_at: 'not a date' })]);

    // assert
    expect(result).toBeNull();
  });

  it('summarises the numbers it has without inventing the ones it does not', () => {
    // arrange — minutes but no points
    const rows = [
      row({ stat: 'prob_active', value: 0.55, conditional: false }),
      row({ stat: 'minutes', quantile: 0.1, value: 12 }),
      row({ stat: 'minutes', quantile: 0.5, value: 18 }),
      row({ stat: 'minutes', quantile: 0.9, value: 25 }),
    ];

    // act
    const result = pivotPredictionRows(rows);

    // assert
    expect(result?.summary).toBe('55% to play, 18.0 min (12.0-25.0) if he plays.');
  });
});
