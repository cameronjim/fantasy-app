-- fixed-window request counters backing the app-level rate limiter. one row
-- per (bucket, window_start); the limiter upserts and reads back the count.
-- buckets are scope-prefixed identities, e.g. 'login:1.2.3.4' or 'ai:42'.
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
);

-- supports cheap pruning of expired windows (DELETE ... WHERE window_start < ...).
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
