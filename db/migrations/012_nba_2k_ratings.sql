-- NBA 2K player ratings, sourced from the public nba2kapi.com endpoint (which
-- itself mirrors 2kratings.com). 2K's ratings are Take-Two's; this project is
-- unaffiliated with 2K Sports, Take-Two, or the NBA.
--
-- Narrow / key-value on purpose. 2K reshuffles its attribute and badge sets
-- every September (2K27 currently reports 35 attributes and 5 badge tiers), and
-- this project has no migration runner — every schema change is applied by hand.
-- A wide table would therefore need a new migration every game year just to add
-- and drop columns. Rows instead of columns means a new attribute simply shows
-- up in the data.
--
-- Deliberately NOT foreign-keyed to players. 2K publishes no NBA player ids, so
-- the only link is by name (see normalized_name below), and this table holds
-- 1,100+ classic and all-time players who are not on any current roster.
--
-- Idempotent: safe to run more than once.

-- One row per 2K player card. slug is 2K's own identifier and is globally
-- unique across all three roster types — a classic card gets its own slug
-- (e.g. "steven-hunter-2007-08-denver-nuggets"), so the same human can appear
-- as several rows without colliding.
CREATE TABLE IF NOT EXISTS nba_2k_players (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(120) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    -- accent-, suffix-, and punctuation-stripped form of name, written by the
    -- scraper's _normalize_name. The ONLY way to link a 2K card to a row in
    -- players, because 2K exposes no NBA player id. Kept as a stored column so
    -- the lookup is an indexed equality test rather than a per-row function.
    normalized_name VARCHAR(100) NOT NULL,
    team VARCHAR(60),
    -- curr = current NBA rosters, class = classic teams, allt = all-time teams.
    team_type VARCHAR(10) NOT NULL,
    overall SMALLINT,
    -- comma-joined, matching the convention players.position already uses
    -- (2K reports at most two, e.g. "PG,SG").
    positions VARCHAR(20),
    game_version VARCHAR(10),
    archetype VARCHAR(60),
    -- only ~14% of cards carry a build, so nullable rather than defaulted.
    build VARCHAR(60),
    height VARCHAR(10),
    weight VARCHAR(15),
    wingspan VARCHAR(10),
    player_image TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- the listing reads one roster type ordered by rating, which is the whole query.
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_team_type_overall
  ON nba_2k_players (team_type, overall DESC);
-- ordering the unfiltered listing, and "best players in 2K" style reads.
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_overall
  ON nba_2k_players (overall DESC);
-- name search.
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_name
  ON nba_2k_players (name);
-- resolving an app player to their 2K card by name.
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_normalized_name
  ON nba_2k_players (normalized_name);

-- Key-value attributes: 35 rows per rated card in 2K27. value is nullable
-- because a card can exist before 2K rates it — four 2026 rookies currently
-- have an overall but zero attributes, and that is a normal outcome, not an
-- ingest failure.
CREATE TABLE IF NOT EXISTS nba_2k_attributes (
    player_slug VARCHAR(120) NOT NULL
        REFERENCES nba_2k_players (slug) ON DELETE CASCADE,
    attribute_name VARCHAR(40) NOT NULL,
    value SMALLINT,
    PRIMARY KEY (player_slug, attribute_name)
);

-- Badges as returned by the API: category, description, imageUrl, name, tier.
-- Tiers observed are Legendary, Hall of Fame, Gold, Silver, Bronze (up to 33
-- badges on one card). The source data has one card carrying the same badge
-- name twice at different tiers, so the scraper keeps the first (highest)
-- occurrence and this primary key holds.
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

-- A card's overall across every 2K game it appeared in — 2K10 through 2K27 so
-- far, up to 18 entries. delta is nullable because the oldest entry for a card
-- has nothing to diff against and the API omits the key entirely there.
CREATE TABLE IF NOT EXISTS nba_2k_rating_history (
    player_slug VARCHAR(120) NOT NULL
        REFERENCES nba_2k_players (slug) ON DELETE CASCADE,
    game_version VARCHAR(10) NOT NULL,
    overall SMALLINT,
    delta SMALLINT,
    PRIMARY KEY (player_slug, game_version)
);
