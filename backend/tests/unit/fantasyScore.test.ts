import { describe, it, expect } from 'vitest';
import {
  fantasyPoints,
  scorePlayer,
  MIN_GAMES_FOR_RANK,
  MIN_MIN_FOR_RANK,
  type FantasyStatLine,
} from '../../src/services/fantasyScore.js';

function statLine(overrides: Partial<FantasyStatLine> = {}): FantasyStatLine {
  return {
    points_per_game: 0,
    rebounds_per_game: 0,
    assists_per_game: 0,
    steals_per_game: 0,
    blocks_per_game: 0,
    three_pointers_made: 0,
    turnovers_per_game: 0,
    ...overrides,
  };
}

describe('fantasyPoints', () => {
  it('calculates fantasy score using the standard NBA points formula', () => {
    // arrange
    const stats = statLine({
      points_per_game: 30,
      rebounds_per_game: 10,
      assists_per_game: 8,
      steals_per_game: 2,
      blocks_per_game: 1,
      three_pointers_made: 3,
      turnovers_per_game: 4,
    });

    // act
    const fp = fantasyPoints(stats);

    // assert
    // 30 + 1.2*10 + 1.5*8 + 3*2 + 3*1 + 1*3 - 1*4
    // 30 + 12 + 12 + 6 + 3 + 3 - 4 = 62
    expect(fp).toBeCloseTo(62, 5);
  });

  it('returns zero for a stat line with all zeros', () => {
    // act + assert
    expect(fantasyPoints(statLine())).toBe(0);
  });

  it('treats turnovers as a penalty', () => {
    // arrange
    const base = statLine({ points_per_game: 20 });
    const withTo = statLine({ points_per_game: 20, turnovers_per_game: 5 });

    // act
    const baseFp = fantasyPoints(base);
    const toFp = fantasyPoints(withTo);

    // assert
    expect(toFp).toBe(baseFp - 5);
  });

  it('weights steals and blocks at 3x', () => {
    // arrange
    const steals = statLine({ steals_per_game: 1 });
    const blocks = statLine({ blocks_per_game: 1 });

    // act + assert
    expect(fantasyPoints(steals)).toBe(3);
    expect(fantasyPoints(blocks)).toBe(3);
  });
});

describe('scorePlayer', () => {
  it('returns null when a player has not played the minimum games', () => {
    // arrange
    const rookie = {
      ...statLine({ points_per_game: 25 }),
      games_played: MIN_GAMES_FOR_RANK - 1,
      minutes_per_game: 30,
    };

    // act
    const score = scorePlayer(rookie);

    // assert
    expect(score).toBeNull();
  });

  it('returns null when a player has not played the minimum minutes per game', () => {
    // arrange
    const bench = {
      ...statLine({ points_per_game: 25 }),
      games_played: 40,
      minutes_per_game: MIN_MIN_FOR_RANK - 0.1,
    };

    // act
    const score = scorePlayer(bench);

    // assert
    expect(score).toBeNull();
  });

  it('returns the rounded score to one decimal when both thresholds are met', () => {
    // arrange
    const starter = {
      ...statLine({
        points_per_game: 27.3,
        rebounds_per_game: 7.2,
        assists_per_game: 5.1,
        steals_per_game: 1.0,
        blocks_per_game: 0.7,
        three_pointers_made: 2.6,
        turnovers_per_game: 2.9,
      }),
      games_played: 50,
      minutes_per_game: 34,
    };

    // act
    const score = scorePlayer(starter);

    // assert
    // 27.3 + 1.2*7.2 + 1.5*5.1 + 3*1.0 + 3*0.7 + 1*2.6 - 1*2.9
    // = 27.3 + 8.64 + 7.65 + 3 + 2.1 + 2.6 - 2.9 = 48.39 → 48.4
    expect(score).not.toBeNull();
    expect(score).toBeCloseTo(48.4, 5);
    // verify it really is rounded to one decimal place.
    expect((score! * 10) % 1).toBeCloseTo(0, 5);
  });

  it('does not rank players right below the minutes threshold', () => {
    // arrange
    const justBelow = {
      ...statLine({ points_per_game: 30 }),
      games_played: MIN_GAMES_FOR_RANK,
      minutes_per_game: MIN_MIN_FOR_RANK - 1,
    };

    // act + assert
    expect(scorePlayer(justBelow)).toBeNull();
  });

  it('ranks players right at the threshold boundary', () => {
    // arrange
    const atThreshold = {
      ...statLine({ points_per_game: 30 }),
      games_played: MIN_GAMES_FOR_RANK,
      minutes_per_game: MIN_MIN_FOR_RANK,
    };

    // act + assert
    expect(scorePlayer(atThreshold)).toBe(30);
  });
});
