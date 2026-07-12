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
    // act
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', password: 'Aa1!aaaa' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects a short username with 400', async () => {
    // act
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'al', email: 'a@b.co', password: 'Aa1!aaaa' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it('rejects an invalid email with 400', async () => {
    // act
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'not-an-email', password: 'Aa1!aaaa' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('rejects a short password with 400', async () => {
    // act
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'Aa1!' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  it('rejects a password without an uppercase letter', async () => {
    // act
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'aaaaaa1!' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uppercase/i);
  });

  it('rejects a password without a number or symbol', async () => {
    // act
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'Aaaaaaaa' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/number or symbol/i);
  });

  it('returns 409 when the email is already taken', async () => {
    // arrange
    queryMock.mockRejectedValueOnce(pgUniqueViolation('Key (email) already exists'));

    // act
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'Aa1!aaaa' });

    // assert
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });

  it('creates the user and returns a jwt on success', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([{ id: 99 }]));

    // act
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'a@b.co', password: 'Aa1!aaaa' });

    // assert
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.split('.')).toHaveLength(3);
  });
});

describe('POST /api/auth/login', () => {
  it('returns 400 when username or password is missing', async () => {
    // act
    const res = await request(app).post('/api/auth/login').send({ username: 'alice' });

    // assert
    expect(res.status).toBe(400);
  });

  it('returns 401 when the user does not exist', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ghost', password: 'Aa1!aaaa' });

    // assert
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('returns a clear error for google-only accounts (no password hash)', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1, password_hash: null }]));

    // act
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'google-user', password: 'whatever' });

    // assert
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/google/i);
  });

  it('returns 401 when the password does not match', async () => {
    // arrange
    const hash = await bcrypt.hash('Correct1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1, password_hash: hash }]));

    // act
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'Wrong1!aaa' });

    // assert
    expect(res.status).toBe(401);
  });

  it('returns a jwt on a correct password match', async () => {
    // arrange
    const hash = await bcrypt.hash('Correct1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1, password_hash: hash }]));

    // act
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'Correct1!' });

    // assert
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('returns a generic 200 even for malformed emails (no enumeration)', async () => {
    // act
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'not-an-email' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset link/i);
  });

  it('returns the same generic message when the email is unknown', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'unknown@example.com' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset link/i);
  });
});

describe('PATCH /api/auth/profile', () => {
  it('rejects requests without a bearer token', async () => {
    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .send({ name: 'Alice' });

    // assert
    expect(res.status).toBe(401);
  });

  it('returns 400 when no fields are sent', async () => {
    // arrange — no setup; the route inspects the body only.

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({});

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fields/i);
  });

  it('rejects an explicit null field (regression: previously crashed with null.trim())', async () => {
    // arrange — explicit null is `!== undefined`, so without the type guard
    // the username branch would call `null.trim()` and throw 500.

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ username: null });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/string/i);
  });

  it('returns 400 when the email is malformed', async () => {
    // arrange — body-only validation, no db setup.

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ email: 'not-an-email' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('returns 400 when the phone has invalid characters', async () => {
    // arrange — body-only validation, no db setup.

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ phone: 'pretend this is a phone' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/i);
  });

  it('returns 400 when the name exceeds 100 characters', async () => {
    // arrange — body-only validation, no db setup.

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ name: 'a'.repeat(101) });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100 characters/i);
  });

  it('updates only the fields the client sends and returns the new profile', async () => {
    // arrange
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

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(7))
      .send({ name: 'Alice', phone: '555-0100' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, name: 'Alice', phone: '555-0100' });
    // user id from the jwt must be bound on the where clause, never from the body.
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE users SET .* WHERE id = \$3/);
    expect(params).toEqual(['Alice', '555-0100', 7]);
  });

  it('clears name when an empty string is sent (stores NULL)', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 7, username: 'alice', email: 'a@b.co', name: null, phone: null }])
    );

    // act
    await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(7))
      .send({ name: '' });

    // assert
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([null, 7]);
  });

  it('returns 409 when the email is already used by another account', async () => {
    // arrange
    queryMock.mockRejectedValueOnce(pgUniqueViolation('Key (email) already exists'));

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ email: 'taken@example.com' });

    // assert
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it('rejects a username shorter than 3 characters', async () => {
    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ username: 'al' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/3 characters/i);
  });

  it('updates the username when valid and unique', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 7, username: 'alice2', email: 'a@b.co', name: null, phone: null }])
    );

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(7))
      .send({ username: 'alice2' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice2');
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['alice2', 7]);
  });

  it('returns 409 with a username-specific message on username collision', async () => {
    // arrange — pg's detail typically reads "Key (username)=(taken) already exists"
    queryMock.mockRejectedValueOnce(pgUniqueViolation('Key (username)=(taken) already exists'));

    // act
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', bearerFor(1))
      .send({ username: 'taken' });

    // assert
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/username/i);
  });
});

describe('PATCH /api/auth/change-password', () => {
  it('returns 400 when newPassword is missing', async () => {
    // act
    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ currentPassword: 'Whatever1!' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/new password/i);
  });

  it('requires currentPassword when the user has an existing password', async () => {
    // arrange — user row has a real bcrypt hash, so the route must demand
    // currentPassword before allowing the change.
    const existingHash = await bcrypt.hash('Original1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ password_hash: existingHash }]));

    // act
    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ newPassword: 'Brandnew1!' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current password/i);
  });

  it('rejects an incorrect currentPassword with 401', async () => {
    // arrange
    const existingHash = await bcrypt.hash('Original1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ password_hash: existingHash }]));

    // act
    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ currentPassword: 'Wrong1!aa', newPassword: 'Brandnew1!' });

    // assert
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect/i);
  });

  it('lets google-only users set a password without providing currentPassword', async () => {
    // arrange — user row has password_hash = null (google-only account).
    queryMock.mockResolvedValueOnce(pgResult([{ password_hash: null }]));
    // the second query is the UPDATE; we don't care about its return shape here.
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1 }]));

    // act
    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ newPassword: 'Brandnew1!' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated/i);
  });

  it('changes the password for a normal user with the correct currentPassword', async () => {
    // arrange
    const existingHash = await bcrypt.hash('Original1!', 10);
    queryMock.mockResolvedValueOnce(pgResult([{ password_hash: existingHash }]));
    queryMock.mockResolvedValueOnce(pgResult([{ id: 1 }]));

    // act
    const res = await request(app)
      .patch('/api/auth/change-password')
      .set('Authorization', bearerFor(1))
      .send({ currentPassword: 'Original1!', newPassword: 'Brandnew1!' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated/i);
  });
});
