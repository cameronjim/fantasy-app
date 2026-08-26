import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { pgResult, pgUniqueViolation } from '../helpers/mockDb.js';
import { bearerFor } from '../helpers/authToken.js';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

describe('POST /api/auth/register validation', () => {
  it('rejects a missing field with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', password: 'Aa1!aaaa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects a short username with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'al', email: 'a@b.co', password: 'Aa1!aaaa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it('rejects an invalid email with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'not-an-email', password: 'Aa1!aaaa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('rejects a short password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'Aa1!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  it('rejects a password without an uppercase letter', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'aaaaaa1!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uppercase/i);
  });

  it('rejects a password without a number or symbol', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'Aaaaaaaa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/number or symbol/i);
  });

  it('rejects a username longer than 50 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'a'.repeat(51), email: 'a@b.co', password: 'Aa1!aaaa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/50 characters/i);
  });

  it('rejects an email longer than 255 characters', async () => {
    const longEmail = `${'a'.repeat(260)}@b.co`;

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: longEmail, password: 'Aa1!aaaa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('rejects a password longer than 200 characters (bcrypt DoS guard)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: `Aa1!${'a'.repeat(220)}` });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200 characters/i);
  });

  it('returns 409 when the email is already taken', async () => {
    queryMock.mockRejectedValueOnce(pgUniqueViolation('Key (email) already exists'));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'Aa1!aaaa' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });

  it('creates the user and returns a jwt on success', async () => {
    queryMock.mockResolvedValueOnce(pgResult([{ id: 99 }]));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'Aa1!aaaa' });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.split('.')).toHaveLength(3);
  });
});

describe('POST /api/auth/login', () => {
  it('returns 400 when username or password is missing', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'alice' });

    expect(res.status).toBe(400);
  });

  it('returns 401 when the user does not exist', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ghost', password: 'Aa1!aaaa' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('returns a clear error for google-only accounts (no password hash)', async () => {
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1, password_hash: null }]));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'google-user', password: 'whatever' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/google/i);
  });

  it('returns 401 when the password does not match', async () => {
    const hash = await bcrypt.hash('Correct1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1, password_hash: hash }]));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'Wrong1!aaa' });

    expect(res.status).toBe(401);
  });

  it('returns a jwt on a correct password match', async () => {
    const hash = await bcrypt.hash('Correct1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1, password_hash: hash }]));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'Correct1!' });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('returns a generic 200 even for malformed emails (no enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset link/i);
  });

  it('returns the same generic message when the email is unknown', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'unknown@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset link/i);
  });
});

describe('PATCH /api/auth/profile', () => {
  it('rejects requests without a bearer token', async () => {
    const res = await request(app)
      .patch('/api/auth/profile')
      .send({ name: 'Alice' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when no fields are sent', async () => {

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fields/i);
  });

  it('rejects an explicit null field (regression: previously crashed with null.trim())', async () => {

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ username: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/string/i);
  });

  it('returns 400 when the email is malformed', async () => {

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('returns 400 when the phone has invalid characters', async () => {

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ phone: 'pretend this is a phone' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/i);
  });

  it('returns 400 when the name exceeds 100 characters', async () => {

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ name: 'a'.repeat(101) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100 characters/i);
  });

  it('updates only the fields the client sends and returns the new profile', async () => {
    queryMock.mockResolvedValueOnce(
      pgResult([
        {
          id: 7,
          username: 'alice',
          email: 'alice@example.com',
          name: 'Alice',
          phone: '555-0100',
        },
      ])
    );

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(7))
      .send({ name: 'Alice', phone: '555-0100' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, name: 'Alice', phone: '555-0100' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE users SET .* WHERE id = \$3/);
    expect(params).toEqual(['Alice', '555-0100', 7]);
  });

  it('clears name when an empty string is sent (stores NULL)', async () => {
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 7, username: 'alice', email: 'a@b.co', name: null, phone: null }])
    );

    await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(7))
      .send({ name: '' });

    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([null, 7]);
  });

  it('returns 409 when the email is already used by another account', async () => {
    queryMock.mockRejectedValueOnce(pgUniqueViolation('Key (email) already exists'));

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ email: 'taken@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it('rejects a username shorter than 3 characters', async () => {
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ username: 'al' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/3 characters/i);
  });

  it('updates the username when valid and unique', async () => {
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 7, username: 'alice2', email: 'a@b.co', name: null, phone: null }])
    );

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(7))
      .send({ username: 'alice2' });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice2');
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['alice2', 7]);
  });

  it('returns 409 with a username-specific message on username collision', async () => {
    queryMock.mockRejectedValueOnce(pgUniqueViolation('Key (username)=(taken) already exists'));

    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ username: 'taken' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/username/i);
  });
});

describe('PATCH /api/auth/change-password', () => {
  it('returns 400 when newPassword is missing', async () => {
    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ currentPassword: 'Whatever1!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/new password/i);
  });

  it('requires currentPassword when the user has an existing password', async () => {
    const existingHash = await bcrypt.hash('Original1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ password_hash: existingHash }]));

    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ newPassword: 'Brandnew1!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current password/i);
  });

  it('rejects an incorrect currentPassword with 401', async () => {
    const existingHash = await bcrypt.hash('Original1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ password_hash: existingHash }]));

    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ currentPassword: 'Wrong1!aa', newPassword: 'Brandnew1!' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect/i);
  });

  it('lets google-only users set a password without providing currentPassword', async () => {
    queryMock.mockResolvedValueOnce(pgResult([{ password_hash: null }]));
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1 }]));

    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ newPassword: 'Brandnew1!' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated/i);
  });

  it('changes the password for a normal user with the correct currentPassword', async () => {
    const existingHash = await bcrypt.hash('Original1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ password_hash: existingHash }]));
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1 }]));

    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ currentPassword: 'Original1!', newPassword: 'Brandnew1!' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated/i);
  });
});
