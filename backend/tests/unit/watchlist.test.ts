import { describe, it, expect } from 'vitest';
import {
  HOT_STREAK_STDDEV_MULTIPLE,
  REASON_CODES,
  REASON_WEIGHTS,
  RETURN_GAP_DAYS,
  ROLE_INCREASE_MIN_DELTA,
  SHOT_VOLUME_SURGE_FGA_DELTA,
  STAR_EXCLUSION_PPG,
  TEAMMATE_ABSENCE_MIN_MINUTES,
  WATCHLIST_LIMIT,
  dayGap,
  evidenceFor,
  findAbsentTeammate,
  hasRoleIncrease,
  hasShotVolumeSurge,
  isDiscoveryCandidate,
  isHotStreak,
  isReturningFromAbsence,
  rankCandidates,
  reasonsFor,
  scoreFor,
  type WatchlistCandidate,
} from '../../src/services/watchlist.js';

function candidate(overrides: Partial<WatchlistCandidate> = {}): WatchlistCandidate {
  return {
    nba_player_id: '1001',
    name: 'Test Candidate',
    team_abbr: 'LAL',
    season_ppg: 9.4,
    min_r5: null,
    min_r15: null,
    fga_r5: null,
    fga_r15: null,
    pts_r5: null,
    pts_season: null,
    pts_stddev: null,
    gap_days: null,
    played_last_game: false,
    last_game_date: null,
    teammate_out: null,
    prob_active: null,
    ...overrides,
  };
}

describe('hasRoleIncrease', () => {
  it('fires exactly at the threshold', () => {
    // act + assert
    expect(hasRoleIncrease(24 + ROLE_INCREASE_MIN_DELTA, 24)).toBe(true);
  });

  it('stays quiet just below the threshold', () => {
    // act + assert
    expect(hasRoleIncrease(27.9, 24)).toBe(false);
  });

  it('never fires on a minutes drop', () => {
    // act + assert
    expect(hasRoleIncrease(18, 26)).toBe(false);
  });

  it('needs both windows — a player with no 15-game baseline has no trend', () => {
    // act + assert
    expect(hasRoleIncrease(30, null)).toBe(false);
    expect(hasRoleIncrease(null, 20)).toBe(false);
  });
});

describe('hasShotVolumeSurge', () => {
  it('fires exactly at the threshold', () => {
    // act + assert
    expect(hasShotVolumeSurge(8 + SHOT_VOLUME_SURGE_FGA_DELTA, 8)).toBe(true);
  });

  it('stays quiet just below the threshold', () => {
    // act + assert
    expect(hasShotVolumeSurge(10.4, 8)).toBe(false);
  });

  it('needs both windows', () => {
    // act + assert
    expect(hasShotVolumeSurge(12, null)).toBe(false);
    expect(hasShotVolumeSurge(null, 6)).toBe(false);
  });
});

describe('isReturningFromAbsence', () => {
  it('fires on a gap at the threshold followed by an appearance', () => {
    // act + assert
    expect(isReturningFromAbsence(RETURN_GAP_DAYS, true)).toBe(true);
  });

  it('ignores a shorter gap, which is just a rest day', () => {
    // act + assert
    expect(isReturningFromAbsence(6, true)).toBe(false);
  });

  it('does not fire for a player who is still out', () => {
    // arrange — the gap is long but the most recent game was a DNP
    // act + assert
    expect(isReturningFromAbsence(21, false)).toBe(false);
  });

  it('needs a measurable gap', () => {
    // act + assert
    expect(isReturningFromAbsence(null, true)).toBe(false);
  });
});

describe('isHotStreak', () => {
  it('fires when the last-5 beats the season by the stddev multiple', () => {
    // arrange — sd 4, so the bar is +6
    // act + assert
    expect(isHotStreak(20, 14, 4)).toBe(true);
    expect(isHotStreak(19.9, 14, 4)).toBe(false);
  });

  it('scales the bar by the player, not by a fixed point total', () => {
    // arrange — same +5 swing, different volatility
    const steady = isHotStreak(19, 14, 2);
    const volatile = isHotStreak(19, 14, 10);

    // assert
    expect(steady).toBe(true);
    expect(volatile).toBe(false);
    expect(HOT_STREAK_STDDEV_MULTIPLE).toBe(1.5);
  });

  it('never fires with no volatility to scale by', () => {
    // act + assert — a zero stddev would make every positive delta "hot"
    expect(isHotStreak(20, 14, 0)).toBe(false);
    expect(isHotStreak(20, 14, null)).toBe(false);
  });

  it('never fires on a cold stretch', () => {
    // act + assert
    expect(isHotStreak(8, 14, 3)).toBe(false);
  });
});

describe('findAbsentTeammate', () => {
  const mate = (
    name: string,
    minutes: number | null,
    status: string | null
  ): { name: string; minutes_per_game: number | null; injury_status: string | null } => ({
    name,
    minutes_per_game: minutes,
    injury_status: status,
  });

  it('returns a ruled-out rotation teammate', () => {
    // act
    const found = findAbsentTeammate([mate('Star Guard', TEAMMATE_ABSENCE_MIN_MINUTES, 'Out')]);

    // assert
    expect(found).toEqual({ name: 'Star Guard', minutes_per_game: 28 });
  });

  it('ignores a low-minutes teammate whose absence opens nothing', () => {
    // act + assert
    expect(findAbsentTeammate([mate('Deep Bench', 12, 'Out')])).toBeNull();
  });

  it('ignores statuses short of Out — questionable is not an opening', () => {
    // act + assert
    expect(findAbsentTeammate([mate('Star Guard', 34, 'Day-To-Day')])).toBeNull();
    expect(findAbsentTeammate([mate('Star Guard', 34, null)])).toBeNull();
  });

  it('picks the highest-minutes absence, which is the usage actually freed', () => {
    // act
    const found = findAbsentTeammate([
      mate('Third Option', 29, 'Out'),
      mate('Franchise Player', 36, 'Out'),
    ]);

    // assert
    expect(found?.name).toBe('Franchise Player');
  });
});

describe('isDiscoveryCandidate', () => {
  it('excludes established scorers at the cutoff', () => {
    // act + assert
    expect(isDiscoveryCandidate(STAR_EXCLUSION_PPG)).toBe(false);
    expect(isDiscoveryCandidate(19.9)).toBe(true);
  });

  it('keeps a player with no season line — that is the rookie case', () => {
    // act + assert
    expect(isDiscoveryCandidate(null)).toBe(true);
  });
});

describe('reasonsFor', () => {
  it('returns nothing for a player whose situation is unchanged', () => {
    // act + assert
    expect(reasonsFor(candidate({ min_r5: 20, min_r15: 20, fga_r5: 8, fga_r15: 8 }))).toEqual([]);
  });

  it('stacks every rule that fires, in code order', () => {
    // arrange
    const stacked = candidate({
      min_r5: 30,
      min_r15: 20,
      fga_r5: 12,
      fga_r15: 8,
      pts_r5: 20,
      pts_season: 12,
      pts_stddev: 4,
      gap_days: 9,
      played_last_game: true,
      teammate_out: { name: 'Star Guard', minutes_per_game: 34 },
    });

    // act + assert
    expect(reasonsFor(stacked)).toEqual([...REASON_CODES]);
  });
});

describe('evidenceFor', () => {
  it('reports the numbers behind the reasons that fired, and nothing else', () => {
    // arrange
    const c = candidate({
      min_r5: 30.24,
      min_r15: 20.1,
      pts_r5: 18,
      pts_season: 12,
      pts_stddev: 3,
    });
    const reasons = reasonsFor(c);

    // act
    const evidence = evidenceFor(c, reasons);

    // assert
    expect(reasons).toEqual(['ROLE_INCREASE', 'HOT_STREAK']);
    expect(evidence).toEqual({
      min_r5: 30.2,
      min_r15: 20.1,
      min_delta: 10.1,
      pts_r5: 18,
      pts_season: 12,
      pts_stddev: 3,
      pts_delta: 6,
    });
    expect(evidence.fga_delta).toBeUndefined();
    expect(evidence.teammate_out).toBeUndefined();
  });

  it('carries the return date alongside the gap', () => {
    // arrange
    const c = candidate({ gap_days: 12, played_last_game: true, last_game_date: '2026-02-03' });

    // act
    const evidence = evidenceFor(c, reasonsFor(c));

    // assert
    expect(evidence).toEqual({ gap_days: 12, last_game_date: '2026-02-03' });
  });
});

describe('scoreFor', () => {
  it('sums the reason weights when no prediction run exists', () => {
    // act + assert
    expect(scoreFor(['ROLE_INCREASE', 'HOT_STREAK'], null)).toBe(
      REASON_WEIGHTS.ROLE_INCREASE + REASON_WEIGHTS.HOT_STREAK
    );
  });

  it('discounts by the probability the player actually suits up', () => {
    // act + assert
    expect(scoreFor(['ROLE_INCREASE'], 0.5)).toBe(1.5);
  });

  it('clamps a malformed probability into [0, 1]', () => {
    // act + assert — a bad prediction row must never outrank the rules
    expect(scoreFor(['ROLE_INCREASE'], 4)).toBe(REASON_WEIGHTS.ROLE_INCREASE);
    expect(scoreFor(['ROLE_INCREASE'], -2)).toBe(0);
  });

  it('scores an empty reason list at zero', () => {
    // act + assert
    expect(scoreFor([], 0.9)).toBe(0);
  });

  it('weights opportunity above a hot streak', () => {
    // act + assert — minutes already granted beat points that may not repeat
    expect(REASON_WEIGHTS.ROLE_INCREASE).toBeGreaterThan(REASON_WEIGHTS.HOT_STREAK);
  });
});

describe('rankCandidates', () => {
  it('drops players with no reason at all', () => {
    // act
    const ranked = rankCandidates([candidate({ min_r5: 20, min_r15: 20 })]);

    // assert
    expect(ranked).toEqual([]);
  });

  it('drops established scorers even when every rule fires', () => {
    // arrange
    const star = candidate({
      name: 'Established Star',
      season_ppg: 27.5,
      min_r5: 36,
      min_r15: 30,
      pts_r5: 34,
      pts_season: 27.5,
      pts_stddev: 4,
    });

    // act + assert
    expect(rankCandidates([star])).toEqual([]);
  });

  it('orders by score, then reason count, then name', () => {
    // arrange
    const roleOnly = candidate({ nba_player_id: '1', name: 'A Role', min_r5: 30, min_r15: 20 });
    const hotOnly = candidate({
      nba_player_id: '2',
      name: 'B Hot',
      pts_r5: 20,
      pts_season: 12,
      pts_stddev: 4,
    });
    const both = candidate({
      nba_player_id: '3',
      name: 'C Both',
      min_r5: 30,
      min_r15: 20,
      pts_r5: 20,
      pts_season: 12,
      pts_stddev: 4,
    });

    // act
    const ranked = rankCandidates([hotOnly, roleOnly, both]);

    // assert
    expect(ranked.map((p) => p.name)).toEqual(['C Both', 'A Role', 'B Hot']);
    expect(ranked[0].score).toBe(REASON_WEIGHTS.ROLE_INCREASE + REASON_WEIGHTS.HOT_STREAK);
  });

  it('lets availability reorder two players with identical reasons', () => {
    // arrange
    const likely = candidate({
      nba_player_id: '1',
      name: 'Likely Starter',
      min_r5: 30,
      min_r15: 20,
      prob_active: 0.95,
    });
    const doubtful = candidate({
      nba_player_id: '2',
      name: 'Doubtful Starter',
      min_r5: 30,
      min_r15: 20,
      prob_active: 0.2,
    });

    // act
    const ranked = rankCandidates([doubtful, likely]);

    // assert
    expect(ranked.map((p) => p.name)).toEqual(['Likely Starter', 'Doubtful Starter']);
    expect(ranked[0].prob_active).toBe(0.95);
  });

  it('caps the list at the published limit', () => {
    // arrange — 25 identical qualifying candidates
    const many = Array.from({ length: 25 }, (_, i) =>
      candidate({
        nba_player_id: String(i),
        name: `Player ${String(i).padStart(2, '0')}`,
        min_r5: 30,
        min_r15: 20,
      })
    );

    // act
    const ranked = rankCandidates(many);

    // assert
    expect(ranked).toHaveLength(WATCHLIST_LIMIT);
  });

  it('respects an explicit limit', () => {
    // arrange
    const many = Array.from({ length: 5 }, (_, i) =>
      candidate({ nba_player_id: String(i), name: `P${i}`, min_r5: 30, min_r15: 20 })
    );

    // act + assert
    expect(rankCandidates(many, 2)).toHaveLength(2);
  });
});

describe('dayGap', () => {
  it('counts whole days between two calendar days', () => {
    // act + assert
    expect(dayGap('2026-02-10', '2026-02-01')).toBe(9);
  });

  it('spans a month boundary', () => {
    // act + assert
    expect(dayGap('2026-03-02', '2026-02-25')).toBe(5);
  });

  it('is null when either day is missing or unparseable', () => {
    // act + assert
    expect(dayGap('2026-02-10', null)).toBeNull();
    expect(dayGap(null, '2026-02-01')).toBeNull();
    expect(dayGap('not-a-day', '2026-02-01')).toBeNull();
  });
});
