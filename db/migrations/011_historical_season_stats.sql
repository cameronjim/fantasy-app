-- Historical season-by-season player and team stats.
--
-- Deliberately NOT foreign-keyed to players/teams. Those tables hold only the
-- current roster and are churned on every scrape (rows with a null nba_id are
-- deleted), while these tables hold retired players and defunct franchises
-- (Vancouver Grizzlies, Seattle SuperSonics, New Jersey Nets, Kansas City
-- Kings). Join at query time on nba_player_id = players.nba_id when a current
-- player needs linking.
--
-- Every stat column is nullable: the NBA API's coverage thins out the further
-- back you go, and advanced measures (off/def/net rating) only exist from
-- 1996-97 onward. Writing NULL is how we record "the API did not report this",
-- which is different from a real 0.
--
-- Idempotent: safe to run more than once.

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
