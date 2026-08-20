import { Request, Response, NextFunction } from 'express';
import { query } from '../db.js';
import { AuthRequest } from './auth.js';

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as AuthRequest).userId;
  try {
    const result = await query('SELECT is_admin FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!result.rows[0].is_admin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  } catch {
    res.status(500).json({ error: 'Failed to verify admin access' });
  }
}
