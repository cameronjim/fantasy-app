import { describe, it, expect } from 'vitest';
import {
  DEVIATION_STATS,
  DEVIATION_WEIGHTS,
  HOT_STREAK_STDDEV_MULTIPLE,
  IMPACT_PERCENTILE_FLOOR,
  REASON_CODES,
  RETURN_GAP_DAYS,
  RETURN_GAP_MAX_DAYS,
  RETURN_MIN_PROB_ACTIVE,
  ROLE_INCREASE_MIN_DELTA,
  SHOT_VOLUME_SURGE_FGA_DELTA,
  TEAMMATE_ABSENCE_MAX_PROB_ACTIVE,
  TEAMMATE_ABSENCE_MIN_MINUTES,
  UPSIDE_DRIVERS_SHOWN,
  WATCHLIST_LIMIT,
  deviationScales,
  evidenceFor,
  findAbsentTeammate,
  hasRoleIncrease,
  hasShotVolumeSurge,
  isHotStreak,
  isReturningFromAbsence,
  opponentOf,
  rankCandidates,
  reasonsFor,
  relevanceFor,
  scoreCandidates,
  upsideOf,
  upsideScores,
  watchlistScore,
  type DeviationStat,
  type WatchlistCandidate,
} from '../../src/services/watchlist.js';

function candidate(overrides: Partial<WatchlistCandidate> = {}): WatchlistCandidate {
  return {
    nba_player_id: '1001',
    name: 'Test Candidate',
    name_is_placeholder: false,
    team_abbr: 'LAL',
    opponent_team_abbr: 'GSW',
    nba_game_id: '0022500555',
    game_date: '2026-02-04',
    prob_active: 0.9,
    impact: 1,
    proj_pts_uncond: 14,
    baseline_games: 15,
    deltas: {},
    minutes: { usual: null, projected: null, delta: null },
    points: { usual: null, projected: null, delta: null },
    shots: { usual: null, projected: null, delta: null },
    days_since_played: null,
    last_played_date: null,
    pts_recent: null,
    pts_sd: null,
    teammate_out: null,
    ...overrides,
  };
}

/** A candidate whose minutes jumped, with the deltas and the pair in agreement. */
function jumper(
  id: string,
  usualMin: number,
  projMin: number,
  impact: number,
  overrides: Partial<WatchlistCandidate> = {}
): WatchlistCandidate {
  return candidate({
    nba_player_id: id,
    name: `Player ${id}`,
    impact,
    deltas: { minutes: projMin - usualMin },
    minutes: { usual: usualMin, projected: projMin, delta: projMin - usualMin },
    ...overrides,
  });
}

describe('deviationScales', () => {
  it('measures each stat in the spread of that stat across the pool', () => {
    // arrange — minutes vary by 2, points by 4
    const pool = [
      { minutes: -2, pts: -4 },
      { minutes: 2, pts: 4 },
    ];

    // act
    const scales = deviationScales(pool);

    // assert
    expect(scales.get('minutes')).toBe(2);
    expect(scales.get('pts')).toBe(4);
  });

  it('omits a stat nobody in the pool has a deviation for', () => {
    // act — the January run projects minutes/pts/ast and nothing else
    const scales = deviationScales([{ minutes: 3 }, { minutes: -1 }]);

    // assert
    expect(scales.has('minutes')).toBe(true);
    expect(scales.has('blk')).toBe(false);
  });
});

describe('upsideOf', () => {
  it('is positive only when the projection is above the baseline', () => {
    // arrange
    const scales = new Map<DeviationStat, number>([['minutes', 4]]);

    // act + assert — the sign survives because the pool mean is NOT subtracted
    expect(upsideOf({ minutes: 8 }, scales).upside).toBe(2);
    expect(upsideOf({ minutes: -8 }, scales).upside).toBe(-2);
    expect(upsideOf({ minutes: 0 }, scales).upside).toBe(0);
  });

  it('weights minutes above points, because minutes are the mechanism', () => {
    // arrange — the same scaled deviation in each stat, one at a time
    const scales = new Map<DeviationStat, number>([
      ['minutes', 1],
      ['pts', 1],
    ]);

    // act
    const fromMinutes = upsideOf({ minutes: 1, pts: 0 }, scales).upside as number;
    const fromPoints = upsideOf({ minutes: 0, pts: 1 }, scales).upside as number;

    // assert
    expect(fromMinutes).toBeGreaterThan(fromPoints);
    expect(DEVIATION_WEIGHTS.minutes).toBeGreaterThan(DEVIATION_WEIGHTS.pts);
  });

  it('averages rather than sums, so a wider run does not score higher', () => {
    // arrange — every stat one scaled unit up
    const two = new Map<DeviationStat, number>([
      ['minutes', 1],
      ['pts', 1],
    ]);
    const all = new Map<DeviationStat, number>(DEVIATION_STATS.map((stat) => [stat, 1]));
    const deltas = Object.fromEntries(DEVIATION_STATS.map((stat) => [stat, 1]));

    // act + assert — both are 1.0, not 2 and 7
    expect(upsideOf(deltas, two).upside).toBe(1);
    expect(upsideOf(deltas, all).upside).toBe(1);
  });

  it('reports the deviations that point up, biggest contribution first', () => {
    // arrange
    const scales = new Map<DeviationStat, number>([
      ['minutes', 1],
      ['pts', 1],
      ['reb', 1],
    ]);

    // act
    const { drivers } = upsideOf({ minutes: 1, pts: 3, reb: -2 }, scales);

    // assert — points contributes 1.5 x 3, minutes 2 x 1; rebounds points down
    expect(drivers.map((d) => d.stat)).toEqual(['pts', 'minutes']);
    expect(drivers[0]).toEqual({ stat: 'pts', delta: 3, scaled: 3 });
  });

  it('lets a row explain a positive score whose minutes and points are flat', () => {
    // arrange — this is the case a cold-start run produces, and the case that
    // reads as a self-contradiction without the drivers
    const scales = new Map<DeviationStat, number>([
      ['minutes', 1],
      ['pts', 1],
      ['stl', 1],
      ['blk', 1],
    ]);

    // act
    const { upside, drivers } = upsideOf({ minutes: -0.2, pts: -0.1, stl: 1, blk: 1 }, scales);

    // assert
    expect(upside as number).toBeGreaterThan(0);
    expect(drivers.map((d) => d.stat)).toEqual(['stl', 'blk']);
  });

  it('contributes zero for a stat the whole pool deviates on identically', () => {
    // arrange — a zero scale would otherwise divide to Infinity
    const scales = new Map<DeviationStat, number>([['minutes', 0]]);

    // act + assert
    expect(upsideOf({ minutes: 5 }, scales).upside).toBe(0);
  });

  it('is null when there is no deviation at all to score', () => {
    // act + assert — no baseline means unknown, and unknown never ranks
    expect(upsideOf({}, new Map([['minutes', 3]])).upside).toBeNull();
    expect(upsideOf({ minutes: 3 }, new Map()).upside).toBeNull();
  });
});

describe('upsideScores', () => {
  it('scores a pool against its own spread, in input order', () => {
    // act
    const scores = upsideScores([{ minutes: -2 }, { minutes: 2 }]);

    // assert
    expect(scores).toEqual([-1, 1]);
  });

  it('returns nothing for an empty pool', () => {
    // act + assert
    expect(upsideScores([])).toEqual([]);
  });
});

describe('relevanceFor', () => {
  const pool = Array.from({ length: 100 }, (_, i) => i);

  it('is exactly zero at and below the floor', () => {
    // act + assert — the floor is a hard gate, not a soft discount
    expect(relevanceFor(0, pool)).toBe(0);
    expect(relevanceFor(IMPACT_PERCENTILE_FLOOR - 10, pool)).toBe(0);
  });

  it('ramps to one at the top of the pool', () => {
    // act
    const best = relevanceFor(99, pool) as number;

    // assert
    expect(best).toBeGreaterThan(0.9);
    expect(best).toBeLessThanOrEqual(1);
  });

  it('rises with the impact percentile', () => {
    // act
    const good = relevanceFor(90, pool) as number;
    const better = relevanceFor(95, pool) as number;

    // assert
    expect(better).toBeGreaterThan(good);
  });

  it('is null when the run has no impact score for him', () => {
    // act + assert — nothing to clear the floor with is unknown, not bad
    expect(relevanceFor(null, pool)).toBeNull();
  });
});

describe('watchlistScore', () => {
  it('multiplies the two terms', () => {
    // act + assert
    expect(watchlistScore(2, 0.5)).toBe(1);
  });

  it('clamps a projection below the baseline to zero rather than going negative', () => {
    // act + assert
    expect(watchlistScore(-3, 0.9)).toBe(0);
  });

  it('zeroes out a huge jump that clears no absolute floor', () => {
    // act + assert — this is the binding product constraint, in one line
    expect(watchlistScore(5, 0)).toBe(0);
  });

  it('is null when either factor is unknown', () => {
    // act + assert
    expect(watchlistScore(null, 0.5)).toBeNull();
    expect(watchlistScore(2, null)).toBeNull();
  });
});

describe('hasRoleIncrease', () => {
  it('fires exactly at the threshold', () => {
    // act + assert
    expect(hasRoleIncrease(ROLE_INCREASE_MIN_DELTA)).toBe(true);
  });

  it('stays quiet just below it, and on a minutes drop', () => {
    // act + assert
    expect(hasRoleIncrease(ROLE_INCREASE_MIN_DELTA - 0.1)).toBe(false);
    expect(hasRoleIncrease(-8)).toBe(false);
  });

  it('needs a measurable deviation', () => {
    // act + assert
    expect(hasRoleIncrease(null)).toBe(false);
  });
});

describe('hasShotVolumeSurge', () => {
  it('fires exactly at the threshold', () => {
    // act + assert
    expect(hasShotVolumeSurge(SHOT_VOLUME_SURGE_FGA_DELTA)).toBe(true);
    expect(hasShotVolumeSurge(SHOT_VOLUME_SURGE_FGA_DELTA - 0.1)).toBe(false);
  });

  it('needs a measurable deviation', () => {
    // act + assert
    expect(hasShotVolumeSurge(null)).toBe(false);
  });
});

describe('isReturningFromAbsence', () => {
  it('fires on a gap at the threshold when he is expected to play', () => {
    // act + assert
    expect(isReturningFromAbsence(RETURN_GAP_DAYS, 0.95)).toBe(true);
  });

  it('ignores a shorter gap, which is just a rest day', () => {
    // act + assert
    expect(isReturningFromAbsence(RETURN_GAP_DAYS - 1, 0.95)).toBe(false);
  });

  it('ignores an offseason — every player would fire on opening night', () => {
    // act + assert
    expect(isReturningFromAbsence(RETURN_GAP_MAX_DAYS + 1, 0.95)).toBe(false);
    expect(isReturningFromAbsence(190, 0.95)).toBe(false);
  });

  it('does not call a player who is still out a returning player', () => {
    // act + assert
    expect(isReturningFromAbsence(21, RETURN_MIN_PROB_ACTIVE - 0.01)).toBe(false);
    expect(isReturningFromAbsence(21, null)).toBe(false);
  });

  it('needs a measurable gap', () => {
    // act + assert
    expect(isReturningFromAbsence(null, 0.95)).toBe(false);
  });
});

describe('isHotStreak', () => {
  it('fires when recent scoring beats the baseline by the stddev multiple', () => {
    // arrange — sd 4, so the bar is +6
    // act + assert
    expect(isHotStreak(20, 14, 4)).toBe(true);
    expect(isHotStreak(19.9, 14, 4)).toBe(false);
  });

  it('scales the bar by the player, not by a fixed point total', () => {
    // arrange — the same +5 swing, different volatility
    // act + assert
    expect(isHotStreak(19, 14, 2)).toBe(true);
    expect(isHotStreak(19, 14, 10)).toBe(false);
    expect(HOT_STREAK_STDDEV_MULTIPLE).toBe(1.5);
  });

  it('never fires with no volatility to scale by, or on a cold stretch', () => {
    // act + assert
    expect(isHotStreak(20, 14, 0)).toBe(false);
    expect(isHotStreak(20, 14, null)).toBe(false);
    expect(isHotStreak(8, 14, 3)).toBe(false);
  });
});

describe('findAbsentTeammate', () => {
  const mate = (name: string, minutes: number | null, prob: number | null) => ({
    name,
    usual_minutes: minutes,
    prob_active: prob,
  });

  it('returns a rotation teammate the run does not expect to play', () => {
    // act
    const found = findAbsentTeammate([
      mate('Star Guard', TEAMMATE_ABSENCE_MIN_MINUTES, TEAMMATE_ABSENCE_MAX_PROB_ACTIVE),
    ]);

    // assert
    expect(found).toEqual({
      name: 'Star Guard',
      usual_minutes: TEAMMATE_ABSENCE_MIN_MINUTES,
      prob_active: TEAMMATE_ABSENCE_MAX_PROB_ACTIVE,
    });
  });

  it('ignores a low-minutes teammate whose absence opens nothing', () => {
    // act + assert
    expect(findAbsentTeammate([mate('Deep Bench', 12, 0.05)])).toBeNull();
  });

  it('ignores a teammate the run still expects on the floor', () => {
    // act + assert — a coin-flip availability is not an opening
    expect(
      findAbsentTeammate([mate('Star Guard', 34, TEAMMATE_ABSENCE_MAX_PROB_ACTIVE + 0.01)])
    ).toBeNull();
    expect(findAbsentTeammate([mate('Star Guard', 34, null)])).toBeNull();
  });

  it('picks the highest-minutes absence, which is the usage actually freed', () => {
    // act
    const found = findAbsentTeammate([mate('Third Option', 29, 0.1), mate('Franchise', 36, 0.1)]);

    // assert
    expect(found?.name).toBe('Franchise');
  });

  it('finds nobody on a slate with no injury news', () => {
    // act + assert — a preseason run has no absences, and that is an answer
    expect(findAbsentTeammate([mate('Star Guard', 34, 0.92), mate('Wing', 30, 0.88)])).toBeNull();
  });
});

describe('reasonsFor', () => {
  it('returns nothing for a player whose situation is unchanged', () => {
    // act + assert
    expect(
      reasonsFor(
        candidate({
          minutes: { usual: 24, projected: 24, delta: 0 },
          shots: { usual: 9, projected: 9, delta: 0 },
        })
      )
    ).toEqual([]);
  });

  it('stacks every rule that fires, in code order', () => {
    // arrange
    const stacked = candidate({
      minutes: { usual: 22, projected: 31, delta: 9 },
      shots: { usual: 9, projected: 13, delta: 4 },
      points: { usual: 12, projected: 19, delta: 7 },
      days_since_played: 9,
      prob_active: 0.95,
      pts_recent: 20,
      pts_sd: 4,
      teammate_out: { name: 'Star Guard', usual_minutes: 34, prob_active: 0.1 },
    });

    // act + assert
    expect(reasonsFor(stacked)).toEqual([...REASON_CODES]);
  });
});

describe('evidenceFor', () => {
  it('reports the numbers behind the reasons that fired, and nothing else', () => {
    // arrange — a shot surge and a hot streak, no absence and no return
    const c = candidate({
      shots: { usual: 9.14, projected: 13.2, delta: 4.06 },
      points: { usual: 12, projected: 14, delta: 2 },
      pts_recent: 18,
      pts_sd: 3,
    });
    const reasons = reasonsFor(c);

    // act
    const evidence = evidenceFor(c, reasons);

    // assert
    expect(reasons).toEqual(['SHOT_VOLUME_SURGE', 'HOT_STREAK']);
    expect(evidence).toEqual({
      fga_usual: 9.1,
      fga_projected: 13.2,
      fga_delta: 4.1,
      pts_recent: 18,
      pts_sd: 3,
      pts_recent_delta: 6,
    });
    expect(evidence.teammate_out).toBeUndefined();
    expect(evidence.days_since_played).toBeUndefined();
  });

  it('names the absent teammate and the minutes his absence frees', () => {
    // arrange
    const c = candidate({
      teammate_out: { name: 'Franchise Player', usual_minutes: 34.62, prob_active: 0.1234 },
    });

    // act
    const evidence = evidenceFor(c, reasonsFor(c));

    // assert
    expect(evidence).toEqual({
      teammate_out: 'Franchise Player',
      teammate_out_minutes: 34.6,
      teammate_out_prob_active: 0.123,
    });
  });

  it('carries the return date alongside the gap', () => {
    // arrange
    const c = candidate({
      days_since_played: 12,
      last_played_date: '2026-01-23',
      prob_active: 0.9,
    });

    // act
    const evidence = evidenceFor(c, reasonsFor(c));

    // assert
    expect(evidence).toEqual({ days_since_played: 12, last_played_date: '2026-01-23' });
  });
});

describe('opponentOf', () => {
  it('names the other side of the game', () => {
    // act + assert
    expect(opponentOf('LAL', ['LAL', 'GSW'])).toBe('GSW');
    expect(opponentOf('GSW', ['LAL', 'GSW'])).toBe('LAL');
  });

  it('is null when the team is not in the game, or either side is unknown', () => {
    // act + assert — a stale roster row must not invent an opponent
    expect(opponentOf('BOS', ['LAL', 'GSW'])).toBeNull();
    expect(opponentOf(null, ['LAL', 'GSW'])).toBeNull();
    expect(opponentOf('LAL', undefined)).toBeNull();
  });
});

describe('scoreCandidates', () => {
  it('scores every candidate without filtering, in input order', () => {
    // arrange — one would be dropped from the ranking, one would not
    const pool = [jumper('1', 22, 31, 5), jumper('2', 22, 18, -5)];

    // act
    const scored = scoreCandidates(pool);

    // assert — the harness needs the whole universe as its denominator
    expect(scored).toHaveLength(2);
    expect(scored.map((s) => s.candidate.nba_player_id)).toEqual(['1', '2']);
    expect(scored[1].score).toBe(0);
  });
});

describe('rankCandidates', () => {
  /**
   * A realistic pool for the impact percentiles to be measured against: a run
   * projects every rostered player, so most of the pool is bench-level impact
   * spread over a wide range, and nobody in it deviates from his own baseline.
   */
  function filler(count: number, lo = -3, hi = 3): WatchlistCandidate[] {
    return Array.from({ length: count }, (_, i) =>
      jumper(`f${i}`, 10, 10, lo + ((hi - lo) * i) / Math.max(1, count - 1), {
        deltas: { minutes: 0 },
      })
    );
  }

  it('keeps a rotation player stepping into starter minutes above a bench jump', () => {
    // arrange — the binding constraint, stated as the product requires it. The
    // scrub's relative jump is far larger; his absolute impact is far worse.
    const scrub = jumper('scrub', 5, 15, -2);
    const rotation = jumper('rotation', 24, 32, 4);

    // act
    const ranked = rankCandidates([scrub, rotation, ...filler(100)]);

    // assert
    expect(ranked[0].nba_player_id).toBe('rotation');
    expect(ranked.map((p) => p.nba_player_id)).not.toContain('scrub');
  });

  it('drops a player projected below his own usual, however good he is', () => {
    // arrange — a star having an ordinary night is the Projections tab's job
    const star = jumper('star', 36, 33, 9);

    // act
    const ranked = rankCandidates([star, ...filler(100)]);

    // assert
    expect(ranked.map((p) => p.nba_player_id)).not.toContain('star');
  });

  it('drops a player the run has no impact score for', () => {
    // arrange
    const unscored = jumper('unscored', 22, 31, 0);

    // act
    const ranked = rankCandidates([{ ...unscored, impact: null }, ...filler(100)]);

    // assert
    expect(ranked).toHaveLength(0);
  });

  it('drops a player with no deviation to score at all', () => {
    // arrange — no baseline reached the candidate, so there are no deltas
    const noBaseline = candidate({ nba_player_id: 'nb', impact: 9, deltas: {} });

    // act
    const ranked = rankCandidates([noBaseline, ...filler(100)]);

    // assert
    expect(ranked.map((p) => p.nba_player_id)).not.toContain('nb');
  });

  it('carries the deltas, the two factors and the reason codes on every row', () => {
    // arrange
    const stepping = jumper('rotation', 22, 31, 6, {
      points: { usual: 11.6, projected: 20, delta: 8.4 },
      deltas: { minutes: 9, pts: 8.4 },
    });

    // act
    const [row] = rankCandidates([stepping, ...filler(100)]);

    // assert
    expect(row.minutes).toEqual({ usual: 22, projected: 31, delta: 9 });
    expect(row.points).toEqual({ usual: 11.6, projected: 20, delta: 8.4 });
    expect(row.reasons).toContain('ROLE_INCREASE');
    expect(row.score).toBeCloseTo(row.upside * row.relevance, 3);
    expect(row.impact_percentile).toBeGreaterThan(0);
    expect(row.drivers.length).toBeLessThanOrEqual(UPSIDE_DRIVERS_SHOWN);
    expect(row.opponent_team_abbr).toBe('GSW');
    expect(row.game_date).toBe('2026-02-04');
  });

  it('orders by score, and lets a named player win a tie against a placeholder', () => {
    // arrange — identical numbers, one of them unidentified
    const named = jumper('named', 22, 31, 5, { name: 'Aaa Named' });
    const placeholder = jumper('ph', 22, 31, 5, {
      name: 'NBA #99 (new roster)',
      name_is_placeholder: true,
    });

    // act
    const ranked = rankCandidates([placeholder, named, ...filler(100)]);

    // assert
    expect(ranked[0].nba_player_id).toBe('named');
  });

  it('caps the list at the published limit, and respects an explicit one', () => {
    // arrange — 25 qualifying candidates with descending impact
    const many = Array.from({ length: 25 }, (_, i) => jumper(`p${i}`, 22, 31, 5 + i * 0.1));

    // act + assert
    expect(rankCandidates([...many, ...filler(100)])).toHaveLength(WATCHLIST_LIMIT);
    expect(rankCandidates([...many, ...filler(100)], 3)).toHaveLength(3);
  });

  it('returns an empty list when nothing clears both terms', () => {
    // act + assert — a quiet night is an answer, not a bug
    expect(rankCandidates(filler(100))).toEqual([]);
  });
});
