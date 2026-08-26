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

function mockAdminCheck(isAdmin: boolean): void {
  queryMock.mockResolvedValueOnce(pgResult([{ is_admin: isAdmin }]));
}

describe('admin route gating', () => {
  it('rejects /api/admin/users without a Bearer token', async () => {
    const res = await request(app).get('/api/admin/users');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 403 for an authenticated non-admin user', async () => {
    mockAdminCheck(false);

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(2));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it('returns 401 when the token references a deleted user', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(99));

    expect(res.status).toBe(401);
  });

  it('checks admin status against the jwt user id, never a client value', async () => {
    mockAdminCheck(true);
    queryMock.mockResolvedValueOnce(pgResult([]));

    await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(7));

    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([7]);
  });
});

describe('GET /api/admin/users', () => {
  it('returns the user list for an admin', async () => {
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

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(1));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ username: 'cj', roster_count: 9 });
    expect(res.body[0]).not.toHaveProperty('password_hash');
  });

  it('returns 500 with the standard error shape when the query fails', async () => {
    mockAdminCheck(true);
    queryMock.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearerFor(1));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/users/i);
  });
});

describe('GET /api/admin/stats', () => {
  it('returns headline totals and top paths', async () => {
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

    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', bearerFor(1));

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

    const res = await request(app)
      .get('/api/admin/views')
      .set('Authorization', bearerFor(1));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ path: '/fantasy', username: 'cj' });
    expect(res.body[1].username).toBeNull();
  });
});
