import jwt from 'jsonwebtoken';

export function bearerFor(userId: number): string {
  const token = jwt.sign({ userId }, process.env.AUTH_SECRET!);
  return `Bearer ${token}`;
}
