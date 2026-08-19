import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgResult } from '../helpers/mockDb.js';

const { buildTeamContext, buildWaiverContext } = await import('../../src/services/ai.js');
const { query } = await import('../../src/db.js');
const queryMock = vi.mocked(query);

// the roster prompts gained an optional analytics block. these tests pin the
// two things that matter about it: it says something useful when the data is
// there, and it says nothing at all — without breaking the prompt — when it
// is not.

const rosterRow = {
  id: 7,
  nba_id: '2544',
  name: 'LeBron James',
  team: 'LAL',
  position: 'SF',
  points_per_game: 25.4,
  rebounds_per_game: 7.2,
  assists_per_game: 8.1,
  steals_per_game: 1.1,
  blocks_per_game: 0.6,
  field_goal_percentage: 51.2,
  free_throw_percentage: 75.4,
  three_pointers_made: 2.1,
  turnovers_per_game: 3.4,
  injury_status: null,
};

function analyticsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nba_player_id: '2544',
    games: 41,
    pts_l10: 27.5,
    pts_season: 25.4,
    reb_l10: 6.9,
    reb_season: 7.2,
    ast_l10: 8.6,
    ast_season: 8.1,
    min_l10: 36.1,
    min_season: 34.2,
    prob_active: 0.93,
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('buildTeamContext analytics enrichment', () => {
  it('appends last-10 deltas and availability under the roster', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([rosterRow]))
      .mockResolvedValueOnce(pgResult([analyticsRow()]));

    // act
    const context = await buildTeamContext(1);

    // assert — the original roster block is untouched
    expect(context).toContain('ROSTER AVERAGES:');
    expect(context).toContain('MY ROSTER (1):');
    // and the new block reads as a signed change against the player's own season
    expect(context).toContain('RECENT FORM (last 10 games, change vs season average)');
    expect(context).toContain('LeBron James (41g): PTS 27.5 (+2.1) REB 6.9 (-0.3) AST 8.6 (+0.5) MIN 36.1 (+1.9)');
    expect(context).toContain('P(active next game) 93%');
  });

  it('drops the availability clause when no run has projected the player', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([rosterRow]))
      .mockResolvedValueOnce(pgResult([analyticsRow({ prob_active: null })]));

    // act
    const context = await buildTeamContext(1);

    // assert
    expect(context).toContain('RECENT FORM (last 10 games, change vs season average):');
    expect(context).not.toContain('P(active next game)');
  });

  it('leaves the prompt exactly as it was when the analytics tables are missing', async () => {
    // arrange — 013/014 not applied in this environment
    queryMock
      .mockResolvedValueOnce(pgResult([rosterRow]))
      .mockRejectedValueOnce(new Error('relation "player_game_logs" does not exist'));

    // act
    const context = await buildTeamContext(1);

    // assert — a missing enrichment table must never take down an AI feature
    expect(context).toContain('MY ROSTER (1):');
    expect(context).toContain('LeBron James (SF/LAL)');
    expect(context).not.toContain('RECENT FORM');
  });

  it('skips the enrichment query entirely for a roster with no nba ids', async () => {
    // arrange — rows that predate the scraper cannot be joined to game logs
    queryMock.mockResolvedValueOnce(pgResult([{ ...rosterRow, nba_id: null }]));

    // act
    const context = await buildTeamContext(1);

    // assert
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(context).not.toContain('RECENT FORM');
  });

  it('still short-circuits on an empty roster', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act + assert
    expect(await buildTeamContext(1)).toBe('No players on roster.');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('passes the roster ids to the enrichment query as a bound array', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([rosterRow]))
      .mockResolvedValueOnce(pgResult([analyticsRow()]));

    // act
    await buildTeamContext(1);

    // assert
    const [sql, params] = queryMock.mock.calls[1];
    expect(params).toEqual([['2544']]);
    expect(sql).toContain('ANY($1)');
  });
});

describe('buildWaiverContext analytics enrichment', () => {
  it('adds the same block above the waiver and trade candidates', async () => {
    // arrange — getRankedPlayers is mocked to [] in tests/setup.ts, so the
    // candidate bands are empty and only the roster half is exercised here.
    queryMock
      .mockResolvedValueOnce(pgResult([rosterRow]))
      .mockResolvedValueOnce(pgResult([analyticsRow()]));

    // act
    const context = await buildWaiverContext(1, 12);

    // assert
    expect(context).toContain('LEAGUE: 12 teams');
    expect(context.indexOf('RECENT FORM')).toBeGreaterThan(context.indexOf('MY ROSTER'));
    expect(context.indexOf('RECENT FORM')).toBeLessThan(context.indexOf('WAIVER CANDIDATES'));
  });

  it('leaves the waiver prompt intact when the enrichment fails', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([rosterRow]))
      .mockRejectedValueOnce(new Error('relation "prediction_runs" does not exist'));

    // act
    const context = await buildWaiverContext(1);

    // assert
    expect(context).toContain('WAIVER CANDIDATES');
    expect(context).toContain('TRADE TARGETS');
    expect(context).not.toContain('RECENT FORM');
  });
});
