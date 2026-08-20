import { vi } from 'vitest';

// DATABASE_URL is deliberately unset; db.js is mocked below so a forgotten mock fails loudly instead of hitting a real database
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? 'test-auth-secret-not-for-prod-0123456789';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'test-google-client-id';

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
