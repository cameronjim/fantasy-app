# Fantasy NBA — Full-Stack Fantasy Basketball & Stats App

[![CI](https://github.com/cameronjim/fantasy-app/actions/workflows/ci.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/ci.yml)
[![Deploy](https://github.com/cameronjim/fantasy-app/actions/workflows/deploy.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/deploy.yml)
[![NBA Scraper](https://github.com/cameronjim/fantasy-app/actions/workflows/scraper.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/scraper.yml)

A full-stack fantasy basketball application with real NBA stats, AI-powered team
analysis, waiver wire suggestions, and an AI betting-picks tab. Built end to end
as a portfolio project: real CI/CD, tests at every layer, and a scheduled scraper
that refreshes the data every six hours.

**Live demo: [fantasy-nba.cameronjim.com](https://fantasy-nba.cameronjim.com)**

You can browse player stats, team stats, the live scoreboard, and the odds board
without an account. A free account (email/password or Google Sign-In) unlocks the
fantasy roster, the Claude-powered analysis surfaces, and the bet tracker.

## Tech Stack

| Layer | Stack |
|---|---|
| **Frontend** | React 18, TypeScript (strict), Vite 6, Tailwind CSS 4, daisyUI 5, React Router 7, Axios, `@react-oauth/google`, lucide-react |
| **Backend** | Node.js 20, Express 4, TypeScript (ESM / NodeNext), `pg`, `jsonwebtoken`, `bcryptjs`, `helmet`, `cors` |
| **Database** | PostgreSQL (Neon in production) — hand-written schema plus sequential SQL migrations |
| **AI** | Anthropic Claude API (`@anthropic-ai/sdk`) |
| **Email** | AWS SES v2 (`@aws-sdk/client-sesv2`) for password-reset mail |
| **Scraper** | Python 3.12, `nba_api`, `requests`, Beautiful Soup, `psycopg2` |
| **Tests** | Vitest (unit + API), Supertest, React Testing Library, Playwright |
| **Infra** | AWS Lambda + HTTP API Gateway (Serverless Framework v3), S3 + CloudFront, GitHub Actions |

## Features

### Stats (`/`) — public

- Searchable, sortable player table with a **Fantasy Score (FS)** column
- Filters: free-text search, team dropdown, position pills (PG/SG/SF/PF/C,
  multi-position aware)
- **Infinite scroll** — rows page in via `IntersectionObserver` as you scroll
- Teams view toggle with an **East / West / All** conference filter and team
  offensive, defensive, and net ratings
- **Player comparison** — select up to 3 players and open a side-by-side compare
  modal with per-category winners
- Player detail modal with headshot and injury status/detail
- Live scoreboard strip across the top showing today's games and scores

### My Team (`/fantasy`) — sign-in required

- Add and drop players to build a personal fantasy roster
- Roster table with inline per-game stats and computed team averages
- Claude-powered **9-category analysis** (strengths, weaknesses, suggestions),
  cached server-side and refreshable on demand
- Prompt to complete Team Preferences if you haven't yet

### Improve Team (`/improve`) — sign-in required

- Claude-generated **trade targets** and **waiver wire pickups**, derived from
  your roster's weakest categories
- AI chat for trade/waiver questions with your roster as context

### Betting (`/betting`) — odds board public, picks require sign-in

- **Odds board** for upcoming games (spread, moneyline, total) sourced from the
  ESPN API
- Claude-generated **Best Value / Safe / Hail Mary** picks plus a suggested
  parlay, tuned by your betting preferences
- **Bet ledger** — track, settle, and delete bets with running profit/loss
- AI chat scoped to betting context, plus a betting-terminology glossary
- Entertainment-only disclaimer and responsible-gambling notice

### Accounts & settings

- **Email/password auth** (bcrypt, cost 10) and **Google Sign-In** with
  server-side ID-token verification
- **Password reset by email** via AWS SES — tokens stored as SHA-256 hashes and
  consumed exactly once; forgot-password responds identically for known and
  unknown addresses to prevent account enumeration
- **Profile page** (`/profile`) with My Profile and Change Password tabs
- **Team Preferences questionnaire** (`/preferences`) — 10 questions covering
  risk tolerance, league format, roster construction, trade appetite, schedule
  weighting, rookie appetite, and waiver strategy. Feeds every AI prompt.
- **About page** (`/about`) describing the stack and CI/CD pipeline
- **Developer Tools** (`/admin`) — admin-only dashboard with user count,
  24-hour pageviews, active users, a user list, and pageview breakdowns.
  Authorization is re-checked in the database on every request.

### Cross-cutting

- **7 themes with a picker** in the navbar — `lofi` (Light), Cream, Sage, Slate,
  Ocean, `business` (Dark), Graphite. Two are daisyUI built-ins, five are custom
  themes defined in `frontend/src/index.css`. Choice persists in `localStorage`,
  with a pre-paint script in `index.html` to avoid a flash of the wrong theme.
- **Data-freshness badge** in the navbar — per-source "last updated" times for
  players, teams, and games, polled every 5 minutes
- **Rate limiting** (DB-backed, per IP or per user): login 5/15min,
  register 5/hr, forgot-password 3/hr, reset-password 10/hr, betting picks,
  pageview beacon 300/hr, and a 200/day per-user ceiling on all Claude-backed
  endpoints to bound API spend
- Client-side response caching with background revalidation and warm-up
  prefetching, so tab switches are instant

## Data Sources

| Source | Used for | Notes |
|---|---|---|
| [`stats.nba.com`](https://stats.nba.com) (via `nba_api`) | Player and team per-game stats | Fronted by Akamai, which **blocks AWS and GitHub Actions IP ranges**. Requests from CI can fail; the scraper tolerates this and the app falls back to the last good data in Postgres. |
| ESPN public API (`site.api.espn.com`) | Games, scores, live scoreboard, betting odds | Not IP-blocked from AWS, which is why it — not `cdn.nba.com` — backs the scoreboard and odds board. |
| [CBS Sports](https://www.cbssports.com/nba/injuries/) | Injury reports and specific positions | Parsed with Beautiful Soup. |

## Prerequisites

- Node.js 20+ (CI and the Lambda runtime both use Node 20)
- PostgreSQL 14+
- Python 3.10+ (CI uses 3.12) — only needed to run the scraper
- An Anthropic API key (for the AI features)

## Local Setup

### 1. Environment variables

The backend, scraper, and seed script all read a single `.env` at the **repo
root**. The frontend reads its own `frontend/.env` (Vite only exposes `VITE_`
variables, and only from the frontend directory).

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```

Root `.env`:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `AUTH_SECRET` | yes | JWT signing key. **Must be ≥32 characters and not a placeholder** — `backend/src/config.ts` refuses to boot otherwise. Generate one with `openssl rand -base64 48`. |
| `ANTHROPIC_API_KEY` | for AI features | Anthropic API key |
| `FRONTEND_URL` | no | Comma-separated CORS allow-list. Defaults to `http://localhost:5173,http://localhost:5174`. |
| `GOOGLE_CLIENT_ID` | for Google Sign-In | OAuth client ID, verified server-side |
| `FROM_EMAIL` | for password reset | An SES-verified sender identity |
| `PORT` | no | Backend port, defaults to `3001` |

`frontend/.env`:

| Variable | Description |
|---|---|
| `VITE_API_URL` | Leave empty for local dev — Vite proxies `/api` to `localhost:3001`. Set to the deployed API origin for production builds. |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID. Public by design; it is baked into the bundle. Leave empty to disable the Google button. |

Never put secrets in a `VITE_`-prefixed variable — Vite inlines them into the
static JavaScript at build time.

### 2. Database

Create the database and apply the schema, then the migrations in order:

```bash
createdb fantasy_nba
psql -d fantasy_nba -f db/schema.sql
for f in db/migrations/*.sql; do psql -d fantasy_nba -f "$f"; done
```

See [Database schema and migrations](#database-schema-and-migrations) for what
lives where.

Optionally seed sample players, teams, and games:

```bash
cd db && npx tsx seed.ts
```

> **Note:** `db/seed.ts` currently fails partway through. It inserts players,
> teams, and games successfully, then errors on `fantasy_leagues` /
> `fantasy_teams` / `fantasy_roster` — tables from an archived multi-team league
> design that no longer exist in `db/schema.sql` (the app uses `my_roster`).
> The stats data you need for local development is written before the failure,
> so the app is usable, but expect the command to exit non-zero.

### 3. Backend

```bash
cd backend
npm install
npm run dev      # tsx watch, http://localhost:3001
```

Other scripts: `npm run build` (tsc → `dist/`), `npm start` (run the build),
`npm run typecheck`, `npm run typecheck:tests`, `npm test`,
`npm run test:unit`, `npm run test:api`.

### 4. Frontend

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173, /api proxied to :3001
```

Other scripts: `npm run build`, `npm run preview`, `npm run typecheck`,
`npm run typecheck:e2e`, `npm test`, `npm run test:e2e`
(first run: `npm run test:e2e:install` to fetch the Chromium binary).

### 5. Scraper (optional — for live data)

The scraper is a standalone Python script (`run_scraper.py`); it does not use
Scrapy. It reads `DATABASE_URL` from the repo-root `.env` and upserts directly
into Postgres.

```bash
cd scraper
pip install -r requirements.txt
python run_scraper.py
```

It scrapes players, teams, the scoreboard, and injuries, with retry/backoff and
realistic browser headers. `stats.nba.com` may still refuse requests from cloud
IPs (see [Data Sources](#data-sources)).

## API

Base path `/api`. All responses are JSON.

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | — | Liveness check, used by the post-deploy smoke test |
| `/status` | GET | — | Last-updated timestamps per data source |
| `/status/benchmarks` | GET | — | League benchmarks computed from the player pool |
| `/players` | GET | — | List players (search, team/position filters) |
| `/players/:id` | GET | — | Player detail |
| `/teams` | GET | — | All teams |
| `/teams/:id` | GET | — | Team detail |
| `/games` | GET | — | Today's and recent games |
| `/games/live` | GET | — | Live scoreboard (ESPN-backed) |
| `/auth/register` | POST | — | Create an account (rate limited) |
| `/auth/login` | POST | — | Email/password sign-in (rate limited) |
| `/auth/google` | POST | — | Google Sign-In, ID token verified server-side |
| `/auth/forgot-password` | POST | — | Send a reset email (rate limited) |
| `/auth/reset-password` | POST | — | Consume a reset token (rate limited) |
| `/auth/me` | GET | user | Current user, including the `is_admin` flag |
| `/auth/profile` | PATCH | user | Update profile fields |
| `/auth/change-password` | PATCH | user | Change password |
| `/auth/set-email` | PATCH | user | Set/change email address |
| `/fantasy/roster` | GET | user | Current user's roster |
| `/fantasy/roster` | POST | user | Add a player |
| `/fantasy/roster/:playerId` | DELETE | user | Drop a player |
| `/preferences` | GET / PATCH | user | Team Preferences questionnaire |
| `/ai/chat` | POST | user | AI chat with roster / waiver / betting context |
| `/ai/team-analysis` | GET | user | 9-category team analysis |
| `/ai/waiver-suggestions` | GET | user | Trade targets and waiver pickups |
| `/betting/odds` | GET | — | Odds board for upcoming games |
| `/betting/picks` | GET | user | AI picks and suggested parlay |
| `/betting/bets` | GET / POST | user | List / track bets |
| `/betting/bets/:id` | PATCH / DELETE | user | Settle / remove a bet |
| `/track/pageview` | POST | optional | Pageview beacon (counts anonymous visits) |
| `/admin/users` | GET | admin | User list |
| `/admin/stats` | GET | admin | Totals and 24-hour activity |
| `/admin/views` | GET | admin | Pageview breakdown |

`/api/ai/*` additionally enforces a 200-request/day per-user cap.

## Architecture

```
                        GitHub Actions cron (every 6h)
                                    │
    stats.nba.com ─┐                ▼
    ESPN API ──────┼──────► scraper/run_scraper.py ──► upsert
    CBS Sports ────┘                                     │
                                                         ▼
  Browser ──► CloudFront ──► S3 (React SPA)      PostgreSQL (Neon)
                                                         ▲
                                 ┌───────────────────────┘
  Browser ──► API Gateway ──► Lambda (Express)
                                 ├──► Anthropic Claude API
                                 └──► AWS SES (password reset)
```

The scraper writes to Postgres on its own schedule, entirely decoupled from the
API — so request latency never depends on data collection, and a blocked scrape
just means the app serves slightly staler stats.

Inside the backend: route handlers validate input and return JSON, `requireAuth`
binds the user id from the JWT (never from a query parameter), services own
business logic (fantasy scoring, Claude calls, odds math, SES sends), and all
database access funnels through one parameterized `query()` helper in `db.ts`.

On the frontend, `src/api/client.ts` is the only module that speaks HTTP; no
component fetches directly.

## Database Schema and Migrations

- **`db/schema.sql`** declares 13 tables: `players`, `teams`, `games`, `users`,
  `password_reset_tokens`, `my_roster`, `analysis_cache`, `waiver_cache`,
  `bets`, `betting_cache`, `chat_history`, `page_views`, `rate_limits`. It is
  idempotent (`CREATE TABLE / INDEX IF NOT EXISTS`) and safe to re-run.
- **`db/migrations/`** holds sequential, numbered, hand-written SQL migrations
  (`001_` … `009_`) covering email + password reset, team conference backfill,
  user preferences, Google Sign-In, profile fields, betting, bet money fields,
  rate limits, and admin + pageviews. Each one is written to be idempotent, so
  re-applying is harmless.
- There is no migration runner. For a fresh database, apply `schema.sql` **and
  then every migration in numeric order** — `schema.sql` has drifted slightly
  behind and does not declare `users.ai_preferences`, which migration `003`
  adds and the preferences/AI features require. Schema alone is not enough.
- In production, migrations are applied **by hand** in the Neon SQL editor.
- Admin is server-enforced and has no signup path — grant it directly:
  `UPDATE users SET is_admin = TRUE WHERE email = 'you@example.com';`

## Deployment

Deployment is fully automated by GitHub Actions — **there is nothing to run by
hand.**

**On every pull request** (`.github/workflows/ci.yml`):

1. Backend job: typecheck source, typecheck tests, run unit + API tests
2. Frontend job: typecheck, run unit tests, production build
3. E2E job: typecheck E2E, then the Playwright suite on Chromium
4. If all three pass, a **preview deploy** goes to the shared `dev`
   environment (`serverless deploy --stage dev` plus a sync to the dev S3
   bucket and a CloudFront invalidation). Two open PRs share one dev
   environment — last push wins.

**On push/merge to `main`:** CI re-runs on the merge commit, and
`.github/workflows/deploy.yml` fires via `workflow_run` only if CI concluded
successfully. It then:

1. Builds and deploys the backend with `serverless deploy --stage prod`
2. Builds the frontend and syncs to the prod S3 bucket — content-hashed
   `assets/` get a one-year immutable cache, root files get `no-cache` — then
   invalidates CloudFront
3. Runs a smoke test against `/api/health` and the frontend root

**On a 6-hour cron** (`.github/workflows/scraper.yml`): `python
scraper/run_scraper.py` refreshes stats in Postgres. Also triggerable manually
via `workflow_dispatch`.

AWS access uses **OIDC role assumption** — no long-lived AWS keys are stored in
the repo. Runtime configuration lives in GitHub Actions secrets and variables;
Serverless injects them into the Lambda environment (see
`backend/serverless.yml`).

**Database migrations are deliberately not automated.** Every schema change is
applied by hand in the Neon SQL editor with human review. Lambda's built-in
versioning provides fast rollback for code regressions.

`backend/deploy.ps1` exists only as an emergency manual escape hatch (e.g. a
GitHub Actions outage). Prefer the pipeline; if you must use it, deploy to an
unused stage so you don't fight the workflow over Lambda environment variables.

## Project Layout

```
fantasy-app/
├── .env.example                  # root env template (backend + scraper + seed)
├── AGENTS.md                     # contributor/AI-agent style guide
├── .github/
│   ├── deploy-iam-policy.json    # IAM policy for the OIDC deploy role
│   └── workflows/
│       ├── ci.yml                # PR gate + dev preview deploy
│       ├── deploy.yml            # prod deploy on push to main
│       └── scraper.yml           # 6-hour scraper cron
├── db/
│   ├── schema.sql                # full PostgreSQL schema
│   ├── migrations/               # 001_… 009_… sequential SQL migrations
│   └── seed.ts                   # sample players/teams/games (see note above)
├── scraper/
│   ├── requirements.txt
│   ├── run_scraper.py            # the scraper that actually runs in CI
│   ├── scrapy.cfg
│   ├── debug_*.py                # one-off local debug helpers
│   └── nba_scraper/              # legacy Scrapy project (not invoked by CI)
├── backend/
│   ├── package.json
│   ├── serverless.yml            # Lambda + HTTP API definition
│   ├── deploy.ps1                # emergency manual deploy only
│   ├── tsconfig.json
│   ├── src/
│   │   ├── app.ts                # Express app: middleware + router mounting
│   │   ├── index.ts              # local dev server entry
│   │   ├── lambda.ts             # AWS Lambda handler (serverless-http)
│   │   ├── config.ts             # boot-time config guards
│   │   ├── db.ts                 # pg pool + parameterized query() helper
│   │   ├── middleware/           # auth, admin, rateLimit
│   │   ├── routes/               # players, teams, games, fantasy, ai, auth,
│   │   │                         #   preferences, betting, status, track, admin
│   │   └── services/             # ai, fantasyScore, odds, oddsMath, email,
│   │                             #   benchmarks, betSettlement, chatHistory,
│   │                             #   preferences, dates
│   └── tests/                    # Vitest unit + Supertest API tests
└── frontend/
    ├── package.json
    ├── vite.config.ts            # React + Tailwind plugins, /api dev proxy
    ├── playwright.config.ts
    ├── src/
    │   ├── App.tsx               # routes
    │   ├── index.css             # Tailwind + daisyUI themes
    │   ├── types.ts
    │   ├── api/                  # client.ts + response caches
    │   ├── components/           # navbar, tables, modals, chat, betting panels
    │   ├── hooks/                # theme, caching, betting, page tracking
    │   ├── pages/                # Stats, Fantasy, ImproveTeam, Betting, Login,
    │   │                         #   Register, Forgot/ResetPassword, Profile,
    │   │                         #   Preferences, About, Admin
    │   └── utils/                # teamLogos, formatOdds
    ├── test/                     # Vitest unit tests
    └── e2e/                      # Playwright specs, page objects, fixtures
```

## Contributing

`AGENTS.md` is the style guide — architecture boundaries, TypeScript/React
conventions, testing layout, and the pre-commit checklist. Before opening a PR:

```bash
cd backend  && npm run typecheck && npm run typecheck:tests && npm test
cd frontend && npm run typecheck && npm test && npm run build
cd frontend && npm run typecheck:e2e && npm run test:e2e
```

There is no ESLint or Prettier configuration; formatting follows the surrounding
code.

## License

[MIT](LICENSE) — free to use, modify, and distribute with attribution.

NBA statistics, team names, and logos are property of the NBA and its teams.
This project is unaffiliated with the NBA and consumes publicly available data
for personal and educational use.
