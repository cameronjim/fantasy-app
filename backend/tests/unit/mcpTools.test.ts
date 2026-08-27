import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { getRankedPlayers } from '../../src/services/fantasyScore.js';
import { pgResult } from '../helpers/mockDb.js';
import {
  getSlateHandler,
  getPlayerProjectionsHandler,
  searchPlayersHandler,
} from '../../src/mcp/tools.js';

const INVALID_DATE = 'date must be a calendar day formatted YYYY-MM-DD';

describe('MCP tool handlers', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(getRankedPlayers).mockReset();
  });

  it('get_slate returns isError with the route message for an invalid calendar date', async () => {
    // act
    const result = await getSlateHandler({ date: '2026-02-31', players_per_game: 5 });

    // assert
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: INVALID_DATE });
  });

  it('get_slate happy path returns a text content item', async () => {
    // arrange
    vi.mocked(query).mockResolvedValue(pgResult([]));

    // act
    const result = await getSlateHandler({ players_per_game: 5 });

    // assert
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  it('returns isError with a sanitized message when the underlying service throws, even if the error embeds a connection string', async () => {
    // arrange
    vi.mocked(query).mockRejectedValue(
      new Error('connection failed: postgresql://user:secret@db-host.example.com/nba')
    );

    // act
    const result = await getSlateHandler({ players_per_game: 5 });

    // assert
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Query failed:');
    expect(/postgres(ql)?:\/\//i.test(text)).toBe(false);
  });

  it('get_player_projections returns the ambiguous candidate list as non-error text', async () => {
    // arrange
    vi.mocked(query).mockResolvedValueOnce(
      pgResult([
        { id: 1, nba_id: '1', name: 'Jok Alpha', team: 'DEN', position: 'C', games_played: 20 },
        { id: 2, nba_id: '2', name: 'Jok Beta', team: 'BOS', position: 'F', games_played: 15 },
      ])
    );

    // act
    const result = await getPlayerProjectionsHandler({ player: 'jok', limit: 5 });

    // assert
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Multiple players match "jok"');
    expect(text).toContain('Jok Alpha');
    expect(text).toContain('Jok Beta');
  });

  it('search_players position filter matches a bucket position like F against a multi-position player', async () => {
    // arrange
    vi.mocked(getRankedPlayers).mockResolvedValueOnce([
      {
        id: 5,
        nba_id: '5',
        name: 'Multi Position',
        team: 'POR',
        position: 'SF,PF',
        points_per_game: 10,
        rebounds_per_game: 5,
        assists_per_game: 2,
        steals_per_game: 1,
        blocks_per_game: 1,
        field_goal_percentage: 50,
        free_throw_percentage: 80,
        three_point_percentage: 35,
        three_pointers_made: 1,
        turnovers_per_game: 1,
        minutes_per_game: 20,
        games_played: 40,
        injury_status: null,
        injury_detail: null,
        headshot_url: null,
        fantasy_score: 20,
        fantasy_rank: 50,
      },
    ]);

    // act
    const result = await searchPlayersHandler({ position: 'F', limit: 10 });

    // assert
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Multi Position');
  });
});
