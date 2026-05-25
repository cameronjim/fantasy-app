-- Per-user AI preferences for injecting into prompts.
-- Stored as JSONB so we can add new questions without schema migrations.
-- Run on Neon SQL editor.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ai_preferences JSONB DEFAULT '{}'::jsonb NOT NULL;
