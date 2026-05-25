import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { query } from '../db.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { sendEmail, passwordResetEmail } from '../services/email.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
    // Google-only accounts have no password hash — tell the user clearly
    // instead of returning a generic auth failure.
    if (!result.rows[0].password_hash) {
      res.status(401).json({ error: 'This account uses Google Sign-In. Please use the Google button instead.' });
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

/**
 * Sign in (or sign up) via Google. The frontend submits the credential
 * (an ID token JWT from Google Identity Services); we verify it against
 * Google's public keys, then match-or-create the user account.
 *
 * Three branches:
 *   1. Existing google_id  -> log in
 *   2. Existing email      -> link google_id to that account, log in
 *   3. Brand new           -> create user (username derived from email)
 */
router.post('/google', async (req: Request, res: Response): Promise<void> => {
  // Two flows supported:
  //   `credential`   — ID token from the GoogleLogin button (one-tap / default)
  //   `access_token` — from useGoogleLogin implicit flow with select_account
  //                    prompt, used when the user wants to pick a different
  //                    Google account on a device where they're already logged in.
  const { credential, access_token: accessToken } = req.body;
  if (!credential && !accessToken) {
    res.status(400).json({ error: 'credential or access_token is required' });
    return;
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    res.status(500).json({ error: 'Google Sign-In is not configured on the server' });
    return;
  }

  let googleId: string | undefined;
  let email: string | undefined;

  try {
    if (credential) {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      googleId = payload?.sub;
      email = payload?.email?.toLowerCase();
    } else if (accessToken) {
      // Verify the access_token came from our client by hitting Google's
      // tokeninfo endpoint. The response includes sub and email so we don't
      // need a second userinfo call.
      const tokenInfoRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
      );
      if (!tokenInfoRes.ok) {
        res.status(401).json({ error: 'Invalid Google access token' });
        return;
      }
      const info = await tokenInfoRes.json() as {
        aud?: string;
        sub?: string;
        email?: string;
        email_verified?: string | boolean;
      };
      // Critical: only trust tokens issued for OUR client. Otherwise anyone
      // with a valid Google token from any app could log in as that user here.
      if (info.aud !== process.env.GOOGLE_CLIENT_ID) {
        res.status(401).json({ error: 'Access token was not issued for this app' });
        return;
      }
      if (String(info.email_verified) !== 'true') {
        res.status(401).json({ error: 'Google email is not verified' });
        return;
      }
      googleId = info.sub;
      email = info.email?.toLowerCase();
    }
  } catch {
    res.status(401).json({ error: 'Invalid Google credential' });
    return;
  }

  if (!googleId || !email) {
    res.status(401).json({ error: 'Google credential missing required fields' });
    return;
  }

  try {
    // Branch 1: already linked to this google_id?
    let result = await query('SELECT id FROM users WHERE google_id = $1', [googleId]);

    // Branch 2: existing user by email — attach the google_id, unless that
    // user already has a *different* google_id linked (rare edge case but
    // we don't want to silently overwrite a real link).
    if (result.rows.length === 0) {
      const byEmail = await query(
        'SELECT id, google_id FROM users WHERE LOWER(email) = $1',
        [email]
      );
      if (byEmail.rows.length > 0) {
        const existingGoogleId = byEmail.rows[0].google_id;
        if (existingGoogleId && existingGoogleId !== googleId) {
          res.status(409).json({ error: 'This email is already linked to a different Google account.' });
          return;
        }
        await query(
          'UPDATE users SET google_id = $1 WHERE id = $2',
          [googleId, byEmail.rows[0].id]
        );
        result = byEmail;
      }
    }

    // Branch 3: brand new — create the user. Username = email prefix with
    // numeric suffix if needed to dodge the username UNIQUE constraint.
    if (result.rows.length === 0) {
      const base = email.split('@')[0].replace(/[^a-z0-9]/g, '') || 'user';
      let username = base;
      let suffix = 0;
      // 20 tries is plenty for any reasonable collision.
      for (let i = 0; i < 20; i++) {
        const taken = await query('SELECT 1 FROM users WHERE username = $1', [username]);
        if (taken.rows.length === 0) break;
        suffix += 1;
        username = `${base}${suffix}`;
      }

      const created = await query(
        'INSERT INTO users (username, email, google_id, password_hash) VALUES ($1, $2, $3, NULL) RETURNING id',
        [username, email, googleId]
      );
      result = created;
    }

    const token = jwt.sign(
      { userId: result.rows[0].id },
      process.env.AUTH_SECRET!,
      { expiresIn: '30d' }
    );
    res.json({ token });
  } catch {
    res.status(500).json({ error: 'Failed to sign in with Google' });
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

/** Returns the current logged-in user's profile fields (powers the /profile page). */
router.get('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    const result = await query(
      'SELECT id, username, email, name, phone FROM users WHERE id = $1',
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

// lightweight phone validation: digits, spaces, dashes, parens, leading +.
// strict format check happens client-side and via real-world SMS delivery —
// here we just reject obviously-broken inputs.
function isValidPhone(phone: string): boolean {
  if (typeof phone !== 'string') return false;
  if (phone.trim() === '') return true; // empty means "clear the field"
  return /^[+0-9 ().-]{7,30}$/.test(phone.trim());
}

/**
 * Update profile fields. Each field is optional in the body — fields that
 * aren't sent stay unchanged. Sending an empty string clears the field
 * (for name and phone; email cannot be cleared because it's needed for
 * password reset).
 */
router.patch('/profile', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  const { name, email, phone } = req.body as { name?: string; email?: string; phone?: string };

  if (email !== undefined && !isValidEmail(email)) {
    res.status(400).json({ error: 'Please enter a valid email address' });
    return;
  }
  if (phone !== undefined && !isValidPhone(phone)) {
    res.status(400).json({ error: 'Please enter a valid phone number' });
    return;
  }
  if (name !== undefined && name.length > 100) {
    res.status(400).json({ error: 'Name must be 100 characters or fewer' });
    return;
  }

  // build the dynamic SET clause so we only touch fields the client sent.
  // null gets stored when the value is an empty string (for name and phone).
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(name.trim() === '' ? null : name.trim());
  }
  if (email !== undefined) {
    sets.push(`email = $${i++}`);
    params.push(email.toLowerCase().trim());
  }
  if (phone !== undefined) {
    sets.push(`phone = $${i++}`);
    params.push(phone.trim() === '' ? null : phone.trim());
  }

  if (sets.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  params.push(userId);

  try {
    const result = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, username, email, name, phone`,
      params
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      res.status(409).json({ error: 'That email is already in use by another account' });
      return;
    }
    res.status(500).json({ error: 'Failed to update profile' });
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
      } catch {
        // still return generic success so reset state is not exposed
      }
    }

    res.json(genericResponse);
  } catch {
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
  } catch {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export { router as authRouter };
