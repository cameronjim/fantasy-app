import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { pgResult } from '../helpers/mockDb.js';

const { app } = await import('../../src/app.js');
const { query } = await import('../../src/db.js');
const { RATINGS_2K_ATTRIBUTION } = await import('../../src/services/ratings2kParams.js');
const queryMock = vi.mocked(query);

const jokicSummary = {
  slug: 'nikola-jokic',
  name: 'Nikola Jokic',
  team: 'Denver Nuggets',
  team_type: 'curr',
  overall: 98,
  positions: 'C',
  game_version: '2K27',
  player_image: 'https://www.2kratings.com/wp-content/uploads/Nikola-Jokic.jpg',
};

const jokicDetail = {
  ...jokicSummary,
  archetype: 'Triple-Double Threat',
  build: 'Double Threat',
  height: '6\'11"',
  weight: '284 lbs',
  wingspan: '7\'3"',
  updated_at: '2026-08-08T04:19:12.948Z',
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /api/ratings2k/players', () => {
  it('returns the total, the page of cards, and the attribution', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 672 }]))
      .mockResolvedValueOnce(pgResult([jokicSummary]));

    const res = await request(app).get('/api/ratings2k/players');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(672);
    expect(res.body.players).toHaveLength(1);
    expect(res.body.players[0]).toEqual(jokicSummary);
    expect(typeof res.body.players[0].overall).toBe('number');
    expect(res.body.source).toBe(RATINGS_2K_ATTRIBUTION);
  });

  it('defaults to current players and binds the roster type as a parameter', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 672 }]))
      .mockResolvedValueOnce(pgResult([jokicSummary]));

    await request(app).get('/api/ratings2k/players');

    const [countSql, countParams] = queryMock.mock.calls[0];
    expect(countParams).toEqual(['curr']);
    expect(countSql).toContain('team_type = $1');
    expect(countSql).not.toContain("'curr'");
  });

  it('reads a requested roster type', async () => {
    const allTimeJokic = { ...jokicSummary, team_type: 'allt' };
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 450 }]))
      .mockResolvedValueOnce(pgResult([allTimeJokic]));

    const res = await request(app).get('/api/ratings2k/players').query({ teamType: 'allt' });

    expect(res.status).toBe(200);
    expect(res.body.players[0].team_type).toBe('allt');
    const [, countParams] = queryMock.mock.calls[0];
    expect(countParams).toEqual(['allt']);
  });

  it('spans every roster type when teamType is all', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 1889 }]))
      .mockResolvedValueOnce(pgResult([jokicSummary]));

    const res = await request(app).get('/api/ratings2k/players').query({ teamType: 'all' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1889);
    const [countSql, countParams] = queryMock.mock.calls[0];
    expect(countParams).toEqual([]);
    expect(countSql).not.toContain('team_type');
  });

  it('returns 400 for an unrecognized roster type without querying', async () => {
    const res = await request(app).get('/api/ratings2k/players').query({ teamType: 'current' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/teamType/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('applies a case-insensitive name filter when search is provided', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 1 }]))
      .mockResolvedValueOnce(pgResult([jokicSummary]));

    const res = await request(app)
      .get('/api/ratings2k/players')
      .query({ search: 'jokic' });

    expect(res.status).toBe(200);
    expect(res.body.players[0].name).toBe('Nikola Jokic');
    const [countSql, countParams] = queryMock.mock.calls[0];
    expect(countParams).toEqual(['curr', '%jokic%']);
    expect(countSql).not.toContain('jokic');
  });

  it('caps limit at 1000 and passes it as a bound parameter', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 1889 }]))
      .mockResolvedValueOnce(pgResult([jokicSummary]));

    const res = await request(app)
      .get('/api/ratings2k/players')
      .query({ limit: '99999' });

    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['curr', 1000, 0]);
  });

  it('lets a single request cover the whole classic roster', async () => {
    const CLASSIC_ROSTER_SIZE = 767;
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: CLASSIC_ROSTER_SIZE }]))
      .mockResolvedValueOnce(pgResult([jokicSummary]));

    const res = await request(app)
      .get('/api/ratings2k/players')
      .query({ teamType: 'class', limit: String(CLASSIC_ROSTER_SIZE) });

    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['class', CLASSIC_ROSTER_SIZE, 0]);
  });

  it('honours limit and offset for paging', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 672 }]))
      .mockResolvedValueOnce(pgResult([jokicSummary]));

    const res = await request(app)
      .get('/api/ratings2k/players')
      .query({ limit: '25', offset: '50' });

    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['curr', 25, 50]);
  });

  it('never lets an injected sort key reach the ordering clause', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 672 }]))
      .mockResolvedValueOnce(pgResult([jokicSummary]));

    const res = await request(app)
      .get('/api/ratings2k/players')
      .query({ sort: 'overall; DROP TABLE nba_2k_players--' });

    expect(res.status).toBe(200);
    const [pageSql] = queryMock.mock.calls[1];
    expect(pageSql).not.toContain('DROP');
    expect(pageSql).toContain('ORDER BY overall DESC NULLS LAST, name ASC');
  });

  it('reports total 0 before any sync has run', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 0 }]))
      .mockResolvedValueOnce(pgResult([]));

    const res = await request(app).get('/api/ratings2k/players');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.players).toEqual([]);
  });

  it('returns 500 when the database query fails', async () => {
    queryMock.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/ratings2k/players');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch 2K players');
  });
});

describe('GET /api/ratings2k/players/:slug', () => {
  it('returns the card with its attributes, badges, and rating history', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([jokicDetail]))
      .mockResolvedValueOnce(
        pgResult([
          { attribute_name: 'agility', value: 70 },
          { attribute_name: 'passVision', value: 99 },
        ])
      )
      .mockResolvedValueOnce(
        pgResult([
          {
            badge_name: 'Dimer',
            tier: 'Hall of Fame',
            category: 'Playmaking',
            description: 'Passes by Dimers to open shooters yield a boost.',
            image_url: 'https://www.2kratings.com/wp-content/uploads/dimer-hof-badge.png',
          },
        ])
      )
      .mockResolvedValueOnce(
        pgResult([
          { game_version: '2K27', overall: 98, delta: 0 },
          { game_version: '2K26', overall: 98, delta: 1 },
          { game_version: '2K16', overall: 68, delta: null },
        ])
      );

    const res = await request(app).get('/api/ratings2k/players/nikola-jokic');

    expect(res.status).toBe(200);
    expect(res.body.player).toEqual(jokicDetail);
    expect(res.body.attributes).toEqual([
      { attribute_name: 'agility', value: 70 },
      { attribute_name: 'passVision', value: 99 },
    ]);
    expect(res.body.badges[0]).toMatchObject({ badge_name: 'Dimer', tier: 'Hall of Fame' });
    expect(res.body.rating_history).toHaveLength(3);
    expect(res.body.rating_history[0]).toEqual({
      game_version: '2K27',
      overall: 98,
      delta: 0,
    });
    expect(res.body.rating_history[2].delta).toBeNull();
    expect(res.body.source).toBe(RATINGS_2K_ATTRIBUTION);
  });

  it('binds the slug as a query parameter on every read', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([jokicDetail]))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([]));

    await request(app).get('/api/ratings2k/players/nikola-jokic');

    expect(queryMock).toHaveBeenCalledTimes(4);
    for (const [sql, params] of queryMock.mock.calls) {
      expect(params).toEqual(['nikola-jokic']);
      expect(sql).toContain('$1');
      expect(sql).not.toContain('nikola-jokic');
    }
  });

  it('returns empty arrays for a card 2K has not rated yet', async () => {
    const rookie = { ...jokicDetail, slug: 'aj-dybantsa', name: 'AJ Dybantsa', overall: 79 };
    queryMock
      .mockResolvedValueOnce(pgResult([rookie]))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([]));

    const res = await request(app).get('/api/ratings2k/players/aj-dybantsa');

    expect(res.status).toBe(200);
    expect(res.body.player.overall).toBe(79);
    expect(res.body.attributes).toEqual([]);
    expect(res.body.badges).toEqual([]);
    expect(res.body.rating_history).toEqual([]);
  });

  it('returns 404 for an unknown slug without reading the child tables', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app).get('/api/ratings2k/players/not-a-real-player');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the database query fails', async () => {
    queryMock.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/ratings2k/players/nikola-jokic');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch 2K player');
  });
});

describe('GET /api/ratings2k/by-player-name', () => {
  it('resolves an app player to their 2K card', async () => {
    queryMock.mockResolvedValueOnce(pgResult([jokicSummary]));

    const res = await request(app)
      .get('/api/ratings2k/by-player-name')
      .query({ name: 'Nikola Jokic' });

    expect(res.status).toBe(200);
    expect(res.body.player).toEqual(jokicSummary);
    expect(res.body.source).toBe(RATINGS_2K_ATTRIBUTION);
  });

  it('matches on the normalized name and binds it as a parameter', async () => {
    queryMock.mockResolvedValueOnce(pgResult([jokicSummary]));

    await request(app)
      .get('/api/ratings2k/by-player-name')
      .query({ name: 'Alperen Şengün' });

    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['alperen sengun']);
    expect(sql).toContain('normalized_name = $1');
    expect(sql).not.toContain('Şengün');
  });

  it('prefers the current-roster card when several names collide', async () => {
    queryMock.mockResolvedValueOnce(pgResult([jokicSummary]));

    await request(app)
      .get('/api/ratings2k/by-player-name')
      .query({ name: 'Gary Payton II' });

    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['gary payton']);
    expect(sql).toContain("(team_type = 'curr') DESC");
    expect(sql).toContain('LIMIT 1');
  });

  it('responds 200 with a null player when the name has no 2K card', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app)
      .get('/api/ratings2k/by-player-name')
      .query({ name: 'Some Two Way Signing' });

    expect(res.status).toBe(200);
    expect(res.body.player).toBeNull();
    expect(res.body.source).toBe(RATINGS_2K_ATTRIBUTION);
  });

  it('returns 400 when name is missing or blank, without querying', async () => {
    const missing = await request(app).get('/api/ratings2k/by-player-name');
    const blank = await request(app)
      .get('/api/ratings2k/by-player-name')
      .query({ name: '   ' });

    expect(missing.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(missing.body.error).toMatch(/name is required/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the database query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .get('/api/ratings2k/by-player-name')
      .query({ name: 'Nikola Jokic' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to resolve 2K player');
  });
});
