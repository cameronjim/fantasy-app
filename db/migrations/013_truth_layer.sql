-- Data truth layer: the schedule, per-game logs, and one status row per
-- scheduled player-game — the training universe for availability prediction.
--
-- Why these tables exist. A model trained only on recorded game logs answers
-- "how much will he produce GIVEN he plays", which is selection-biased: the
-- Phase 0 feasibility spike measured a conditional mean of 22.5 minutes against
-- an unconditional 15.0 over the games actually on the schedule, so a naive
-- conditional model overstates production by roughly half. The same spike also
-- established that reconstructing rosters from game-log presence is not good
-- enough: it over-predicts availability in every calibration bin, and because a
-- player only enters the reconstructed roster near dates he appeared, it can
-- never represent more than ~16 absences for a player-season. Official
-- per-game inactive lists are therefore a hard requirement, and the schedule
-- has to be first-class so a prediction can be made for tonight's games before
-- any box score exists.
--
-- Ids are TEXT, never INTEGER. NBA game ids carry leading zeros ("0022300061")
-- and stop being valid ids the moment something parses them as a number. Player
-- and team ids are TEXT for consistency with players.nba_id and teams.nba_id,
-- which are already VARCHAR.
--
-- Deliberately NOT foreign-keyed to players or teams, for the same reason
-- migration 011 is not: those tables hold only the current roster and are
-- churned on every scrape (rows with a null nba_id are deleted), while these
-- hold every player who was ever on a scheduled roster, including ones long
-- since waived. Join at query time on nba_player_id = players.nba_id.
--
-- Stat columns are nullable throughout. NULL records "the source did not report
-- this", which is a different fact from a real 0 — the distinction the whole
-- availability model turns on.
--
-- Idempotent: safe to run more than once.

-- ---------------------------------------------------------------------------
-- Bookkeeping: which migrations have run, and which ingestion runs have run.
-- ---------------------------------------------------------------------------

-- This project has no migration runner; migrations are applied by hand in the
-- Neon SQL editor, against two databases (prod and the dev branch). That makes
-- "did I already apply 011 here?" a real question with no answer. This table is
-- the answer. scraper/check_migrations.py reads it, hashes the files on disk,
-- and reports applied / unapplied / checksum-mismatch.
--
-- Deliberately NOT pre-populated with rows for 001-013. Backdating rows that
-- were never actually applied to *this* database would turn an unknown state
-- into a confidently wrong one. The checker treats an empty (or absent) table
-- as "nothing recorded yet" and says so.
CREATE TABLE IF NOT EXISTS schema_migrations (
    -- bare filename, e.g. "013_truth_layer.sql"
    filename TEXT PRIMARY KEY,
    -- sha256 of the file contents at the time it was applied, so an edit to an
    -- already-applied migration is caught instead of silently diverging.
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per scraper phase invocation that writes to the truth layer. Exists
-- so a backfill or an incremental sync can be traced after the fact: which rows
-- came from which run, how far the watermark moved, and whether it finished.
CREATE TABLE IF NOT EXISTS ingestion_runs (
    id SERIAL PRIMARY KEY,
    -- 'schedule', 'game_logs_incremental', 'game_status_incremental',
    -- 'game_logs_backfill', 'game_status_backfill'
    kind TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- NULL while the run is in flight, which is also how a killed run is
    -- recognised afterwards (status stays 'running' forever).
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    -- TEXT, not DATE: the watermark is heterogeneous by design. The incremental
    -- sync records the game dates it covered ("2026-03-01"); the backfill
    -- records the season labels it walked ("2022-23"). One column that is
    -- honest about both beats two columns that are each wrong half the time.
    watermark_from TEXT,
    watermark_to TEXT,
    rows_written INTEGER,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_kind
  ON ingestion_runs (kind, started_at DESC);

-- ---------------------------------------------------------------------------
-- The schedule.
-- ---------------------------------------------------------------------------

-- Every scheduled game, whether or not it has been played. This is the table
-- that makes same-day prediction possible: it is populated from the league
-- schedule endpoint, which publishes the full season in advance, so a row
-- exists for tonight's game hours before any box score does.
--
-- Separate from the existing `games` table on purpose. `games` is populated
-- from ESPN and keys on ESPN's event id (the column is named nba_game_id, but
-- the values are ESPN's). Those ids do not join to anything from stats.nba.com,
-- so mixing the two id spaces in one table would silently break every join in
-- the truth layer. `games` stays the scoreboard's table; this one is the
-- modelling schedule.
CREATE TABLE IF NOT EXISTS nba_schedule (
    id SERIAL PRIMARY KEY,
    -- NBA's own game id, leading zeros intact.
    nba_game_id TEXT NOT NULL UNIQUE,
    season TEXT NOT NULL,
    -- 'Regular Season', 'Playoffs', 'Pre Season', 'All Star', 'PlayIn' —
    -- derivable from the game id prefix when the source does not say.
    season_type TEXT NOT NULL,
    -- the canonical Eastern-time game date, which is what every game log keys
    -- on. NOT the UTC date: a 10pm ET tip is the next day in UTC.
    game_date DATE NOT NULL,
    -- exact tip-off instant when the source publishes one. NULL for games whose
    -- time is not yet set (later playoff rounds are scheduled by date first).
    scheduled_at TIMESTAMPTZ,
    home_team_id TEXT,
    away_team_id TEXT,
    -- as reported by the source for that game, never a lookup through the
    -- current-team maps — same rule migration 011 follows, so a relocated or
    -- defunct franchise keeps the identity it had on the night.
    home_team_abbr TEXT,
    away_team_abbr TEXT,
    -- source-reported status text, e.g. 'Final', '7:30 pm ET', 'PPD'.
    game_status TEXT,
    -- NULL for the overwhelming majority of games. Non-null marks a postponement
    -- so a missing box score can be told apart from a scrape that failed.
    postponed_status TEXT,
    -- which endpoint the row came from ('scheduleleaguev2', 'leaguegamelog').
    -- Kept because the fallback path can only see completed games, so provenance
    -- explains why the future half of a season is sometimes absent.
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "what is on tonight" and "which completed games am I missing logs for".
CREATE INDEX IF NOT EXISTS idx_nba_schedule_date
  ON nba_schedule (game_date);
CREATE INDEX IF NOT EXISTS idx_nba_schedule_season
  ON nba_schedule (season, season_type);

-- ---------------------------------------------------------------------------
-- Box scores.
-- ---------------------------------------------------------------------------

-- One row per player per game they recorded a line for. This is the *outcome*
-- side of the training data; player_game_status below is the universe side.
--
-- Counting stats are SMALLINT: the single-game record for any of them is well
-- under 32,767, and a narrower row means more of the season fits in cache for
-- the rolling-window features the model reads.
CREATE TABLE IF NOT EXISTS player_game_logs (
    id SERIAL PRIMARY KEY,
    nba_player_id TEXT NOT NULL,
    nba_game_id TEXT NOT NULL,
    season TEXT NOT NULL,
    season_type TEXT NOT NULL,
    game_date DATE NOT NULL,
    team_id TEXT,
    -- the abbreviation as reported for that game, so a mid-season trade reads
    -- correctly in hindsight.
    team_abbr TEXT,
    opponent_team_id TEXT,
    is_home BOOLEAN,
    -- NULL rather than FALSE when the source does not report a starting five.
    -- The league-wide game-log endpoints do not; per-game box scores do.
    started BOOLEAN,
    -- decimal minutes, e.g. 34.20 for "34:12". Stored decimal rather than as the
    -- raw "MM:SS" string because every downstream use is arithmetic.
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
    -- the raw COMMENT field from a box score, verbatim: "DNP - Coach's
    -- Decision", "NWT - Injury/Illness - Left Knee; Soreness". Not normalised
    -- here — the exact wording is the most granular reason signal available, and
    -- normalising on write would throw it away permanently. NULL means the
    -- source reported no comment, which for NBA box scores means he played.
    dnp_reason TEXT,
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ingestion_run_id INTEGER REFERENCES ingestion_runs (id) ON DELETE SET NULL,
    -- the upsert target, and what makes a killed backfill resumable.
    UNIQUE (nba_player_id, nba_game_id)
);

-- the rolling-window features read one player in date order.
CREATE INDEX IF NOT EXISTS idx_player_game_logs_player_date
  ON player_game_logs (nba_player_id, game_date);
-- season-scoped validation and per-season model training.
CREATE INDEX IF NOT EXISTS idx_player_game_logs_season
  ON player_game_logs (season);
-- joining a game's players to its schedule row and inactive list.
CREATE INDEX IF NOT EXISTS idx_player_game_logs_game
  ON player_game_logs (nba_game_id);

-- One row per team per game, two rows per game. Doubles as the completed-game
-- schedule: the league game log returns both sides of every played game in a
-- single request, which is how the backfill reconstructs a season's schedule
-- without 1,230 per-game calls.
--
-- No wins/losses column. Those are season-to-date standings, not a property of
-- this game; the result of this game is pts against the opponent row's pts.
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

-- ---------------------------------------------------------------------------
-- The training universe.
-- ---------------------------------------------------------------------------

-- One row per scheduled player-game: every player who was on a roster for a
-- game, whether or not he appeared. This is the table the availability model
-- trains on, and the reason the whole truth layer exists.
--
-- The three booleans are not redundant, and the difference between them is the
-- signal:
--   played           = he recorded a line
--   listed_inactive  = he was on the official inactive list for this game
--   rostered         = played OR listed_inactive OR dressed-but-DNP
-- A healthy scratch (rostered, not inactive, did not play) and a listed-inactive
-- injury are different events with different predictive value, and collapsing
-- them into "no game log" is exactly the approximation the spike rejected.
CREATE TABLE IF NOT EXISTS player_game_status (
    id SERIAL PRIMARY KEY,
    nba_player_id TEXT NOT NULL,
    nba_game_id TEXT NOT NULL,
    team_id TEXT,
    rostered BOOLEAN NOT NULL,
    -- NULL, not FALSE, when the inactive list for this game has not been
    -- fetched yet. "We do not know" and "he was active" must not collapse:
    -- treating unfetched as active is precisely the upward availability bias
    -- the roster approximation suffered from.
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
-- the backfill's resumability check: "which games already have status rows".
CREATE INDEX IF NOT EXISTS idx_player_game_status_game
  ON player_game_status (nba_game_id);

-- ---------------------------------------------------------------------------
-- Slowly-changing dimensions.
-- ---------------------------------------------------------------------------

-- Which team a player belonged to over which span. Needed because "his team" is
-- a moving target: a trade mid-season changes his opponent schedule, his
-- teammates, and his role, and a feature computed against his *current* team
-- would leak the trade backwards into pre-trade rows.
--
-- Closed-open in spirit but stored closed: valid_to is the last date the player
-- was with that team, and NULL means the stint is still open.
CREATE TABLE IF NOT EXISTS player_team_stints (
    id SERIAL PRIMARY KEY,
    nba_player_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- makes re-deriving stints from the same game logs a no-op instead of a
    -- duplicate.
    UNIQUE (nba_player_id, team_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_player_team_stints_player
  ON player_team_stints (nba_player_id, valid_from);

-- A player belongs to exactly one team at a time, so at most one stint may be
-- open. Enforced rather than assumed: the derivation closes the old stint and
-- opens the new one, and a half-applied trade would otherwise leave two open
-- stints that every point-in-time join would silently double.
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_team_stints_one_open
  ON player_team_stints (nba_player_id)
  WHERE valid_to IS NULL;

-- Append-only log of scraped injury designations. Append-only because the
-- question the model asks is "what was known at the time", and an UPDATE-in-
-- place table can only answer "what is true now" — which for a status that
-- flips Questionable -> Out three hours before tip is the wrong answer and a
-- leak. players.injury_status keeps its existing overwrite-in-place behaviour
-- for the UI; this table is the history behind it.
CREATE TABLE IF NOT EXISTS player_injury_reports (
    id SERIAL PRIMARY KEY,
    nba_player_id TEXT NOT NULL,
    -- NULL for a general designation not tied to a specific game, which is what
    -- the CBS injury page publishes. Set when a source names the game.
    nba_game_id TEXT,
    -- when we scraped it. This is the only timestamp guaranteed to be present,
    -- so it is the one point-in-time joins use.
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- when the source says the report was issued, when it says. NULL is common
    -- and is why captured_at exists separately.
    report_as_of TIMESTAMPTZ,
    -- verbatim source wording, e.g. "Game Time Decision", "Out For Season".
    status_raw TEXT,
    -- bucketed for querying: out, doubtful, questionable, probable, day_to_day,
    -- available, unknown. Kept alongside status_raw rather than replacing it —
    -- sources invent new wording every season.
    status_normalized TEXT,
    reason TEXT,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "what was the most recent designation as of time T" — the point-in-time
-- lookup every feature does.
CREATE INDEX IF NOT EXISTS idx_player_injury_reports_player_captured
  ON player_injury_reports (nba_player_id, captured_at DESC);
