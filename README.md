# NBA IQ

[![CI](https://github.com/cameronjim/fantasy-app/actions/workflows/ci.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/ci.yml)
[![Deploy](https://github.com/cameronjim/fantasy-app/actions/workflows/deploy.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/deploy.yml)
[![NBA Scraper](https://github.com/cameronjim/fantasy-app/actions/workflows/scraper.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/scraper.yml)

A full-stack fantasy basketball app built on real NBA stats, with AI-powered team
analysis, waiver wire suggestions, game predictions, and a betting picks tab.

**Live app: [nbaiq.cameronjim.com](https://nbaiq.cameronjim.com)**

Player stats, team stats, the live scoreboard, and the odds board are all open to
anyone. Creating a free account (email/password or Google Sign-In) unlocks the
fantasy roster, the Claude-powered analysis surfaces, and the bet tracker.

## Tech Stack

| Layer | Stack |
|---|---|
| **Frontend** | React 18, TypeScript, Vite 6, Tailwind CSS 4, daisyUI 5, React Router 7 |
| **Backend** | Node.js 20, Express 4, TypeScript (ESM) |
| **Database** | PostgreSQL (Neon in production) |
| **ML** | Python, LightGBM |
| **AI** | Anthropic Claude API |
| **Scraper** | Python, `nba_api`, Beautiful Soup |
| **Tests** | Vitest, Supertest, React Testing Library, Playwright, pytest |
| **Infra** | AWS Lambda + API Gateway, S3 + CloudFront, GitHub Actions |

## Features

### Stats (`/`), public

- Searchable, sortable player table with a **Fantasy Score (FS)** column
- Filters for search, team, and position (multi-position aware)
- Teams view with conference filter and offensive/defensive/net ratings
- **Player comparison**: pick up to 3 players and compare side by side
- Live scoreboard strip showing today's games and scores

### Projections and Watchlist, public

- Nightly game-by-game projections across all 9 fantasy categories, with
  confidence ranges and availability estimates
- Watchlist ranks players by projected deviation from their own usual output,
  over a configurable window, with position and team filters — built for
  finding streaming pickups

### 2K Ratings (`/ratings`), public

- Searchable NBA 2K player ratings with a Current / Classic / All-Time toggle
- Full attribute and badge breakdown per player

### My Team and Improve Team, sign-in required

- Build a personal fantasy roster with per-game stats and team averages
- Claude-powered 9-category analysis, trade targets, and waiver pickups
- AI chat for trade and waiver questions, with your roster as context

### Betting (`/betting`), odds board public, picks require sign-in

- Odds board for upcoming games (spread, moneyline, total)
- Claude-generated picks and a suggested parlay, tuned by your preferences
- Bet ledger to track, settle, and delete bets
- Entertainment-only disclaimer and a responsible-gambling notice

### Accounts and settings

- Email/password auth and Google Sign-In
- Password reset by email
- Team Preferences questionnaire that every AI prompt reads from
- 7 themes with a navbar picker

## Documentation

- **[TECHNICAL.md](TECHNICAL.md)** — architecture, data sources, API reference,
  database schema, deployment pipeline
- **[ml/README.md](ml/README.md)** and **[ml/MODEL.md](ml/MODEL.md)** — the
  prediction system
- **[AGENTS.md](AGENTS.md)** — contribution conventions, testing, pre-commit
  checklist

## Contributing

CI gates every pull request: typecheck and tests for the backend, frontend, and
ML package, plus a Playwright E2E suite. See `AGENTS.md` for the style guide.

## License

[MIT](LICENSE), so you are free to use, modify, and distribute it with
attribution.

NBA statistics, team names, and logos are the property of the NBA and its teams.
This project is unaffiliated with the NBA and uses publicly available data for
personal and educational purposes.
