-- NBA 2K player ratings, sourced from nba2kapi.com (mirrors 2kratings.com).
-- Unaffiliated with 2K Sports, Take-Two, or the NBA.
--
-- Key-value rather than wide columns: 2K reshuffles its attribute/badge sets
-- every year, and this project has no migration runner. Not foreign-keyed to
-- players -- 2K publishes no NBA player id, only a name to match on.

CREATE TABLE IF NOT EXISTS nba_2k_players (
    id SERIAL PRIMARY KEY,
    -- 2K's own id; a classic card gets its own slug, so one player can appear
    -- as several rows without colliding
    slug VARCHAR(120) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    -- accent/suffix/punctuation-stripped, the only link back to players.name
    normalized_name VARCHAR(100) NOT NULL,
    team VARCHAR(60),
    -- curr = current rosters, class = classic teams, allt = all-time teams
    team_type VARCHAR(10) NOT NULL,
    overall SMALLINT,
    -- comma-joined, e.g. "PG,SG"
    positions VARCHAR(20),
    game_version VARCHAR(10),
    archetype VARCHAR(60),
    build VARCHAR(60),
    height VARCHAR(10),
    weight VARCHAR(15),
    wingspan VARCHAR(10),
    player_image TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nba_2k_players_team_type_overall
  ON nba_2k_players (team_type, overall DESC);
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_overall
  ON nba_2k_players (overall DESC);
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_name
  ON nba_2k_players (name);
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_normalized_name
  ON nba_2k_players (normalized_name);

-- value is nullable: a card can exist before 2K rates it
CREATE TABLE IF NOT EXISTS nba_2k_attributes (
    player_slug VARCHAR(120) NOT NULL
        REFERENCES nba_2k_players (slug) ON DELETE CASCADE,
    attribute_name VARCHAR(40) NOT NULL,
    value SMALLINT,
    PRIMARY KEY (player_slug, attribute_name)
);

CREATE TABLE IF NOT EXISTS nba_2k_badges (
    player_slug VARCHAR(120) NOT NULL
        REFERENCES nba_2k_players (slug) ON DELETE CASCADE,
    badge_name VARCHAR(60) NOT NULL,
    tier VARCHAR(20),
    category VARCHAR(40),
    description TEXT,
    image_url TEXT,
    PRIMARY KEY (player_slug, badge_name)
);

-- overall rating across every 2K game a card appeared in
CREATE TABLE IF NOT EXISTS nba_2k_rating_history (
    player_slug VARCHAR(120) NOT NULL
        REFERENCES nba_2k_players (slug) ON DELETE CASCADE,
    game_version VARCHAR(10) NOT NULL,
    overall SMALLINT,
    delta SMALLINT,
    PRIMARY KEY (player_slug, game_version)
);
