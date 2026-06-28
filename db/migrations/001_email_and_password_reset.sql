-- Migration: Add email to users + create password_reset_tokens table
-- Run on Neon SQL editor (or psql) once.

-- 1. Add email column. Nullable for backwards compat — existing users will be prompted
--    to set their email so they can use forgot-password.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- Case-insensitive uniqueness (only when email is set).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

-- 2. Password reset tokens. We store a SHA-256 hash of the token, never the raw value.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at);
