-- The prediction store: what the model said, when it said it, and what it knew
-- at the time.
--
-- Why this is APPEND-ONLY, and why that is the whole point. A prediction is a
-- claim made at an instant, and the only way to find out whether the model is
-- any good is to compare that claim against what actually happened. The moment
-- a row is updated in place — a refreshed projection overwriting last night's,
-- a "corrected" number after an injury was announced — the backtest silently
-- becomes a measure of hindsight rather than foresight, and nothing downstream
-- can detect it. So a new run writes NEW rows; it never touches old ones. Disk
-- is cheap; an unfalsifiable model is not.
--
-- Two timestamps per run, and they are not the same fact:
--   predicted_at        when the run executed (wall clock).
--   forecast_cutoff_at  the last instant of information the run was allowed to
--                       use. Everything strictly before it is fair game;
--                       everything at or after it is the future being predicted.
-- Keeping them apart is what makes a backtest and a live run comparable: a
-- backtest re-run today for last December has predicted_at = today and
-- forecast_cutoff_at = last December, and only the second one is honest about
-- what the model could see. The ML package's cutoff policy
-- (fnba_ml/config.py::CUTOFF_POLICY) is the same rule stated in Python.
--
-- Ids are TEXT for the same reason as migration 013: NBA game ids carry leading
-- zeros ("0022300061") and stop being valid ids the moment something parses
-- them as a number. Deliberately NOT foreign-keyed to players/nba_schedule —
-- those churn on scrape, these are a permanent record. Join at query time on
-- nba_player_id = players.nba_id.
--
-- Idempotent: safe to run more than once.

-- ---------------------------------------------------------------------------
-- One row per prediction run.
-- ---------------------------------------------------------------------------

-- The provenance record. Given a stored prediction, this table answers "which
-- model, trained on what, from which commit, with what information available"
-- without needing the ML repo state from that day.
--
-- model_version + artifact_checksum tie a run back to ml/models/registry.json,
-- which carries the per-artifact sha256 and the training window; feature_version
-- is bumped whenever feature construction changes in a way that invalidates
-- older artifacts (fnba_ml/config.py::FEATURE_VERSION). A run whose
-- feature_version differs from another's is not comparable to it, even if the
-- model_version looks similar.
CREATE TABLE IF NOT EXISTS prediction_runs (
    id SERIAL PRIMARY KEY,
    -- the ml/models/<version> directory this run scored with, e.g. "2026-08-16".
    model_version TEXT NOT NULL,
    -- fnba_ml.config.FEATURE_VERSION at scoring time, e.g. "v1".
    feature_version TEXT NOT NULL,
    -- git HEAD of the ML code that produced the run. NULL outside a checkout.
    code_sha TEXT,
    -- last game date in the model's training window. Distinct from
    -- forecast_cutoff_at: training may end well before the run is made.
    trained_through DATE,
    -- when the run executed.
    predicted_at TIMESTAMPTZ NOT NULL,
    -- the information boundary. Nothing at or after this instant was visible to
    -- the run; the rows it wrote are claims about that side of the line.
    forecast_cutoff_at TIMESTAMPTZ NOT NULL,
    -- sha256 of the availability model artifact, so a stored prediction can be
    -- traced to the exact bytes that produced it even if the version directory
    -- is later rebuilt.
    artifact_checksum TEXT,
    -- 'complete' | 'running' | 'failed'. The serving path only ever reads
    -- 'complete': a killed run leaves a partial set of player rows, and serving
    -- half a slate is worse than serving none.
    status TEXT NOT NULL DEFAULT 'complete',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- "the newest usable run", which is the first thing the serving query asks.
CREATE INDEX IF NOT EXISTS idx_prediction_runs_predicted_at
  ON prediction_runs (status, predicted_at DESC);

-- ---------------------------------------------------------------------------
-- One row per (run, player, game, stat, quantile).
-- ---------------------------------------------------------------------------

-- Long format rather than one column per stat, because the stat vocabulary is
-- expected to grow (fga/ftm/fta land when the feature set covers them) and a
-- wide table would need a migration for each one. It also makes the
-- conditional/unconditional pairing explicit instead of implied by a column
-- name.
--
-- THE TWO AXES THAT ARE EASY TO CONFUSE:
--
--   `conditional`  TRUE  = "given he plays" — the EWMA champion's estimate over
--                          appearances. This is the number to quote when
--                          answering "how good a night will he have".
--                  FALSE = over the schedule, i.e. already multiplied by
--                          P(play). This is the number to sum for a weekly
--                          total, and it is strictly the smaller of the two.
--                  The spike measured the gap at roughly half: 22.5 conditional
--                  minutes against 15.0 unconditional. Serving one where the
--                  other was meant is not a rounding error.
--
--   `quantile`     NULL  = an expected value (a mean, not a median).
--                  0.10 / 0.50 / 0.90 = empirical prediction quantiles. P50 is
--                  a median and will not equal the NULL-quantile mean for a
--                  skewed stat; that is correct, not a bug.
--
-- Stat vocabulary. The bare name is always the conditional quantity, and the
-- schedule-level expectation carries a `_uncond` suffix, so the two never
-- collide on the uniqueness key:
--   'prob_active'                     P(he plays), unconditional, quantile NULL,
--                                     always in [0,1].
--   'minutes','pts','reb','ast','stl','blk','tov','fg3m','fgm','fga','ftm','fta'
--                                     the conditional per-game estimate.
--   '<stat>_uncond'                   prob_active x the conditional estimate.
-- Not every run writes every stat; the promoted path currently emits minutes,
-- pts and ast, because those are the stats the EWMA champion has state for.
CREATE TABLE IF NOT EXISTS player_game_predictions (
    -- BIGSERIAL, not SERIAL: append-only x ~500 player-games per slate x 13
    -- rows each x a run per day passes 2^31 on a long enough horizon, and the
    -- one thing this table must never do is stop accepting rows.
    id BIGSERIAL PRIMARY KEY,
    prediction_run_id INT NOT NULL REFERENCES prediction_runs (id),
    nba_player_id TEXT NOT NULL,
    nba_game_id TEXT NOT NULL,
    -- denormalised from nba_schedule so the serving query can find "his next
    -- game" without joining the schedule, and so the row still reads correctly
    -- if the game is later rescheduled.
    game_date DATE NOT NULL,
    stat TEXT NOT NULL,
    -- NULL = expected value. See the note above.
    quantile NUMERIC(3,2),
    -- NUMERIC, not a float type: these are stored claims that get compared
    -- against outcomes years later, and binary float drift in an audit trail is
    -- not worth the bytes saved.
    value NUMERIC NOT NULL,
    -- TRUE = "given he plays". Redundant with the stat naming convention by
    -- design: the convention is a convention, this is a column a query can
    -- filter on without knowing it.
    conditional BOOLEAN NOT NULL,
    UNIQUE (prediction_run_id, nba_player_id, nba_game_id, stat, quantile)
);

-- The UNIQUE above does not bite for expected values. Postgres treats NULLs as
-- distinct inside a unique constraint, so two rows differing only by a NULL
-- quantile — which is most of this table — are both accepted. This index is the
-- one that actually prevents a re-run from doubling a slate. -1 is safe as the
-- sentinel: real quantiles are in (0,1).
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_game_predictions_key
  ON player_game_predictions
     (prediction_run_id, nba_player_id, nba_game_id, stat, COALESCE(quantile, -1));

-- the serving query: one player, next game first.
CREATE INDEX IF NOT EXISTS idx_player_game_predictions_player_date
  ON player_game_predictions (nba_player_id, game_date DESC);
-- backtesting and cleanup both walk a whole run.
CREATE INDEX IF NOT EXISTS idx_player_game_predictions_run
  ON player_game_predictions (prediction_run_id);
