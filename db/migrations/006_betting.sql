-- Migration: betting feature, user bet ledger + AI picks cache.
-- Run on Neon SQL editor (or psql) on each environment (prod and dev) once.

-- bets ledger. supports straight bets (spread/total/moneyline) that settle
-- automatically from final scores, plus prop/parlay/custom entries described
-- in free text that the user settles manually. game fields are nullable
-- because parlay/custom bets can span games or live on other books entirely.
-- straight-bet lines are stored relative to the selected side (home -6.5
-- means the home team must win by 7+) so settlement is a single comparison.
-- no money columns: the ledger tracks outcomes, not stakes.
CREATE TABLE IF NOT EXISTS bets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    market VARCHAR(10) NOT NULL CHECK (market IN ('spread', 'total', 'moneyline', 'prop', 'parlay', 'custom')),
    nba_game_id VARCHAR(20),
    home_team VARCHAR(100),
    away_team VARCHAR(100),
    game_date DATE,
    selection VARCHAR(5) CHECK (selection IN ('home', 'away', 'over', 'under')),
    line NUMERIC(5,1),
    american_odds INTEGER,
    description VARCHAR(300),
    status VARCHAR(7) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'push')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, created_at DESC);

-- AI betting picks cache, one row per user (same pattern as waiver_cache).
CREATE TABLE IF NOT EXISTS betting_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    odds_hash VARCHAR(64) NOT NULL,
    picks JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
