-- Prediction store. Append-only: a run writes new rows, never edits old ones,
-- so a backtest measures foresight instead of hindsight.

CREATE TABLE IF NOT EXISTS prediction_runs (
    id SERIAL PRIMARY KEY,
    model_version TEXT NOT NULL,
    feature_version TEXT NOT NULL,
    code_sha TEXT,
    trained_through DATE,
    predicted_at TIMESTAMPTZ NOT NULL,
    -- nothing at or after this instant was visible to the run
    forecast_cutoff_at TIMESTAMPTZ NOT NULL,
    artifact_checksum TEXT,
    -- serving only ever reads 'complete'; a killed run leaves a partial slate
    status TEXT NOT NULL DEFAULT 'complete',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prediction_runs_predicted_at
  ON prediction_runs (status, predicted_at DESC);

-- long format: one row per (run, player, game, stat, quantile), since the
-- stat vocabulary grows over time and this pairs conditional/unconditional
-- explicitly instead of implying it from a column name.
--
-- conditional TRUE  = given he plays (the EWMA estimate over appearances)
--             FALSE = over the schedule, i.e. already times P(play)
-- quantile    NULL  = an expected value (mean, not median)
--             0.10/0.50/0.90 = empirical prediction quantiles
--
-- stat vocabulary: bare name is conditional, '<stat>_uncond' is the
-- schedule-level expectation. 'prob_active' is always [0,1], quantile NULL.
CREATE TABLE IF NOT EXISTS player_game_predictions (
    -- BIGSERIAL: append-only across every slate and run outgrows SERIAL
    id BIGSERIAL PRIMARY KEY,
    prediction_run_id INT NOT NULL REFERENCES prediction_runs (id),
    nba_player_id TEXT NOT NULL,
    nba_game_id TEXT NOT NULL,
    game_date DATE NOT NULL,
    stat TEXT NOT NULL,
    quantile NUMERIC(3,2),
    value NUMERIC NOT NULL,
    conditional BOOLEAN NOT NULL,
    UNIQUE (prediction_run_id, nba_player_id, nba_game_id, stat, quantile)
);

-- postgres treats NULL as distinct in a UNIQUE constraint, so expected-value
-- rows (quantile NULL) need this coalesced index to actually dedupe
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_game_predictions_key
  ON player_game_predictions
     (prediction_run_id, nba_player_id, nba_game_id, stat, COALESCE(quantile, -1));

CREATE INDEX IF NOT EXISTS idx_player_game_predictions_player_date
  ON player_game_predictions (nba_player_id, game_date DESC);
CREATE INDEX IF NOT EXISTS idx_player_game_predictions_run
  ON player_game_predictions (prediction_run_id);
