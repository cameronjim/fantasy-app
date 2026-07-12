-- Migration: add display name + phone to users for the /profile page.
-- Both nullable; existing users start with both unset and can fill them in.
-- Run on Neon SQL editor (or psql) on each environment (prod and dev) once.

ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
