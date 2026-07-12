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

-- bets ledger. games referenced by nba_game_id without a FK because a bet may
-- be logged from the ESPN odds snapshot before the games row exists. line is
-- stored relative to the selected side; moneyline bets have no line.
CREATE TABLE IF NOT EXISTS bets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nba_game_id VARCHAR(20) NOT NULL,
    home_team VARCHAR(100) NOT NULL,
    away_team VARCHAR(100) NOT NULL,
    game_date DATE NOT NULL,
    market VARCHAR(10) NOT NULL CHECK (market IN ('spread', 'total', 'moneyline')),
    selection VARCHAR(5) NOT NULL CHECK (selection IN ('home', 'away', 'over', 'under')),
    line NUMERIC(5,1),
    american_odds INTEGER NOT NULL,
    stake NUMERIC(10,2) NOT NULL CHECK (stake > 0),
    status VARCHAR(7) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'push')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    settled_at TIMESTAMPTZ,
    CHECK ((market = 'moneyline') = (line IS NULL))
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

CREATE INDEX IF NOT EXISTS idx_players_team ON players(team);
CREATE INDEX IF NOT EXISTS idx_players_position ON players(position);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_games_date ON games(game_date);
CREATE INDEX IF NOT EXISTS idx_chat_history_context ON chat_history(context_type, context_id);
