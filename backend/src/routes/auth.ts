import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';

const router = Router();

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  if (username.length < 3) {
    res.status(400).json({ error: 'Username must be at least 3 characters' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, hash]
    );
    const token = jwt.sign({ userId: result.rows[0].id }, process.env.AUTH_SECRET!, { expiresIn: '30d' });
    res.status(201).json({ token });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  try {
    const result = await query(
      'SELECT id, password_hash FROM users WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    const token = jwt.sign({ userId: result.rows[0].id }, process.env.AUTH_SECRET!, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Failed to login' });
  }
});

export { router as authRouter };
