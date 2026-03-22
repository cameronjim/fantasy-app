# Fantasy NBA - Full-Stack Fantasy Basketball & Stats App

A full-stack fantasy basketball application with real NBA stats, AI-powered team analysis, and waiver wire suggestions.

## Tech Stack

- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL
- **Scraper**: Python + Scrapy (NBA stats from stats.nba.com)
- **AI**: Anthropic Claude API (claude-sonnet-4-20250514)

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Python 3.10+
- An Anthropic API key

## Setup

### 1. Environment Variables

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:
```
ANTHROPIC_API_KEY=your-anthropic-api-key
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fantasy_nba
```

### 2. Database

Create the database and run the schema:

```bash
createdb fantasy_nba
psql -d fantasy_nba -f db/schema.sql
```

Seed with sample data (40 NBA players, 30 teams, sample games, and a demo fantasy league):

```bash
cd db
npx tsx seed.ts
```

### 3. Scraper (Optional - for live data)

The scraper pulls real stats from the NBA stats API and CBS Sports injury reports.

```bash
cd scraper
pip install -r requirements.txt
python run_scraper.py
```

The scraper hits:
- `stats.nba.com` for player stats, team stats, and today's scoreboard
- `cbssports.com/nba/injuries/` for injury reports

Rate limiting and user agent rotation are built in.

### 4. Backend

```bash
cd backend
npm install
npm run dev
```

Runs on `http://localhost:3001`. API endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/api/players` | GET | List players (search, filter by team/position) |
| `/api/players/:id` | GET | Player detail |
| `/api/teams` | GET | All teams |
| `/api/teams/:id` | GET | Team detail |
| `/api/games` | GET | Today's and recent games |
| `/api/fantasy/leagues` | GET/POST | List or create leagues |
| `/api/fantasy/leagues/:id/teams` | GET/POST | List or create teams in a league |
| `/api/fantasy/teams/:id` | GET | Team roster with player stats |
| `/api/fantasy/teams/:id/roster` | POST | Add player to roster |
| `/api/fantasy/teams/:id/roster/:playerId` | DELETE | Drop player |
| `/api/ai/chat` | POST | AI chat with team/waiver context |
| `/api/ai/team-analysis` | POST | AI team analysis |
| `/api/ai/waiver-suggestions` | POST | AI waiver wire suggestions |

### 5. Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs on `http://localhost:5173` with API requests proxied to the backend.

## Features

### Tab 1: Player & Team Stats
- Searchable, sortable player stats table
- Team stats view toggle
- Player detail modal with injury status
- Live scoreboard strip showing today's games

### Tab 2: My Fantasy Teams
- Create and manage leagues and teams
- View roster with inline player stats
- AI-powered team analysis (strengths, weaknesses, suggestions)
- AI chat with full team context

### Tab 3: Waiver Wire & AI Pickups
- AI-generated pickup and drop suggestions
- Available player search
- One-click add/drop
- AI chat for trade/waiver advice

## Project Structure

```
fantasy_app/
├── .env.example
├── db/
│   ├── schema.sql          # PostgreSQL schema
│   └── seed.ts             # Seed data script
├── scraper/
│   ├── requirements.txt
│   ├── run_scraper.py      # Standalone scraper entry point
│   ├── scrapy.cfg
│   └── nba_scraper/
│       ├── items.py        # Scrapy item definitions
│       ├── middlewares.py   # User agent rotation
│       ├── pipelines.py    # PostgreSQL upsert pipeline
│       ├── settings.py
│       └── spiders/
│           └── nba_stats.py  # NBA stats + injuries spider
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts        # Express app entry
│       ├── db.ts           # PostgreSQL connection pool
│       ├── routes/
│       │   ├── players.ts
│       │   ├── teams.ts
│       │   ├── games.ts
│       │   ├── fantasy.ts
│       │   └── ai.ts
│       └── services/
│           └── ai.ts       # Claude API + context builders
└── frontend/
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── App.tsx
        ├── types.ts
        ├── api/client.ts
        ├── components/     # Navbar, tables, modals, chat, etc.
        └── pages/          # StatsPage, FantasyPage, WaiverPage
```
