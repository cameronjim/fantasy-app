-- Google Sign-In support.
-- Run on Neon SQL editor.

-- google_id is the stable `sub` claim from Google's ID token.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(64) UNIQUE;

-- Google-only users have no local password; password becomes optional.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
