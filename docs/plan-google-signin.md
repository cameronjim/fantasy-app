# Plan — Sign in with Google

## Goal

Let users sign in with their Google account instead of (or in addition to) username/password. Keeps the existing auth working for legacy accounts.

---

## Approach: Google Identity Services (the modern way)

Google's recommended client-side library is **GIS** (`google.accounts.id`). It surfaces a "Sign in with Google" button that returns a signed JWT (the ID token). The backend verifies the JWT and either logs the user in or creates a new account.

Why GIS over older flows:
- No backend OAuth dance / redirect URL juggling
- The button works as a One Tap / web component you drop into a React page
- Verified by Google, signed JWT means we can trust the email without an extra API call

---

## What you need from Google Cloud Console (one-time)

1. Create a project at https://console.cloud.google.com (or use an existing one)
2. APIs & Services → OAuth consent screen:
   - User type: **External**
   - App name: Fantasy NBA
   - Support email: your email
   - Authorized domains: `cameronjim.com`
   - Scopes: `openid`, `profile`, `email`
3. APIs & Services → Credentials → Create credentials → **OAuth 2.0 Client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://fantasy-nba.cameronjim.com`, `http://localhost:5173`
   - Authorized redirect URIs: (not needed for GIS, but add them just in case)
4. Copy the **Client ID** — this is public and goes in `frontend/.env` as `VITE_GOOGLE_CLIENT_ID`. **No client secret needed** for the GIS flow.

---

## Schema

```sql
ALTER TABLE users ADD COLUMN google_id VARCHAR(64) UNIQUE;
-- Existing password_hash stays nullable, so Google-only users have no local password
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
```

`google_id` = the `sub` claim from Google's ID token. Stable, never changes.

---

## Backend

**New endpoint:** `POST /api/auth/google`

Body: `{ credential: "<google-id-token-jwt>" }`

```ts
import { OAuth2Client } from 'google-auth-library';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'credential required' });

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
  } catch {
    return res.status(401).json({ error: 'invalid Google credential' });
  }

  const payload = ticket.getPayload();
  if (!payload?.email || !payload?.sub) return res.status(401).json({ error: 'malformed token' });

  const googleId = payload.sub;
  const email = payload.email.toLowerCase();

  // Match-or-create logic:
  // 1) Existing google_id → log them in
  // 2) Existing email → link the google_id to that account
  // 3) Brand new → create a user (username = derive from email)
  let userResult = await query('SELECT id FROM users WHERE google_id = $1', [googleId]);

  if (userResult.rows.length === 0) {
    const byEmail = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (byEmail.rows.length > 0) {
      await query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, byEmail.rows[0].id]);
      userResult = byEmail;
    } else {
      // Create new account. Username = email prefix + random digits if taken.
      const baseUsername = email.split('@')[0].replace(/[^a-z0-9]/g, '');
      const username = await findFreeUsername(baseUsername);
      const insert = await query(
        'INSERT INTO users (username, email, google_id, password_hash) VALUES ($1, $2, $3, NULL) RETURNING id',
        [username, email, googleId]
      );
      userResult = insert;
    }
  }

  const token = jwt.sign({ userId: userResult.rows[0].id }, process.env.AUTH_SECRET!, { expiresIn: '30d' });
  res.json({ token });
});
```

`findFreeUsername` is a helper that tries `${base}`, then `${base}1`, `${base}2`, ..., picking the first free one.

**New env var on Lambda:** `GOOGLE_CLIENT_ID` (same value as the frontend's, no secret).

**Dependency:** `npm install google-auth-library`

---

## Frontend

Install the GIS React wrapper for ergonomics:

```bash
npm install @react-oauth/google
```

Wrap the app in the provider in `App.tsx`:

```tsx
import { GoogleOAuthProvider } from '@react-oauth/google';

<GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
  <BrowserRouter>...</BrowserRouter>
</GoogleOAuthProvider>
```

Add the button on `LoginPage` and `RegisterPage`:

```tsx
import { GoogleLogin } from '@react-oauth/google';

<GoogleLogin
  onSuccess={async (credentialResponse) => {
    const { data } = await api.post('/auth/google', { credential: credentialResponse.credential });
    setAuthToken(data.token);
    onLogin();
    navigate(redirectTo, { replace: true });
  }}
  onError={() => setError('Google sign-in failed')}
/>
```

Place it above the username/password form, with a "— or —" divider between.

---

## UX considerations

- **Existing users with email already set**: Their first Google sign-in auto-links by email (no duplicate accounts).
- **Existing users without email**: They can't auto-link. We should add a "Link Google" button in Account dropdown for already-logged-in users that calls a separate `POST /api/auth/google/link` endpoint protected by `requireAuth`.
- **Google-only users (no password)**: Need to prevent the existing password-based login from showing "Invalid password" when they accidentally use the password form. We could (a) require they sign in with Google when no `password_hash` exists, or (b) let them set a password via the existing change-password flow. Option (a) is simpler — show a banner: "This account signs in with Google. [Sign in with Google]"
- **Forgot password**: Doesn't apply to Google-only users. The forgot-password page should detect a Google-only account and tell them to use Google instead. Easiest: add a check in `/auth/forgot-password` — if no `password_hash`, skip and return the same generic message.

---

## Security notes

- GIS ID tokens are signed by Google. `verifyIdToken` validates the signature + audience + expiration. Don't skip verification.
- Don't expose the client ID as if it were a secret — it's public-by-design.
- Don't let users set their own `google_id` via any API route. Only `/auth/google` should write it.

---

## Phasing (build order)

1. **Schema migration + backend endpoint + google-auth-library install** — 30 min
2. **Frontend button on LoginPage + RegisterPage** — 30 min
3. **"Link Google" in Account dropdown for existing users** — optional polish, 30 min
4. **Handle Google-only users on the forgot-password page** — 15 min, edge case
5. **Test with a fresh Google account, an existing email-matched account, and an existing google_id-matched account** — make sure all three branches work

---

## What I'd recommend keeping out of v1

- Sign-in with Apple — same idea, more setup.
- Account linking flows where one user has both methods and we let them unlink — niche, complex.
- Profile picture sync from Google — nice-to-have but adds image hosting concerns.
