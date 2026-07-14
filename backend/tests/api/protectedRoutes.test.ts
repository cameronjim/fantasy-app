import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { bearerFor } from '../helpers/authToken.js';
import { pgResult } from '../helpers/mockDb.js';

const queryMock = vi.mocked(query);

describe('auth gating on /api/fantasy and /api/ai', () => {
  it('rejects /api/fantasy/roster without a Bearer token', async () => {
    // act
    const res = await request(app).get('/api/fantasy/roster');

    // assert
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects /api/ai/team-analysis without a Bearer token', async () => {
    // act
    const res = await request(app).get('/api/ai/team-analysis');

    // assert
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it.each([
    ['get', '/api/betting/picks'],
    ['get', '/api/betting/bets'],
    ['post', '/api/betting/bets'],
    ['patch', '/api/betting/bets/1'],
    ['delete', '/api/betting/bets/1'],
  ] as const)('rejects %s %s without a Bearer token', async (method, path) => {
    // act
    const res = await request(app)[method](path);

    // assert
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects /api/fantasy/roster with an invalid token', async () => {
    // act
    const res = await request(app)
      .get('/api/fantasy/roster')
      .set('Authorization', 'Bearer not-a-real-jwt');

    // assert
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  it('allows /api/fantasy/roster with a valid token and binds the jwt user id', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .get('/api/fantasy/roster')
      .set('Authorization', bearerFor(123));

    // assert
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // the route must bind the user id from the jwt, never from a client
    // value — this is a privilege-escalation guard.
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([123]);
  });
});
