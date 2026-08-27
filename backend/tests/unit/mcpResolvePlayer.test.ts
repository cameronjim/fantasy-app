import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { resolvePlayer } from '../../src/mcp/resolvePlayer.js';
import { pgResult } from '../helpers/mockDb.js';

describe('resolvePlayer', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('resolves a numeric id that exists', async () => {
    // arrange
    vi.mocked(query).mockResolvedValueOnce(
      pgResult([{ id: 431, nba_id: '203999', name: 'Nikola Jokic', team: 'DEN', position: 'C' }])
    );

    // act
    const result = await resolvePlayer('431');

    // assert
    expect(result).toEqual({
      kind: 'found',
      player: { id: 431, nba_id: '203999', name: 'Nikola Jokic', team: 'DEN', position: 'C' },
    });
  });

  it('returns not_found for a numeric id with no matching row', async () => {
    // arrange
    vi.mocked(query).mockResolvedValueOnce(pgResult([]));

    // act
    const result = await resolvePlayer('99999');

    // assert
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('returns found when the top name match is an exact case-insensitive match', async () => {
    // arrange
    vi.mocked(query).mockResolvedValueOnce(
      pgResult([
        { id: 431, nba_id: '203999', name: 'Nikola Jokic', team: 'DEN', position: 'C', games_played: 68 },
        { id: 999, nba_id: '204000', name: 'Nikola Jokic Jr', team: 'DEN', position: 'C', games_played: 10 },
      ])
    );

    // act
    const result = await resolvePlayer('nikola jokic');

    // assert
    expect(result.kind).toBe('found');
    expect(result.kind === 'found' && result.player.id).toBe(431);
  });

  it('returns ambiguous with at most 5 candidates when multiple substring matches and no exact match', async () => {
    // arrange
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      nba_id: `${i + 1}`,
      name: `Jok Player ${i}`,
      team: 'DEN',
      position: 'C',
      games_played: 10,
    }));
    vi.mocked(query).mockResolvedValueOnce(pgResult(rows));

    // act
    const result = await resolvePlayer('jok');

    // assert
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates).toHaveLength(5);
  });

  it('returns not_found when zero rows match the substring search', async () => {
    // arrange
    vi.mocked(query).mockResolvedValueOnce(pgResult([]));

    // act
    const result = await resolvePlayer('zzzzz');

    // assert
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('short-circuits without querying for whitespace-only input', async () => {
    // act
    const result = await resolvePlayer('   ');

    // assert
    expect(result).toEqual({ kind: 'not_found' });
    expect(query).not.toHaveBeenCalled();
  });
});
