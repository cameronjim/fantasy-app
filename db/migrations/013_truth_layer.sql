-- Data truth layer: schedule, per-game logs, and one status row per
-- scheduled player-game (played or not) -- the training universe for
-- availability prediction. Ids are TEXT throughout: NBA game ids carry
-- leading zeros and stop being valid the moment something parses them as a
-- number. Not foreign-keyed to players/teams, which churn on every scrape;
-- join at query time on nba_player_id = players.nba_id. Idempotent.

CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
    id SERIAL PRIMARY KEY,
    -- schedule | game_logs_incremental | game_status_incremental |
    -- game_logs_backfill | game_status_backfill
    kind TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- NULL while running; a killed run stays 'running' forever
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    -- game dates for an incremental sync, season labels for a backfill
    watermark_from TEXT,
    watermark_to TEXT,
    rows_written INTEGER,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_kind
  ON ingestion_runs (kind, started_at DESC);

-- every scheduled game, played or not, populated ahead of tip-off. separate
-- from `games` (ESPN ids, scoreboard only) -- these are stats.nba.com ids.
CREATE TABLE IF NOT EXISTS nba_schedule (
    id SERIAL PRIMARY KEY,
    nba_game_id TEXT NOT NULL UNIQUE,
    season TEXT NOT NULL,
    season_type TEXT NOT NULL,
    -- Eastern game date, not UTC: a 10pm ET tip is the next day in UTC
    game_date DATE NOT NULL,
    scheduled_at TIMESTAMPTZ,
    home_team_id TEXT,
    away_team_id TEXT,
    home_team_abbr TEXT,
    away_team_abbr TEXT,
    game_status TEXT,
    -- NULL for almost every game; non-null marks a postponement
    postponed_status TEXT,
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nba_schedule_date
  ON nba_schedule (game_date);
CREATE INDEX IF NOT EXISTS idx_nba_schedule_season
  ON nba_schedule (season, season_type);

-- one row per player per game they recorded a line for (the outcome side;
-- player_game_status below is the universe side)
CREATE TABLE IF NOT EXISTS player_game_logs (
    id SERIAL PRIMARY KEY,
    nba_player_id TEXT NOT NULL,
    nba_game_id TEXT NOT NULL,
    season TEXT NOT NULL,
    season_type TEXT NOT NULL,
    game_date DATE NOT NULL,
    team_id TEXT,
    team_abbr TEXT,
    opponent_team_id TEXT,
    is_home BOOLEAN,
    -- NULL, not FALSE, when the source doesn't report a starting five
    started BOOLEAN,
    minutes NUMERIC(5,2),
    pts SMALLINT,
    reb SMALLINT,
    ast SMALLINT,
    stl SMALLINT,
    blk SMALLINT,
    tov SMALLINT,
    fgm SMALLINT,
    fga SMALLINT,
    fg3m SMALLINT,
    fg3a SMALLINT,
    ftm SMALLINT,
    fta SMALLINT,
    plus_minus SMALLINT,
    -- raw box-score comment verbatim, e.g. "DNP - Coach's Decision".
    -- NULL means no comment was reported, i.e. he played.
    dnp_reason TEXT,
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ingestion_run_id INTEGER REFERENCES ingestion_runs (id) ON DELETE SET NULL,
    UNIQUE (nba_player_id, nba_game_id)
);

CREATE INDEX IF NOT EXISTS idx_player_game_logs_player_date
  ON player_game_logs (nba_player_id, game_date);
CREATE INDEX IF NOT EXISTS idx_player_game_logs_season
  ON player_game_logs (season);
CREATE INDEX IF NOT EXISTS idx_player_game_logs_game
  ON player_game_logs (nba_game_id);

-- one row per team per game, two rows per game
CREATE TABLE IF NOT EXISTS team_game_logs (
    id SERIAL PRIMARY KEY,
    team_id TEXT NOT NULL,
    nba_game_id TEXT NOT NULL,
    season TEXT NOT NULL,
    season_type TEXT NOT NULL,
    game_date DATE NOT NULL,
    team_abbr TEXT,
    opponent_team_id TEXT,
    is_home BOOLEAN,
    minutes NUMERIC(6,2),
    pts SMALLINT,
    reb SMALLINT,
    ast SMALLINT,
    stl SMALLINT,
    blk SMALLINT,
    tov SMALLINT,
    fgm SMALLINT,
    fga SMALLINT,
    fg3m SMALLINT,
    fg3a SMALLINT,
    ftm SMALLINT,
    fta SMALLINT,
    plus_minus SMALLINT,
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ingestion_run_id INTEGER REFERENCES ingestion_runs (id) ON DELETE SET NULL,
    UNIQUE (team_id, nba_game_id)
);

CREATE INDEX IF NOT EXISTS idx_team_game_logs_season
  ON team_game_logs (season);
CREATE INDEX IF NOT EXISTS idx_team_game_logs_game
  ON team_game_logs (nba_game_id);
CREATE INDEX IF NOT EXISTS idx_team_game_logs_team_date
  ON team_game_logs (team_id, game_date);

-- one row per scheduled player-game, played or not: the availability model's
-- training universe. played / listed_inactive / rostered are NOT redundant:
-- a healthy scratch and a listed-inactive injury are different signals.
CREATE TABLE IF NOT EXISTS player_game_status (
    id SERIAL PRIMARY KEY,
    nba_player_id TEXT NOT NULL,
    nba_game_id TEXT NOT NULL,
    team_id TEXT,
    rostered BOOLEAN NOT NULL,
    -- NULL when the inactive list hasn't been fetched yet, never coerced to
    -- FALSE -- "unknown" collapsing into "active" is the bias this exists to avoid
    listed_inactive BOOLEAN,
    started BOOLEAN,
    played BOOLEAN NOT NULL,
    dnp_reason TEXT,
    minutes NUMERIC(5,2),
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ingestion_run_id INTEGER REFERENCES ingestion_runs (id) ON DELETE SET NULL,
    UNIQUE (nba_player_id, nba_game_id)
);

CREATE INDEX IF NOT EXISTS idx_player_game_status_player
  ON player_game_status (nba_player_id);
CREATE INDEX IF NOT EXISTS idx_player_game_status_game
  ON player_game_status (nba_game_id);

-- which team a player belonged to over which span, so a trade doesn't leak
-- backwards into pre-trade rows. valid_to NULL means the stint is open.
CREATE TABLE IF NOT EXISTS player_team_stints (
    id SERIAL PRIMARY KEY,
    nba_player_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (nba_player_id, team_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_player_team_stints_player
  ON player_team_stints (nba_player_id, valid_from);

-- at most one open stint per player, enforced rather than assumed
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_team_stints_one_open
  ON player_team_stints (nba_player_id)
  WHERE valid_to IS NULL;

-- append-only injury designations. append-only because the model asks "what
-- was known at the time", which an update-in-place table can't answer.
CREATE TABLE IF NOT EXISTS player_injury_reports (
    id SERIAL PRIMARY KEY,
    nba_player_id TEXT NOT NULL,
    -- NULL for a general designation not tied to a specific game
    nba_game_id TEXT,
    -- when we scraped it; the one timestamp guaranteed present
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    report_as_of TIMESTAMPTZ,
    status_raw TEXT,
    -- out | doubtful | questionable | probable | day_to_day | available | unknown
    status_normalized TEXT,
    reason TEXT,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_injury_reports_player_captured
  ON player_injury_reports (nba_player_id, captured_at DESC);
