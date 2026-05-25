import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { bearerFor } from '../helpers/authToken.js';
import { pgResult, pgUniqueViolation } from '../helpers/mockDb.js';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

describe('POST /api/fantasy/roster', () => {
  it('returns 400 when player_id is missing from the body', async () => {
    // act
    const res = await request(app)
      .post('/api/fantasy/roster')
      .set('Authorization', bearerFor(1))
      .send({});

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/player_id/);
  });

  it('returns 409 when the player is already on the roster', async () => {
    // arrange
    queryMock.mockRejectedValueOnce(pgUniqueViolation());

    // act
    const res = await request(app)
      .post('/api/fantasy/roster')
      .set('Authorization', bearerFor(1))
      .send({ player_id: 42 });

    // assert
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it('returns 201 with the new roster row on success', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 100, player_id: 42, added_at: '2026-05-24T00:00:00Z' }])
    );

    // act
    const res = await request(app)
      .post('/api/fantasy/roster')
      .set('Authorization', bearerFor(1))
      .send({ player_id: 42 });

    // assert
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 100, player_id: 42 });
    // the route must bind userId from the jwt, never from the body —
    // this is a privilege-escalation guard.
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([42, 1]);
  });
});

describe('DELETE /api/fantasy/roster/:playerId', () => {
  it('returns 404 when the player is not on the roster', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .delete('/api/fantasy/roster/42')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not on roster/i);
  });

  it('returns 200 on a successful drop', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([{ id: 100 }]));

    // act
    const res = await request(app)
      .delete('/api/fantasy/roster/42')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/removed/i);
  });

  it('scopes the delete by the authenticated user id', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([{ id: 100 }]));

    // act
    await request(app)
      .delete('/api/fantasy/roster/42')
      .set('Authorization', bearerFor(7));

    // assert — the userId param must be the jwt's, not a client value.
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['42', 7]);
  });
});
