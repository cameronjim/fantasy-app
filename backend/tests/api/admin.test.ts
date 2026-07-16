import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { bearerFor } from '../helpers/authToken.js';
import { pgResult } from '../helpers/mockDb.js';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

// first query on every admin route is the requireAdmin lookup.
function mockAdminCheck(isAdmin: boolean): void {
  queryMock.mockResolvedValueOnce(pgResult([{ is_admin: isAdmin }]));
}

describe('admin route gating', () => {
  it('rejects /api/admin/users without a Bearer token', async () => {
    // act
    const res = await request(app).get('/api/admin/users');

    // assert
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 403 for an authenticated non-admin user', async () => {
    // arrange
    mockAdminCheck(false);

    // act
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(2));

    // assert
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it('returns 401 when the token references a deleted user', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(99));

    // assert
    expect(res.status).toBe(401);
  });

  it('checks admin status against the jwt user id, never a client value', async () => {
    // arrange
    mockAdminCheck(true);
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(7));

    // assert — the privilege check must bind the id from the token.
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([7]);
  });
});

describe('GET /api/admin/users', () => {
  it('returns the user list for an admin', async () => {
    // arrange
    mockAdminCheck(true);
    queryMock.mockResolvedValueOnce(
      pgResult([
        {
          id: 1,
          username: 'cj',
          email: 'cj@example.com',
          name: null,
          is_admin: true,
          created_at: '2026-06-01T00:00:00Z',
          has_password: true,
          has_google: false,
          roster_count: 9,
          last_seen: '2026-06-09T12:00:00Z',
        },
      ])
    );

    // act
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ username: 'cj', roster_count: 9 });
    // password hashes must never appear in the payload.
    expect(res.body[0]).not.toHaveProperty('password_hash');
  });

  it('returns 500 with the standard error shape when the query fails', async () => {
    // arrange
    mockAdminCheck(true);
    queryMock.mockRejectedValueOnce(new Error('db down'));

    // act
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/users/i);
  });
});

describe('GET /api/admin/stats', () => {
  it('returns headline totals and top paths', async () => {
    // arrange
    mockAdminCheck(true);
    queryMock.mockResolvedValueOnce(
      pgResult([
        { total_users: 4, new_users_7d: 1, views_24h: 12, views_7d: 80, active_users_24h: 2 },
      ])
    );
    queryMock.mockResolvedValueOnce(
      pgResult([
        { path: '/', views: 40 },
        { path: '/betting', views: 25 },
      ])
    );

    // act
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ total_users: 4, views_7d: 80 });
    expect(res.body.top_paths).toEqual([
      { path: '/', views: 40 },
      { path: '/betting', views: 25 },
    ]);
  });
});

describe('GET /api/admin/views', () => {
  it('returns recent page views with usernames', async () => {
    // arrange
    mockAdminCheck(true);
    queryMock.mockResolvedValueOnce(
      pgResult([
        {
          id: 10,
          path: '/fantasy',
          referrer: null,
          user_agent: 'Mozilla/5.0',
          created_at: '2026-06-10T08:00:00Z',
          username: 'cj',
        },
        {
          id: 9,
          path: '/',
          referrer: null,
          user_agent: 'Mozilla/5.0',
          created_at: '2026-06-10T07:59:00Z',
          username: null,
        },
      ])
    );

    // act
    const res = await request(app)
      .get('/api/admin/views')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ path: '/fantasy', username: 'cj' });
    // anonymous views surface with a null username, not an error.
    expect(res.body[1].username).toBeNull();
  });
});
