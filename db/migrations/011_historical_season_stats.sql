-- Historical season-by-season player and team stats. Not foreign-keyed to
-- players/teams -- those churn on every scrape, these hold retired players
-- and defunct franchises. Join on nba_player_id = players.nba_id at query
-- time. All stat columns nullable: NBA API coverage thins with age.

CREATE TABLE IF NOT EXISTS player_season_stats (
    id SERIAL PRIMARY KEY,
    nba_player_id VARCHAR(20) NOT NULL,
    player_name VARCHAR(100) NOT NULL,
    season VARCHAR(7) NOT NULL,
    team VARCHAR(10),
    games_played INTEGER,
    minutes_per_game NUMERIC(5,1),
    points_per_game NUMERIC(5,1),
    rebounds_per_game NUMERIC(5,1),
    assists_per_game NUMERIC(5,1),
    steals_per_game NUMERIC(4,1),
    blocks_per_game NUMERIC(4,1),
    turnovers_per_game NUMERIC(4,1),
    field_goal_percentage NUMERIC(5,1),
    three_point_percentage NUMERIC(5,1),
    free_throw_percentage NUMERIC(5,1),
    three_pointers_made NUMERIC(4,1),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- the backfill's upsert target, and what makes a killed run resumable.
    UNIQUE (nba_player_id, season)
);

-- the season leaderboard reads one season ordered by scoring.
CREATE INDEX IF NOT EXISTS idx_player_season_stats_season
  ON player_season_stats (season, points_per_game DESC);
-- name search and the season picker's distinct scan.
CREATE INDEX IF NOT EXISTS idx_player_season_stats_name
  ON player_season_stats (player_name);

CREATE TABLE IF NOT EXISTS team_season_stats (
    id SERIAL PRIMARY KEY,
    nba_team_id VARCHAR(20) NOT NULL,
    team_name VARCHAR(100) NOT NULL,
    -- whatever the API reported for that season, not a current-team lookup:
    -- SEA/VAN/NJN/KCK no longer exist in the live team maps.
    team_abbreviation VARCHAR(10),
    season VARCHAR(7) NOT NULL,
    games_played INTEGER,
    wins INTEGER,
    losses INTEGER,
    minutes_per_game NUMERIC(5,1),
    points_per_game NUMERIC(5,1),
    rebounds_per_game NUMERIC(5,1),
    assists_per_game NUMERIC(5,1),
    steals_per_game NUMERIC(4,1),
    blocks_per_game NUMERIC(4,1),
    turnovers_per_game NUMERIC(4,1),
    field_goal_percentage NUMERIC(5,1),
    three_point_percentage NUMERIC(5,1),
    free_throw_percentage NUMERIC(5,1),
    -- advanced measure type; only reported from 1996-97 onward, so NULL for
    -- every earlier season rather than a misleading 0.
    defensive_rating NUMERIC(5,1),
    offensive_rating NUMERIC(5,1),
    net_rating NUMERIC(5,1),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (nba_team_id, season)
);

CREATE INDEX IF NOT EXISTS idx_team_season_stats_season
  ON team_season_stats (season);
