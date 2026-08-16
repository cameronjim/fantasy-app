CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    nba_id VARCHAR(20) UNIQUE,
    name VARCHAR(100) NOT NULL,
    team VARCHAR(50),
    position VARCHAR(20),
    points_per_game NUMERIC(5,1) DEFAULT 0,
    rebounds_per_game NUMERIC(5,1) DEFAULT 0,
    assists_per_game NUMERIC(5,1) DEFAULT 0,
    steals_per_game NUMERIC(4,1) DEFAULT 0,
    blocks_per_game NUMERIC(4,1) DEFAULT 0,
    field_goal_percentage NUMERIC(5,1) DEFAULT 0,
    three_point_percentage NUMERIC(5,1) DEFAULT 0,
    free_throw_percentage NUMERIC(5,1) DEFAULT 0,
    three_pointers_made NUMERIC(4,1) DEFAULT 0,
    turnovers_per_game NUMERIC(4,1) DEFAULT 0,
    minutes_per_game NUMERIC(5,1) DEFAULT 0,
    games_played INTEGER DEFAULT 0,
    injury_status VARCHAR(50),
    injury_detail VARCHAR(255),
    headshot_url VARCHAR(500),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    nba_id VARCHAR(20) UNIQUE,
    name VARCHAR(100) NOT NULL,
    abbreviation VARCHAR(10),
    conference VARCHAR(10),
    division VARCHAR(20),
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    points_per_game NUMERIC(5,1) DEFAULT 0,
    rebounds_per_game NUMERIC(5,1) DEFAULT 0,
    assists_per_game NUMERIC(5,1) DEFAULT 0,
    steals_per_game NUMERIC(4,1) DEFAULT 0,
    blocks_per_game NUMERIC(4,1) DEFAULT 0,
    field_goal_percentage NUMERIC(5,1) DEFAULT 0,
    three_point_percentage NUMERIC(5,1) DEFAULT 0,
    free_throw_percentage NUMERIC(5,1) DEFAULT 0,
    turnovers_per_game NUMERIC(4,1) DEFAULT 0,
    defensive_rating NUMERIC(5,1) DEFAULT 0,
    offensive_rating NUMERIC(5,1) DEFAULT 0,
    net_rating NUMERIC(5,1) DEFAULT 0,
    logo_url VARCHAR(500),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    nba_game_id VARCHAR(20) UNIQUE,
    home_team VARCHAR(100) NOT NULL,
    away_team VARCHAR(100) NOT NULL,
    game_date DATE NOT NULL,
    home_score INTEGER,
    away_score INTEGER,
    status VARCHAR(50) DEFAULT 'Scheduled',
    arena VARCHAR(100),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255),
    password_hash TEXT,
    google_id VARCHAR(64) UNIQUE,
    name VARCHAR(100),
    phone VARCHAR(30),
    -- server-enforced admin role; granted manually, never via signup.
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at);

CREATE TABLE IF NOT EXISTS my_roster (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, player_id)
);

CREATE TABLE IF NOT EXISTS analysis_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    roster_hash VARCHAR(64) NOT NULL,
    analysis JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS waiver_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    roster_hash VARCHAR(64) NOT NULL,
    suggestions JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- bets ledger. straight bets (spread/total/moneyline) settle automatically
-- from final scores; prop/parlay/custom entries are free text and settle
-- manually. game fields nullable for multi-game and off-book bets. no money
-- columns: the ledger tracks outcomes, not stakes.
CREATE TABLE IF NOT EXISTS bets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    market VARCHAR(10) NOT NULL CHECK (market IN ('spread', 'total', 'moneyline', 'prop', 'parlay', 'custom')),
    nba_game_id VARCHAR(20),
    home_team VARCHAR(100),
    away_team VARCHAR(100),
    game_date DATE,
    selection VARCHAR(5) CHECK (selection IN ('home', 'away', 'over', 'under')),
    line NUMERIC(5,1),
    american_odds INTEGER,
    description VARCHAR(300),
    stake NUMERIC(10,2) CHECK (stake > 0),
    wager_type VARCHAR(12) NOT NULL DEFAULT 'cash' CHECK (wager_type IN ('cash', 'bonus_bet', 'odds_boost')),
    status VARCHAR(7) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'push')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS betting_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    odds_hash VARCHAR(64) NOT NULL,
    picks JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_history (
    id SERIAL PRIMARY KEY,
    context_type VARCHAR(50) NOT NULL,
    context_id INTEGER NOT NULL,
    role VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- one row per SPA navigation, posted by the frontend tracker. user_id is null
-- for logged-out visitors; ON DELETE SET NULL keeps history if a user is removed.
-- only the pathname is stored (never query strings — reset tokens live there).
CREATE TABLE IF NOT EXISTS page_views (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    path VARCHAR(300) NOT NULL,
    referrer VARCHAR(300),
    user_agent VARCHAR(300),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_user ON page_views(user_id, created_at DESC);

-- fixed-window request counters backing the app-level rate limiter. one row
-- per (bucket, window_start); buckets are scope-prefixed, e.g. 'login:1.2.3.4'.
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- season-by-season history, one row per player per season. deliberately not
-- foreign-keyed to players: that table is churned on every scrape and holds
-- only current players, while this one holds retired players too. join on
-- nba_player_id = players.nba_id when linking is needed. every stat column is
-- nullable — NULL records "the API did not report this", not a real 0.
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
    UNIQUE (nba_player_id, season)
);

-- one row per team per season. team_abbreviation is whatever the API reported
-- for that season, so defunct franchises (SEA, VAN, NJN, KCK) keep their own
-- identity instead of being mapped onto a current team. ratings are nullable
-- because the advanced measure type only goes back to 1996-97.
CREATE TABLE IF NOT EXISTS team_season_stats (
    id SERIAL PRIMARY KEY,
    nba_team_id VARCHAR(20) NOT NULL,
    team_name VARCHAR(100) NOT NULL,
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
    defensive_rating NUMERIC(5,1),
    offensive_rating NUMERIC(5,1),
    net_rating NUMERIC(5,1),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (nba_team_id, season)
);

-- NBA 2K ratings, via the public nba2kapi.com endpoint (data from
-- 2kratings.com). Key-value rather than wide because 2K reshuffles its
-- attribute and badge sets every game year and there is no migration runner —
-- a wide table would need a new migration every September. Not foreign-keyed to
-- players: 2K publishes no NBA player id (the only link is normalized_name),
-- and most rows are classic/all-time cards with no current roster spot. slug is
-- 2K's own identifier and is globally unique across all three roster types.
CREATE TABLE IF NOT EXISTS nba_2k_players (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(120) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    -- accent-, suffix-, and punctuation-stripped name, written by the scraper's
    -- _normalize_name. stored so linking to players is an indexed equality test.
    normalized_name VARCHAR(100) NOT NULL,
    team VARCHAR(60),
    -- curr = current rosters, class = classic teams, allt = all-time teams.
    team_type VARCHAR(10) NOT NULL,
    overall SMALLINT,
    -- comma-joined, matching the convention players.position uses.
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

-- 35 rows per rated card in 2K27. value is nullable, and a card can legitimately
-- have no attribute rows at all — unrated rookies carry an overall and nothing else.
CREATE TABLE IF NOT EXISTS nba_2k_attributes (
    player_slug VARCHAR(120) NOT NULL
        REFERENCES nba_2k_players (slug) ON DELETE CASCADE,
    attribute_name VARCHAR(40) NOT NULL,
    value SMALLINT,
    PRIMARY KEY (player_slug, attribute_name)
);

-- tiers observed: Legendary, Hall of Fame, Gold, Silver, Bronze.
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

-- a card's overall in every 2K game it appeared in, 2K10 onward. delta is
-- nullable: the oldest entry has nothing to diff against.
CREATE TABLE IF NOT EXISTS nba_2k_rating_history (
    player_slug VARCHAR(120) NOT NULL
        REFERENCES nba_2k_players (slug) ON DELETE CASCADE,
    game_version VARCHAR(10) NOT NULL,
    overall SMALLINT,
    delta SMALLINT,
    PRIMARY KEY (player_slug, game_version)
);

CREATE INDEX IF NOT EXISTS idx_players_team ON players(team);
CREATE INDEX IF NOT EXISTS idx_players_position ON players(position);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_games_date ON games(game_date);
CREATE INDEX IF NOT EXISTS idx_chat_history_context ON chat_history(context_type, context_id);
CREATE INDEX IF NOT EXISTS idx_player_season_stats_season ON player_season_stats(season, points_per_game DESC);
CREATE INDEX IF NOT EXISTS idx_player_season_stats_name ON player_season_stats(player_name);
CREATE INDEX IF NOT EXISTS idx_team_season_stats_season ON team_season_stats(season);
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_team_type_overall ON nba_2k_players(team_type, overall DESC);
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_overall ON nba_2k_players(overall DESC);
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_name ON nba_2k_players(name);
CREATE INDEX IF NOT EXISTS idx_nba_2k_players_normalized_name ON nba_2k_players(normalized_name);
