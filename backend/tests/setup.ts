import { vi } from 'vitest';

// test environment defaults. these run before any test file is loaded so
// modules that read env vars at import time (db.ts, auth.ts) see safe values.
//
// we deliberately do not set DATABASE_URL — the mocks below replace the db
// module so a real pg connection never happens. if a test forgets to mock
// it, the pg pool would throw immediately on first query, surfacing the bug
// loudly instead of silently hitting a real database.
process.env.NODE_ENV = 'test';
// at least 32 chars and not a known placeholder so validateAuthSecret (run at
// app import) passes when the api tests load the app.
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? 'test-auth-secret-not-for-prod-0123456789';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'test-google-client-id';

// global module mocks installed once for every test file. each test pulls
// the mocked query via `vi.mocked(query)` and chains its own
// mockResolvedValueOnce/mockRejectedValueOnce expectations.
vi.mock('../src/db.js', () => ({
  query: vi.fn(),
  pool: { end: vi.fn() },
}));

vi.mock('../src/services/fantasyScore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/fantasyScore.js')>();
  return {
    ...actual,
    getRankedPlayers: vi.fn().mockResolvedValue([]),
    getScoresById: vi.fn().mockResolvedValue(new Map()),
  };
});
