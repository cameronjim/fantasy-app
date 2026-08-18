import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  IMPACT_CATEGORIES,
  PLACEHOLDER_NAME_SUFFIX,
  POINTS_UNCOND_STAT,
  PROJECTED_STATS,
  SPOTLIGHT_PER_GAME,
  TOP_PLAYERS_PER_GAME,
  categoryValues,
  impactScores,
  isMissingRelation,
  num,
  parsePredictionDate,
  poolRates,
  rankSlatePlayers,
  resolvePlayerName,
  round,
  toIsoDay,
  topImpactIds,
  uncondStat,
  type ImpactInput,
  type SlatePlayer,
} from '../../src/services/slate.js';

function player(overrides: Partial<SlatePlayer> = {}): SlatePlayer {
  return {
    nba_player_id: '1',
    name: 'Test Player',
    name_is_placeholder: false,
    team_abbr: 'LAL',
    prob_active: 0.9,
    proj_pts: 10,
    proj_min_p50: 25,
    projected: { reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2, fg3m: 1.5 },
    impact: null,
    spotlight: false,
    slate_spotlight: false,
    ...overrides,
  };
}

/** A pool entry with every projected stat present, so impact is never null. */
function input(overrides: Partial<ImpactInput> = {}): ImpactInput {
  const entry = {} as ImpactInput;
  for (const stat of PROJECTED_STATS) entry[stat] = 1;
  return { ...entry, ...overrides };
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
  it('orders by total projected impact, best first', () => {
    // act — impact leads, and it disagrees with points on purpose here: the
    // 26-point scorer is a worse night once the other eight categories count.
    const ranked = rankSlatePlayers([
      player({ nba_player_id: '1', name: 'Low', proj_pts: 8, impact: -1.2 }),
      player({ nba_player_id: '2', name: 'Volume', proj_pts: 26, impact: 1.4 }),
      player({ nba_player_id: '3', name: 'All-round', proj_pts: 17, impact: 4.8 }),
    ]);

    // assert
    expect(ranked.map((p) => p.name)).toEqual(['All-round', 'Volume', 'Low']);
  });

  it('falls back to projected points when no impact was computed', () => {
    // act — a run that emitted nothing scorable in every category
    const ranked = rankSlatePlayers([
      player({ nba_player_id: '1', name: 'Low', proj_pts: 8 }),
      player({ nba_player_id: '2', name: 'High', proj_pts: 26 }),
      player({ nba_player_id: '3', name: 'Mid', proj_pts: 17 }),
    ]);

    // assert
    expect(ranked.map((p) => p.name)).toEqual(['High', 'Mid', 'Low']);
  });

  it('sorts players without an impact score below those that have one', () => {
    // act
    const ranked = rankSlatePlayers([
      player({ nba_player_id: '1', name: 'Unscored', proj_pts: 30, impact: null }),
      player({ nba_player_id: '2', name: 'Scored', proj_pts: 4, impact: -3 }),
    ]);

    // assert — a null impact is "unknown", not "worse than every number"
    expect(ranked.map((p) => p.name)).toEqual(['Scored', 'Unscored']);
  });

  it('keeps a placeholder name below a real one at equal impact', () => {
    // act — the bug this replaces: a blank name sorted FIRST alphabetically
    const ranked = rankSlatePlayers([
      player({
        nba_player_id: '1642850',
        name: 'NBA #1642850 (new roster)',
        name_is_placeholder: true,
        impact: 2,
        proj_pts: 12,
      }),
      player({ nba_player_id: '2544', name: 'Zeb Named', impact: 2, proj_pts: 12 }),
    ]);

    // assert
    expect(ranked.map((p) => p.nba_player_id)).toEqual(['2544', '1642850']);
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
    const unsorted = [
      player({ nba_player_id: '1', name: 'Low', proj_pts: 4 }),
      player({ nba_player_id: '2', name: 'High', proj_pts: 30 }),
    ];

    // act
    rankSlatePlayers(unsorted);

    // assert
    expect(unsorted.map((p) => p.name)).toEqual(['Low', 'High']);
  });
});

describe('uncondStat', () => {
  it('names the schedule-level twin of a stat', () => {
    // act + assert — the bare name is the conditional series; this is the other
    // one, and it is a stat NAME rather than a `conditional = false` filter
    expect(uncondStat('pts')).toBe('pts_uncond');
    expect(POINTS_UNCOND_STAT).toBe('pts_uncond');
  });
});

describe('resolvePlayerName', () => {
  it('passes a real name through', () => {
    // act + assert
    expect(resolvePlayerName('LeBron James', '2544')).toEqual({
      name: 'LeBron James',
      placeholder: false,
    });
  });

  it('labels a missing name with the id rather than rendering blank', () => {
    // act — an offseason addition with no `players` row yet
    const resolved = resolvePlayerName(null, '1642850');

    // assert
    expect(resolved.placeholder).toBe(true);
    expect(resolved.name).toBe(`NBA #1642850 ${PLACEHOLDER_NAME_SUFFIX}`);
  });

  it('treats a blank or whitespace name as missing', () => {
    // act + assert — an empty string is what used to sort to the top
    expect(resolvePlayerName('', '1').name).not.toBe('');
    expect(resolvePlayerName('   ', '1').placeholder).toBe(true);
    expect(resolvePlayerName(undefined, '1').placeholder).toBe(true);
  });

  it('trims a padded name instead of calling it a placeholder', () => {
    // act + assert
    expect(resolvePlayerName('  Luka Doncic  ', '1629029')).toEqual({
      name: 'Luka Doncic',
      placeholder: false,
    });
  });
});

describe('poolRates', () => {
  it('is the pool-wide make rate, not the average of per-player rates', () => {
    // arrange — a low-volume perfect shooter cannot drag the baseline up
    const pool = [input({ fgm: 2, fga: 2 }), input({ fgm: 8, fga: 18 })];

    // act
    const rates = poolRates(pool);

    // assert
    expect(rates.fg).toBeCloseTo(10 / 20, 6);
  });

  it('has no rate to divide by when the pool never shoots', () => {
    // act + assert — every excess-makes value then equals the raw makes
    expect(poolRates([input({ fga: 0, fta: 0 })])).toEqual({ fg: 0, ft: 0 });
  });
});

describe('categoryValues', () => {
  it('scores percentages as attempt-weighted excess makes', () => {
    // arrange — 10 of 20 against a 45% pool is +1 make above baseline
    const values = categoryValues(input({ fgm: 10, fga: 20 }), { fg: 0.45, ft: 0.8 });

    // assert
    expect(values.fg).toBeCloseTo(10 - 20 * 0.45, 6);
  });

  it('has no percentage value when half of a pair is missing', () => {
    // act
    const values = categoryValues(input({ ftm: 5, fta: null }), { fg: 0.45, ft: 0.8 });

    // assert
    expect(values.ft).toBeNull();
  });

  it('covers the nine categories fantasyScore ranks on', () => {
    // act + assert
    expect(Object.keys(categoryValues(input(), { fg: 0.45, ft: 0.8 })).sort()).toEqual(
      [...IMPACT_CATEGORIES].sort()
    );
  });
});

describe('impactScores', () => {
  it('is a z-score sum, so an average night on the slate is zero', () => {
    // arrange — a symmetric pool around 20 points, everything else identical
    const pool = [input({ pts: 10 }), input({ pts: 20 }), input({ pts: 30 })];

    // act
    const scores = impactScores(pool);

    // assert
    expect(scores[1]).toBe(0);
    expect(scores[0]).toBeCloseTo(-(scores[2] as number), 6);
  });

  it('rewards production spread across categories over points alone', () => {
    // arrange — same pool, two contrasting players: a pure scorer and a
    // player who is above average in six of the nine categories
    const filler = [input({ pts: 12 }), input({ pts: 16 }), input({ pts: 20 })];
    const scorer = input({ pts: 34, reb: 1, ast: 1, stl: 1, blk: 1, fg3m: 1 });
    const allRound = input({ pts: 22, reb: 9, ast: 7, stl: 2, blk: 2, fg3m: 3 });

    // act
    const [scorerImpact, allRoundImpact] = impactScores([scorer, allRound, ...filler]);

    // assert
    expect(allRoundImpact).toBeGreaterThan(scorerImpact as number);
  });

  it('treats turnovers as a negative', () => {
    // arrange — identical players apart from turnovers
    const [careful, careless] = impactScores([input({ tov: 1 }), input({ tov: 5 })]);

    // assert
    expect(careful).toBeGreaterThan(careless as number);
  });

  it('scores nothing for a player the run only partly projected', () => {
    // act — summing a partial category set would look comparable and not be
    const [complete, partial] = impactScores([input(), input({ ast: null })]);

    // assert
    expect(complete).not.toBeNull();
    expect(partial).toBeNull();
  });

  it('ranks on the categories a run actually emitted', () => {
    // arrange — an early run emitting only points and assists, as migration
    // 014 says is normal while the stat vocabulary grows
    const sparse = (pts: number, ast: number): ImpactInput => {
      const entry = {} as ImpactInput;
      for (const stat of PROJECTED_STATS) entry[stat] = null;
      return { ...entry, pts, ast };
    };

    // act
    const scores = impactScores([sparse(10, 2), sparse(30, 9)]);

    // assert — nobody is null just because the other seven are missing
    expect(scores.every((s) => s !== null)).toBe(true);
    expect(scores[1]).toBeGreaterThan(scores[0] as number);
  });

  it('separates nobody on a category the whole pool agrees about', () => {
    // act — identical pool: every z is 0 rather than NaN from a zero stddev
    expect(impactScores([input(), input()])).toEqual([0, 0]);
  });

  it('has nothing to score for an empty pool', () => {
    // act + assert
    expect(impactScores([])).toEqual([]);
  });
});

describe('topImpactIds', () => {
  it('picks the best few by impact', () => {
    // act
    const top = topImpactIds(
      [
        player({ nba_player_id: 'a', impact: 1 }),
        player({ nba_player_id: 'b', impact: 5 }),
        player({ nba_player_id: 'c', impact: 3 }),
        player({ nba_player_id: 'd', impact: -2 }),
      ],
      SPOTLIGHT_PER_GAME
    );

    // assert
    expect([...top].sort()).toEqual(['a', 'b', 'c']);
  });

  it('never spotlights an unscored player, however short the list', () => {
    // act — the badge is a claim, and there is nothing to claim here
    const top = topImpactIds([player({ nba_player_id: 'a', impact: null })], 3);

    // assert
    expect(top.size).toBe(0);
  });
});
