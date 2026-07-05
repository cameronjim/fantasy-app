import jwt from 'jsonwebtoken';

/** Sign a Bearer token for tests using the shared AUTH_SECRET from setup.ts. */
export function bearerFor(userId: number): string {
  const token = jwt.sign({ userId }, process.env.AUTH_SECRET!);
  return `Bearer ${token}`;
}
