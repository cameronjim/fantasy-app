import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { sendEmail, passwordResetEmail } from '../services/email.js';

const router = Router();

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    return 'Password must contain at least one number or symbol';
  }
  return null;
}

function isValidEmail(email: string): boolean {
  // Lightweight RFC-ish check. Real validation happens when SES bounces.
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Pull primary frontend URL from the comma-separated FRONTEND_URL env var. */
function getFrontendUrl(): string {
  const raw = (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim();
  return raw || 'http://localhost:5173';
}

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ error: 'Username, email, and password are all required' });
    return;
  }
  if (username.length < 3) {
    res.status(400).json({ error: 'Username must be at least 3 characters' });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Please enter a valid email address' });
    return;
  }
  const pwError = validatePassword(password);
  if (pwError) {
    res.status(400).json({ error: pwError });
    return;
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [username, email.toLowerCase(), hash]
    );
    const token = jwt.sign(
      { userId: result.rows[0].id },
      process.env.AUTH_SECRET!,
      { expiresIn: '30d' }
    );
    res.status(201).json({ token });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      const detail = (err as { detail?: string }).detail ?? '';
      if (detail.toLowerCase().includes('email')) {
        res.status(409).json({ error: 'An account with that email already exists' });
      } else {
        res.status(409).json({ error: 'Username already taken' });
      }
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
    // Allow login by username OR email (lowercase compare for email).
    const result = await query(
      'SELECT id, password_hash FROM users WHERE username = $1 OR LOWER(email) = LOWER($1)',
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
    const token = jwt.sign(
      { userId: result.rows[0].id },
      process.env.AUTH_SECRET!,
      { expiresIn: '30d' }
    );
    res.json({ token });
  } catch {
    res.status(500).json({ error: 'Failed to login' });
  }
});

router.patch('/change-password', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { currentPassword, newPassword } = req.body;
  const userId = (req as AuthRequest).userId;

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'Current and new password are required' });
    return;
  }
  const pwError = validatePassword(newPassword);
  if (pwError) {
    res.status(400).json({ error: pwError });
    return;
  }
  try {
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
    res.json({ message: 'Password updated successfully' });
  } catch {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

/** Lets existing users (registered before the email requirement) attach an email. */
router.patch('/set-email', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  const userId = (req as AuthRequest).userId;

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Please enter a valid email address' });
    return;
  }

  try {
    await query('UPDATE users SET email = $1 WHERE id = $2', [email.toLowerCase(), userId]);
    res.json({ message: 'Email updated successfully' });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      res.status(409).json({ error: 'That email is already in use by another account' });
      return;
    }
    res.status(500).json({ error: 'Failed to update email' });
  }
});

/** Returns whether the current logged-in user has an email set (for the banner prompt). */
router.get('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    const result = await query(
      'SELECT id, username, email FROM users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

/**
 * Forgot-password — always returns 200 with the same message, regardless of whether
 * the email exists. Prevents email enumeration attacks.
 */
router.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  const genericResponse = { message: 'If that email is registered, a reset link has been sent.' };

  if (!isValidEmail(email)) {
    res.json(genericResponse);
    return;
  }

  try {
    const userResult = await query(
      'SELECT id, username FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (userResult.rows.length === 0) {
      console.log(`forgot-password: no user found with email ${email}`);
    }

    if (userResult.rows.length > 0) {
      const { id: userId, username } = userResult.rows[0];

      // Generate token, store the SHA-256 hash only.
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Invalidate any prior unused tokens for this user (only one active at a time).
      await query(
        'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
        [userId]
      );

      await query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [userId, tokenHash, expiresAt]
      );

      const resetUrl = `${getFrontendUrl()}/reset-password?token=${rawToken}`;
      const { subject, html, text } = passwordResetEmail(resetUrl, username);

      try {
        await sendEmail({ to: email, subject, html, text });
      } catch (sendErr) {
        // Log but still return generic success — never leak.
        console.error('SES sendEmail failed:', sendErr);
      }
    }

    res.json(genericResponse);
  } catch (err) {
    console.error('forgot-password error:', err);
    res.json(genericResponse);
  }
});

router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    res.status(400).json({ error: 'Token and new password are required' });
    return;
  }

  const pwError = validatePassword(newPassword);
  if (pwError) {
    res.status(400).json({ error: pwError });
    return;
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const tokenResult = await query(
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = $1
         AND expires_at > NOW()
         AND used_at IS NULL`,
      [tokenHash]
    );

    if (tokenResult.rows.length === 0) {
      res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
      return;
    }

    const userId = tokenResult.rows[0].user_id;
    const newHash = await bcrypt.hash(newPassword, 10);

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
    await query('UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1', [tokenHash]);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export { router as authRouter };
