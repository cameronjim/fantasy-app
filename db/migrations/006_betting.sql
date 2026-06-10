-- Migration: betting feature — user bet ledger + AI picks cache.
-- Run on Neon SQL editor (or psql) on each environment (prod and dev) once.

-- bets ledger. games are referenced by nba_game_id without a FK because a bet
-- may be logged from the ESPN odds snapshot before the games row exists.
-- team names and the date are denormalized so the ledger renders without joins.
-- line is stored relative to the selected side (home -6.5 means the home team
-- must win by 7+) so settlement is a single comparison; moneyline has no line.
CREATE TABLE IF NOT EXISTS bets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nba_game_id VARCHAR(20) NOT NULL,
    home_team VARCHAR(100) NOT NULL,
    away_team VARCHAR(100) NOT NULL,
    game_date DATE NOT NULL,
    market VARCHAR(10) NOT NULL CHECK (market IN ('spread', 'total', 'moneyline')),
    selection VARCHAR(5) NOT NULL CHECK (selection IN ('home', 'away', 'over', 'under')),
    line NUMERIC(5,1),
    american_odds INTEGER NOT NULL,
    stake NUMERIC(10,2) NOT NULL CHECK (stake > 0),
    status VARCHAR(7) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'push')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    settled_at TIMESTAMPTZ,
    CHECK ((market = 'moneyline') = (line IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, created_at DESC);

-- AI betting picks cache, one row per user (same pattern as waiver_cache).
CREATE TABLE IF NOT EXISTS betting_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    odds_hash VARCHAR(64) NOT NULL,
    picks JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
