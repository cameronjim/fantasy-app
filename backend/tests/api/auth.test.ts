import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { pgResult, pgUniqueViolation } from '../helpers/mockDb.js';

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
