-- Fantasy NBA Database Schema

CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    nba_id VARCHAR(20) UNIQUE,
    name VARCHAR(100) NOT NULL,
    team VARCHAR(50),
    position VARCHAR(20),
    ppg NUMERIC(5,1) DEFAULT 0,
    rpg NUMERIC(5,1) DEFAULT 0,
    apg NUMERIC(5,1) DEFAULT 0,
    spg NUMERIC(4,1) DEFAULT 0,
    bpg NUMERIC(4,1) DEFAULT 0,
    fg_pct NUMERIC(5,1) DEFAULT 0,
    three_pct NUMERIC(5,1) DEFAULT 0,
    ft_pct NUMERIC(5,1) DEFAULT 0,
    three_pm NUMERIC(4,1) DEFAULT 0,
    tov NUMERIC(4,1) DEFAULT 0,
    mpg NUMERIC(5,1) DEFAULT 0,
    gp INTEGER DEFAULT 0,
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
    ppg NUMERIC(5,1) DEFAULT 0,
    rpg NUMERIC(5,1) DEFAULT 0,
    apg NUMERIC(5,1) DEFAULT 0,
    spg NUMERIC(4,1) DEFAULT 0,
    bpg NUMERIC(4,1) DEFAULT 0,
    fg_pct NUMERIC(5,1) DEFAULT 0,
    three_pct NUMERIC(5,1) DEFAULT 0,
    ft_pct NUMERIC(5,1) DEFAULT 0,
    tov NUMERIC(4,1) DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS my_roster (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE UNIQUE,
    added_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analysis_cache (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    roster_hash VARCHAR(64) NOT NULL,
    analysis JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS waiver_cache (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    roster_hash VARCHAR(64) NOT NULL,
    suggestions JSONB NOT NULL,
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
