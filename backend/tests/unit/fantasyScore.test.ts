import { describe, it, expect } from 'vitest';
import {
  fantasyPoints,
  scorePlayer,
  zScoreRank,
  MIN_GAMES_FOR_RANK,
  MIN_MIN_FOR_RANK,
  NBA_STANDARD,
  FANDUEL,
  DRAFTKINGS,
  ESPN_DEFAULT,
  YAHOO_HIGH_SCORE,
  APP_LEGACY,
  SCORING_FORMATS,
  type FantasyStatLine,
  type CategoryStatLine,
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

const BENCHMARK_LINE: FantasyStatLine = {
  points_per_game: 30,
  rebounds_per_game: 10,
  assists_per_game: 8,
  steals_per_game: 2,
  blocks_per_game: 1,
  three_pointers_made: 3,
  turnovers_per_game: 4,
};

describe('fantasyPoints (default = NBA standard)', () => {
  it('uses NBA standard coefficients when no format is provided', () => {
    const fp = fantasyPoints(BENCHMARK_LINE);

    expect(fp).toBeCloseTo(59, 5);
  });

  it('returns zero for a stat line with all zeros', () => {
    expect(fantasyPoints(statLine())).toBe(0);
  });

  it('treats turnovers as a penalty under NBA standard', () => {
    const base = statLine({ points_per_game: 20 });
    const withTo = statLine({ points_per_game: 20, turnovers_per_game: 5 });

    expect(fantasyPoints(withTo)).toBe(fantasyPoints(base) - 5);
  });

  it('weights steals and blocks at 3x under NBA standard', () => {
    expect(fantasyPoints(statLine({ steals_per_game: 1 }))).toBe(3);
    expect(fantasyPoints(statLine({ blocks_per_game: 1 }))).toBe(3);
  });
});

describe('fantasyPoints — preset format coverage', () => {
  it('FanDuel matches NBA standard (no 3PM bonus, no FG% penalties)', () => {
    expect(fantasyPoints(BENCHMARK_LINE, FANDUEL)).toBeCloseTo(
      fantasyPoints(BENCHMARK_LINE, NBA_STANDARD),
      5,
    );
  });

  it('DraftKings applies its lighter coefficients and the 3PM bonus', () => {
    expect(fantasyPoints(BENCHMARK_LINE, DRAFTKINGS)).toBeCloseTo(60, 5);
  });

  it('DraftKings rewards double-double and triple-double bonuses', () => {
    const withDD = fantasyPoints(BENCHMARK_LINE, DRAFTKINGS, { double_doubles_per_game: 1 });
    const withoutDD = fantasyPoints(BENCHMARK_LINE, DRAFTKINGS);

    expect(withDD - withoutDD).toBeCloseTo(1.5, 5);
  });

  it('ESPN default penalizes missed shots and rewards made shots', () => {
    const extras = {
      field_goals_made: 11,
      field_goals_attempted: 22,
      free_throws_made: 5,
      free_throws_attempted: 6,
    };

    const espn = fantasyPoints(BENCHMARK_LINE, ESPN_DEFAULT, extras);

    expect(espn).toBeCloseTo(62, 5);
  });

  it("Yahoo High Score uses whole numbers and ignores turnovers", () => {
    expect(fantasyPoints(BENCHMARK_LINE, YAHOO_HIGH_SCORE)).toBeCloseTo(65, 5);
  });

  it('App legacy format adds a +1 bonus per 3PM on top of NBA standard', () => {
    const legacy = fantasyPoints(BENCHMARK_LINE, APP_LEGACY);
    const standard = fantasyPoints(BENCHMARK_LINE, NBA_STANDARD);

    expect(legacy - standard).toBeCloseTo(3, 5);
  });

  it('exposes every preset via SCORING_FORMATS for runtime selection', () => {
    expect(Object.keys(SCORING_FORMATS)).toEqual(
      expect.arrayContaining(['nba_standard', 'fanduel', 'draftkings', 'espn', 'yahoo', 'app_legacy']),
    );
  });
});

describe('scorePlayer', () => {
  it('returns null when a player has not played the minimum games', () => {
    const rookie = {
      ...statLine({ points_per_game: 25 }),
      games_played: MIN_GAMES_FOR_RANK - 1,
      minutes_per_game: 30,
    };

    expect(scorePlayer(rookie)).toBeNull();
  });

  it('returns null when a player has not played the minimum minutes per game', () => {
    const bench = {
      ...statLine({ points_per_game: 25 }),
      games_played: 40,
      minutes_per_game: MIN_MIN_FOR_RANK - 0.1,
    };

    expect(scorePlayer(bench)).toBeNull();
  });

  it('returns the rounded score to one decimal when both thresholds are met', () => {
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

    const score = scorePlayer(starter);

    expect(score).not.toBeNull();
    expect(score).toBeCloseTo(45.8, 5);
    expect((score! * 10) % 1).toBeCloseTo(0, 5);
  });

  it('does not rank players right below the minutes threshold', () => {
    const justBelow = {
      ...statLine({ points_per_game: 30 }),
      games_played: MIN_GAMES_FOR_RANK,
      minutes_per_game: MIN_MIN_FOR_RANK - 1,
    };

    expect(scorePlayer(justBelow)).toBeNull();
  });

  it('ranks players right at the threshold boundary', () => {
    const atThreshold = {
      ...statLine({ points_per_game: 30 }),
      games_played: MIN_GAMES_FOR_RANK,
      minutes_per_game: MIN_MIN_FOR_RANK,
    };

    expect(scorePlayer(atThreshold)).toBe(30);
  });

  it('accepts a non-default scoring format', () => {
    const starter = {
      ...statLine({ points_per_game: 25, three_pointers_made: 4 }),
      games_played: 50,
      minutes_per_game: 32,
    };

    const standard = scorePlayer(starter, NBA_STANDARD);
    const yahoo = scorePlayer(starter, YAHOO_HIGH_SCORE);

    expect(standard).toBe(25);
    expect(yahoo).toBe(25);
  });
});

describe('zScoreRank (category leagues)', () => {
  function catLine(overrides: Partial<CategoryStatLine> = {}): CategoryStatLine {
    return {
      points_per_game: 20,
      rebounds_per_game: 5,
      assists_per_game: 5,
      steals_per_game: 1,
      blocks_per_game: 0.5,
      three_pointers_made: 2,
      turnovers_per_game: 2,
      field_goal_percentage: 45,
      free_throw_percentage: 80,
      ...overrides,
    };
  }

  it('returns the empty array when given no players', () => {
    expect(zScoreRank([])).toEqual([]);
  });

  it('assigns z=0 to a player who is exactly average across all categories', () => {
    const players = [catLine(), catLine(), catLine()];

    const ranked = zScoreRank(players);

    expect(ranked).toHaveLength(3);
    ranked.forEach((p) => expect(p.z_score).toBeCloseTo(0, 5));
  });

  it('flips the sign of turnovers (lower TO → higher z)', () => {
    const low = catLine({ turnovers_per_game: 1 });
    const high = catLine({ turnovers_per_game: 5 });

    const ranked = zScoreRank([low, high]);

    expect(ranked[0].z_score).toBeGreaterThan(ranked[1].z_score);
  });

  it('ranks a clear superstar above an average player', () => {
    const star = catLine({ points_per_game: 35, assists_per_game: 10, steals_per_game: 2 });
    const avg = catLine();

    const ranked = zScoreRank([star, avg]);
    const starRank = ranked.find((p) => p.points_per_game === 35);
    const avgRank = ranked.find((p) => p.points_per_game === 20);

    expect(starRank!.z_score).toBeGreaterThan(avgRank!.z_score);
  });
});
