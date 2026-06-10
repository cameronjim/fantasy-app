-- Migration: optional money tracking on bets — stake plus the wager kind
-- (cash, bonus bet, odds boost) offered by books like bet365. Both optional:
-- the ledger works fine as a pure pick tracker without amounts.
-- Run on Neon SQL editor (or psql) on each environment (prod and dev) once.

ALTER TABLE bets
    ADD COLUMN IF NOT EXISTS stake NUMERIC(10,2) CHECK (stake > 0),
    ADD COLUMN IF NOT EXISTS wager_type VARCHAR(12) NOT NULL DEFAULT 'cash'
        CHECK (wager_type IN ('cash', 'bonus_bet', 'odds_boost'));
