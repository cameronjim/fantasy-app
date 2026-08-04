# Fantasy NBA

[![CI](https://github.com/cameronjim/fantasy-app/actions/workflows/ci.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/ci.yml)
[![Deploy](https://github.com/cameronjim/fantasy-app/actions/workflows/deploy.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/deploy.yml)
[![NBA Scraper](https://github.com/cameronjim/fantasy-app/actions/workflows/scraper.yml/badge.svg)](https://github.com/cameronjim/fantasy-app/actions/workflows/scraper.yml)

A full-stack fantasy basketball app built on real NBA stats, with AI-powered team
analysis, waiver wire suggestions, and a betting picks tab. It runs as a live
deployed service: automated CI/CD, tests at every layer, and a scheduled scraper
that refreshes the data every six hours.

**Live app: [fantasy-nba.cameronjim.com](https://fantasy-nba.cameronjim.com)**

Player stats, team stats, the live scoreboard, and the odds board are all open to
anyone. Creating a free account (email/password or Google Sign-In) unlocks the
fantasy roster, the Claude-powered analysis surfaces, and the bet tracker.

## Tech Stack

| Layer | Stack |
|---|---|
| **Frontend** | React 18, TypeScript (strict), Vite 6, Tailwind CSS 4, daisyUI 5, React Router 7, Axios, `@react-oauth/google`, lucide-react |
| **Backend** | Node.js 20, Express 4, TypeScript (ESM / NodeNext), `pg`, `jsonwebtoken`, `bcryptjs`, `helmet`, `cors` |
| **Database** | PostgreSQL (Neon in production), with a hand-written schema plus sequential SQL migrations |
| **AI** | Anthropic Claude API (`@anthropic-ai/sdk`) |
| **Email** | AWS SES v2 (`@aws-sdk/client-sesv2`) for password-reset mail |
| **Scraper** | Python 3.12, `nba_api`, `requests`, Beautiful Soup, `psycopg2` |
| **Tests** | Vitest (unit + API), Supertest, React Testing Library, Playwright |
| **Infra** | AWS Lambda + HTTP API Gateway (Serverless Framework v3), S3 + CloudFront, GitHub Actions |

## Features

### Stats (`/`), public

- Searchable, sortable player table with a **Fantasy Score (FS)** column
- Filters for free-text search, team, and position (PG/SG/SF/PF/C, multi-position
  aware)
- **Infinite scroll**, with rows paging in via `IntersectionObserver`
- Teams view with an **East / West / All** conference filter, plus offensive,
  defensive, and net ratings
- **Player comparison**: pick up to 3 players and open a side-by-side modal that
  highlights the winner in each category
- Player detail modal with headshot and injury status
- Live scoreboard strip along the top showing today's games and scores

### My Team (`/fantasy`), sign-in required

- Add and drop players to build a personal fantasy roster
- Roster table with per-game stats and computed team averages
- Claude-powered **9-category analysis** covering strengths, weaknesses, and
  suggestions, cached server-side and refreshable on demand
- Nudge to fill out Team Preferences if you haven't yet

### Improve Team (`/improve`), sign-in required

- Claude-generated **trade targets** and **waiver wire pickups**, driven by your
  roster's weakest categories
- AI chat for trade and waiver questions, with your roster supplied as context

### Betting (`/betting`), odds board public, picks require sign-in

- **Odds board** for upcoming games (spread, moneyline, total) sourced from ESPN
- Claude-generated **Best Value / Safe / Hail Mary** picks and a suggested parlay,
  tuned by your betting preferences
- **Bet ledger** to track, settle, and delete bets with running profit and loss
- AI chat scoped to betting, plus a glossary of betting terminology
- Entertainment-only disclaimer and a responsible-gambling notice

### Accounts and settings

- **Email/password auth** (bcrypt, cost 10) and **Google Sign-In** with
  server-side ID-token verification
- **Password reset by email** through AWS SES. Tokens are stored as SHA-256
  hashes and consumed exactly once, and forgot-password responds identically for
  known and unknown addresses so it cannot be used to enumerate accounts.
- **Profile page** (`/profile`) with My Profile and Change Password tabs
- **Team Preferences questionnaire** (`/preferences`), 10 questions spanning risk
  tolerance, league format, roster construction, trade appetite, schedule
  weighting, rookie appetite, and waiver strategy. Every AI prompt reads from it.
- **About page** (`/about`) describing the stack and the CI/CD pipeline
- **Developer Tools** (`/admin`), an admin-only dashboard with user count,
  24-hour pageviews, active users, a user list, and pageview breakdowns.
  Authorization is re-checked against the database on every request.

### Cross-cutting

- **7 themes with a navbar picker**: `lofi` (Light), Cream, Sage, Slate, Ocean,
  `business` (Dark), and Graphite. Two are daisyUI built-ins and five are custom
  themes defined in `frontend/src/index.css`. The choice persists in
  `localStorage`, and a pre-paint script in `index.html` prevents a flash of the
  wrong theme on load.
- **Data-freshness badge** in the navbar showing per-source "last updated" times
  for players, teams, and games, polled every 5 minutes
- **Rate limiting**, database-backed and keyed per IP or per user: login 5/15min,
  register 5/hr, forgot-password 3/hr, reset-password 10/hr, betting picks,
  pageview beacon 300/hr, and a 200/day per-user ceiling across all
  Claude-backed endpoints to bound API spend
- Client-side response caching with background revalidation and warm-up
  prefetching, which keeps tab switches instant

## Data Sources

| Source | Used for | Notes |
|---|---|---|
| [`stats.nba.com`](https://stats.nba.com) (via `nba_api`) | Player and team per-game stats | Sits behind Akamai, which **blocks AWS and GitHub Actions IP ranges**. Requests from CI can fail; the scraper tolerates it and the app keeps serving the last good data from Postgres. |
| ESPN public API (`site.api.espn.com`) | Games, scores, live scoreboard, betting odds | Not IP-blocked from AWS, which is why it backs the scoreboard and odds board instead of `cdn.nba.com`. |
| [CBS Sports](https://www.cbssports.com/nba/injuries/) | Injury reports and specific positions | Parsed with Beautiful Soup. |

## Configuration

Runtime configuration lives in GitHub Actions secrets and variables, and
Serverless injects it into the Lambda environment (see `backend/serverless.yml`).
The backend, scraper, and seed script all read from a single set of variables;
the frontend has its own, which Vite reads at build time.

Backend, scraper, and seed:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `AUTH_SECRET` | yes | JWT signing key. Must be at least 32 characters and not a placeholder, or `backend/src/config.ts` refuses to boot. |
| `ANTHROPIC_API_KEY` | for AI features | Anthropic API key |
| `FRONTEND_URL` | no | Comma-separated CORS allow-list |
| `GOOGLE_CLIENT_ID` | for Google Sign-In | OAuth client ID, verified server-side |
| `FROM_EMAIL` | for password reset | An SES-verified sender identity |
| `PORT` | no | Backend port, defaults to `3001` |

Frontend build:

| Variable | Description |
|---|---|
| `VITE_API_URL` | Origin of the deployed API |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID. Public by design, since it is baked into the bundle. Leave empty to hide the Google button. |

Never put a secret in a `VITE_`-prefixed variable. Vite inlines those values into
the static JavaScript at build time, so anything there is readable by anyone who
loads the page.

## API

Base path `/api`. All responses are JSON.

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | none | Liveness check, used by the post-deploy smoke test |
| `/status` | GET | none | Last-updated timestamps per data source |
| `/status/benchmarks` | GET | none | League benchmarks computed from the player pool |
| `/players` | GET | none | List players (search, team/position filters) |
| `/players/:id` | GET | none | Player detail |
| `/teams` | GET | none | All teams |
| `/teams/:id` | GET | none | Team detail |
| `/games` | GET | none | Today's and recent games |
| `/games/live` | GET | none | Live scoreboard, ESPN-backed |
| `/auth/register` | POST | none | Create an account (rate limited) |
| `/auth/login` | POST | none | Email/password sign-in (rate limited) |
| `/auth/google` | POST | none | Google Sign-In, ID token verified server-side |
| `/auth/forgot-password` | POST | none | Send a reset email (rate limited) |
| `/auth/reset-password` | POST | none | Consume a reset token (rate limited) |
| `/auth/me` | GET | user | Current user, including the `is_admin` flag |
| `/auth/profile` | PATCH | user | Update profile fields |
| `/auth/change-password` | PATCH | user | Change password |
| `/auth/set-email` | PATCH | user | Set or change email address |
| `/fantasy/roster` | GET | user | Current user's roster |
| `/fantasy/roster` | POST | user | Add a player |
| `/fantasy/roster/:playerId` | DELETE | user | Drop a player |
| `/preferences` | GET / PATCH | user | Team Preferences questionnaire |
| `/ai/chat` | POST | user | AI chat with roster, waiver, or betting context |
| `/ai/team-analysis` | GET | user | 9-category team analysis |
| `/ai/waiver-suggestions` | GET | user | Trade targets and waiver pickups |
| `/betting/odds` | GET | none | Odds board for upcoming games |
| `/betting/picks` | GET | user | AI picks and suggested parlay |
| `/betting/bets` | GET / POST | user | List or track bets |
| `/betting/bets/:id` | PATCH / DELETE | user | Settle or remove a bet |
| `/track/pageview` | POST | optional | Pageview beacon, counts anonymous visits |
| `/admin/users` | GET | admin | User list |
| `/admin/stats` | GET | admin | Totals and 24-hour activity |
| `/admin/views` | GET | admin | Pageview breakdown |

Everything under `/api/ai/*` also enforces a 200-request/day per-user cap.

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

The scraper writes to Postgres on its own schedule, fully decoupled from the API.
Request latency therefore never depends on data collection, and a blocked scrape
only means the app serves slightly staler stats.

Inside the backend, route handlers validate input and return JSON, `requireAuth`
binds the user id from the JWT rather than from a query parameter, services own
the business logic (fantasy scoring, Claude calls, odds math, SES sends), and
every database access funnels through one parameterized `query()` helper in
`db.ts`.

On the frontend, `src/api/client.ts` is the only module that speaks HTTP. No
component fetches directly.

## Database Schema and Migrations

- **`db/schema.sql`** declares 13 tables: `players`, `teams`, `games`, `users`,
  `password_reset_tokens`, `my_roster`, `analysis_cache`, `waiver_cache`,
  `bets`, `betting_cache`, `chat_history`, `page_views`, and `rate_limits`. It
  uses `CREATE TABLE / INDEX IF NOT EXISTS` throughout, so re-running it is safe.
- **`db/migrations/`** holds sequential, hand-written SQL migrations, `001`
  through `010`, covering email and password reset, team conference backfill,
  user preferences, Google Sign-In, profile fields, betting, bet money fields,
  rate limits, admin and pageviews, and the team abbreviation backfill. Each is
  idempotent, so re-applying one is harmless.
- There is no migration runner. A fresh database needs `schema.sql` **and then
  every migration in numeric order**. `schema.sql` has drifted slightly behind
  and does not declare `users.ai_preferences`, which migration `003` adds and the
  preferences and AI features depend on, so the schema alone is not enough.
- Migrations are applied by hand in the Neon SQL editor.
- Admin has no signup path and is enforced server-side. Grant it directly:
  `UPDATE users SET is_admin = TRUE WHERE email = 'you@example.com';`

## Deployment

Deployment is fully automated by GitHub Actions. **There is nothing to run by
hand.**

**On every pull request** (`.github/workflows/ci.yml`):

1. Backend job: typecheck source, typecheck tests, run unit and API tests
2. Frontend job: typecheck, run unit tests, production build
3. E2E job: typecheck E2E, then the Playwright suite on Chromium
4. If all three pass, a **preview deploy** goes out to the shared `dev`
   environment (`serverless deploy --stage dev`, plus a sync to the dev S3 bucket
   and a CloudFront invalidation). Two open PRs share one dev environment, so the
   last push wins.

**On push or merge to `main`:** CI re-runs against the merge commit, and
`.github/workflows/deploy.yml` fires via `workflow_run`, but only if CI concluded
successfully. It then:

1. Builds and deploys the backend with `serverless deploy --stage prod`
2. Builds the frontend and syncs it to the prod S3 bucket, giving content-hashed
   `assets/` a one-year immutable cache and root files `no-cache`, then
   invalidates CloudFront
3. Runs a smoke test against `/api/health` and the frontend root

**On a 6-hour cron** (`.github/workflows/scraper.yml`): `python
scraper/run_scraper.py` refreshes stats in Postgres. It can also be triggered
manually with `workflow_dispatch`.

AWS access uses **OIDC role assumption**, so no long-lived AWS keys live in the
repo or in CI.

**Database migrations are deliberately not automated.** Every schema change gets
applied by hand in the Neon SQL editor with human review. For code regressions,
Lambda's built-in versioning covers fast rollback.

`backend/deploy.ps1` exists only as an emergency escape hatch, for something like
a GitHub Actions outage. Prefer the pipeline. If you do need it, deploy to an
unused stage so it doesn't fight the workflow over Lambda environment variables.

## Project Layout

```
fantasy-app/
├── .env.example                  # env template (backend + scraper + seed)
├── AGENTS.md                     # contributor/AI-agent style guide
├── .github/
│   ├── deploy-iam-policy.json    # IAM policy for the OIDC deploy role
│   └── workflows/
│       ├── ci.yml                # PR gate + dev preview deploy
│       ├── deploy.yml            # prod deploy on push to main
│       └── scraper.yml           # 6-hour scraper cron
├── db/
│   ├── schema.sql                # full PostgreSQL schema
│   ├── migrations/               # 001 through 010, sequential SQL migrations
│   └── seed.ts                   # sample players/teams/games
├── scraper/
│   ├── requirements.txt
│   └── run_scraper.py            # players, teams, games, injuries
├── backend/
│   ├── package.json
│   ├── serverless.yml            # Lambda + HTTP API definition
│   ├── deploy.ps1                # emergency manual deploy only
│   ├── tsconfig.json
│   ├── src/
│   │   ├── app.ts                # Express app: middleware + router mounting
│   │   ├── index.ts              # server entry
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

`AGENTS.md` is the style guide, covering architecture boundaries, TypeScript and
React conventions, testing layout, and the pre-commit checklist.

CI gates every pull request on the full suite: typecheck and unit tests for both
the backend and frontend, API tests via Supertest, and the Playwright E2E suite
on Chromium. A PR needs all of it green before it can deploy.

There is no ESLint or Prettier config, so formatting follows the surrounding
code.

## License

[MIT](LICENSE), so you are free to use, modify, and distribute it with
attribution.

NBA statistics, team names, and logos are the property of the NBA and its teams.
This project is unaffiliated with the NBA and uses publicly available data for
personal and educational purposes.
