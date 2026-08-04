# AGENTS.md — Fantasy NBA

This is the single source of truth for AI agents and human contributors
working on this repo. It covers:

1. **Project orientation** — what the app is and where things live
2. **Pre-commit checklist** — exactly what to run before committing
3. **Role-specific guides** — what to do when working on each part of the app
4. **Code quality rules** — style, types, comments, security, performance
5. **Testing** — frameworks, layout, commands, and the test-coverage rule
6. **CI / branch protection** — how the suite gates merges to `main`

If you skim only one section, skim **§3 Role-specific guides** — find the
heading that matches your task and read it. Then check the **§2 pre-commit
checklist** before you finish.

---

## 1. Project orientation

### What this app is

Fantasy NBA is a small personal full-stack app:

- **Stats `/`** — searchable/sortable player and team tables, live scoreboard
- **My Team `/fantasy`** — personal fantasy roster with Claude-powered 9-category analysis
- **Improve Team `/improve`** — Claude-powered trade-target and waiver-pickup suggestions
- **Betting `/betting`** — ESPN odds board, Claude-generated picks, and a bet ledger

Plus supporting pages: `/profile`, `/preferences` (Team Preferences
questionnaire), `/about`, and `/admin` (admin-only Developer Tools, authorized
server-side on every request). Auth covers email/password, Google Sign-In, and
SES password reset. Theming is a 7-theme daisyUI picker.

There is no league system or multi-team play (the personal-pool plan was
archived).

### Tech stack

| Layer    | Stack                                                                              |
|----------|------------------------------------------------------------------------------------|
| Frontend | React 18, Vite 6, TypeScript, Tailwind 4, DaisyUI 5, React Router 7                |
| Backend  | Express 4, TypeScript (ESM, NodeNext), pg, jsonwebtoken, bcryptjs, Anthropic SDK   |
| Database | PostgreSQL (Neon in prod) with hand-written schema and sequential migrations       |
| Scraper  | Python + nba_api + requests + Beautiful Soup, runs in GitHub Actions on a 6-hour cron |
| Tests    | Vitest (unit + api), Supertest, React Testing Library, Playwright                  |
| CI       | GitHub Actions — backend, frontend, e2e jobs gate every PR to `main`               |
| Deploy   | AWS Lambda + API Gateway (backend via Serverless Framework) + S3 + CloudFront (frontend) |

### Repo layout

| Path            | Purpose                                                              |
|-----------------|----------------------------------------------------------------------|
| `frontend/`     | React + Vite app                                                     |
| `frontend/src/` | components, pages, hooks, api client, types                          |
| `frontend/test/`| Vitest unit tests for frontend modules                               |
| `frontend/e2e/` | Playwright e2e tests (specs, page objects, fixtures)                 |
| `backend/`      | Express server                                                       |
| `backend/src/`  | routes, middleware, services, db                                     |
| `backend/tests/`| Vitest unit + api tests                                              |
| `db/`           | PostgreSQL schema and migrations                                     |
| `scraper/`      | Python scraper (cron-driven by GitHub Actions)                       |
| `db/`           | schema.sql, sequential migrations, seed script                        |
| `.github/`      | GitHub Actions workflows (scraper cron, CI)                          |

### Files to read before editing each area

| If you're touching... | Read first                                                                |
|------------------------|---------------------------------------------------------------------------|
| Backend routes         | `backend/src/app.ts`, the route file under `backend/src/routes/`           |
| Backend services       | `backend/src/services/` for the relevant file                              |
| Fantasy scoring        | `backend/src/services/fantasyScore.ts` — the formula and rank thresholds   |
| Anthropic AI           | `backend/src/services/ai.ts`, `backend/src/routes/ai.ts`                   |
| Auth                   | `backend/src/middleware/auth.ts`, `backend/src/routes/auth.ts`             |
| Frontend pages         | `frontend/src/App.tsx`, the page file under `frontend/src/pages/`          |
| Frontend components    | `frontend/src/components/` for the relevant file                           |
| API client             | `frontend/src/api/client.ts`                                               |
| Types shared by both   | `frontend/src/types.ts`                                                    |
| Database schema        | `db/schema.sql`, then any later files in `db/migrations/`                  |
| Scraper                | `scraper/run_scraper.py`                                                   |
| Deployment             | `backend/serverless.yml`, `backend/src/lambda.ts`, `.env.example`, `.github/workflows/deploy.yml` |
| Tests                  | `backend/tests/`, `frontend/test/`, `frontend/e2e/`, this file's §6        |

---

## 2. Pre-commit checklist

Run these locally **before every commit** to `main` (or before opening a PR
that targets `main`). If any command fails, fix the underlying issue —
don't skip or `--no-verify`.

```bash
# from the repo root

# backend
cd backend
npm install
npm run typecheck            # tsc on src/
npm run typecheck:tests      # tsc on src/ + tests/
npm test                     # vitest: unit + api
npm run build                # tsc to dist/

# frontend
cd ../frontend
npm install
npm run typecheck            # tsc on src/
npm run typecheck:e2e        # tsc on e2e/
npm test                     # vitest unit tests
npm run build                # vite build

# e2e (one-time browser install: npm run test:e2e:install)
npm run test:e2e             # playwright against the vite dev server
```

If you're adding a feature, you must also have added or updated tests for
it — see **§6 Testing** for the rule.

CI runs the same commands on every push to `main` and every pull request.
Failures block merge **only** if branch protection is configured (see §7).

---

## 3. Role-specific guides

### 3a. When you're adding a feature

1. Read the page or route you're modifying, and the closest neighbor that
   does something similar. Match its style.
2. Decide where the logic belongs: component (UI), hook (state + effects),
   service (api/business logic), or utility (pure helper). See §4.
3. If it's user-visible, design the loading/empty/error/success states up
   front. Don't ship a happy-path-only UI.
4. **Add tests** before or alongside the change. Unit test for pure logic;
   api test for new routes; Playwright test for new e2e flows. See §6.
5. Run the pre-commit checklist. Open the PR.

### 3b. When you're fixing a bug

1. **Reproduce it first** — write a test that fails for the bug. This
   ensures the test actually covers the bug and prevents regressions.
2. Make the minimal change that turns the test green.
3. Don't sneak in unrelated refactors.
4. Run the full pre-commit checklist.

### 3c. When you're working on the frontend

- All HTTP goes through `frontend/src/api/client.ts`. Don't `fetch` directly
  from a component or hook.
- Player and Team shapes live in `frontend/src/types.ts` — they're the
  source of truth shared with the backend's JSON responses.
- Styling is Tailwind utility classes plus DaisyUI component classes. No
  inline `style={}` unless you need a computed value.
- Components render UI; hooks coordinate state and side effects; the API
  client makes requests. Don't mix layers.
- Loading/empty/error/success states are mandatory for any user flow.

### 3d. When you're working on the backend

- ESM with NodeNext. All in-source imports use a `.js` suffix even though
  the file is `.ts` (TypeScript resolves it). Match the existing style.
- All database access goes through the `query()` helper in
  `backend/src/db.ts`. Pass parameters with `$1`-style placeholders;
  **never interpolate user input into SQL strings**.
- Routes return JSON. Errors are `{ error: string }` shaped objects with an
  appropriate HTTP status code.
- Protected routes are mounted behind `requireAuth` in `app.ts`. The
  authenticated user id lives at `(req as AuthRequest).userId`. **Always**
  bind queries to this `userId`, never to a client-supplied one — that's a
  privilege-escalation hole.
- Don't log secrets, tokens, raw password values, or full Anthropic
  responses.

### 3e. When you're touching the database (schema/migrations)

- Add a new file in `db/migrations/` — never edit a past migration.
- Use `snake_case` for table and column names.
- SQL keywords uppercase, one clause per line for multi-line queries,
  explicit columns (no `SELECT *`).
- Migrations must be safe under concurrent writes. If you're adding a
  `NOT NULL` column to a large table, add it nullable first, backfill,
  then add the constraint in a follow-up migration.
- Update `db/schema.sql` to reflect the final shape (the canonical schema
  is the sum of all migrations).

### 3f. When you're working on the scraper

- Python conventions, not TypeScript: `snake_case` everywhere, type hints
  on public function signatures, `logging` module instead of `print`.
- Keep rate limiting and user-agent rotation intact — `stats.nba.com` will
  ban us if we hammer it.
- The cron in `.github/workflows/scraper.yml` runs every 6 hours. If you
  change the cadence, update that file and verify `DATABASE_URL` is still
  passed via `secrets`.

### 3g. When you're updating CI / GitHub Actions

- Workflows live in `.github/workflows/`. Edit them in YAML.
- Don't add a CI step that just always passes — that's worse than no check.
- If you change a `package.json` script name, grep the workflow files for
  the old name and update them too.
- Caching: keep the Playwright browser cache keyed on the
  `@playwright/test` version so a major upgrade re-downloads.

### 3h. When you're updating docs

- The map lives in this file. Update §1 if you add a top-level directory.
- The pre-commit checklist in §2 must stay accurate — if you add a new
  test script, list it here.
- Don't add a new markdown file unless you really need one. Prefer adding
  a section here.

---

## 4. Architecture and separation of concerns

This project follows a strict separation of concerns. Do not mix UI,
business logic, data fetching, persistence, and utility code in the same
place unless the existing architecture clearly requires it.

| Layer                  | Common location                  | Responsibility                                       |
|------------------------|----------------------------------|------------------------------------------------------|
| View / Component       | `frontend/src/components/`       | render UI, receive data via props or hooks           |
| Page                   | `frontend/src/pages/`            | top-level route, composes components                 |
| Hook                   | `frontend/src/hooks/`            | coordinate state, side effects, user actions         |
| Service / API client   | `frontend/src/api/client.ts`     | call backend endpoints, return typed data            |
| Route handler          | `backend/src/routes/`            | validate input, call services, return JSON           |
| Service                | `backend/src/services/`          | business logic, external calls (db, Anthropic, ses)  |
| Middleware             | `backend/src/middleware/`        | auth, request/response cross-cutting concerns        |
| Database               | `backend/src/db.ts` + `db/`      | one shared pool, parameterized queries only          |
| Types                  | `frontend/src/types.ts`          | shared shapes between client and server              |
| Tests                  | `backend/tests/`, `frontend/test/`, `frontend/e2e/` | verify behavior, not implementation       |

### Components

Components may: receive props, call hooks, render loading/empty/error/success
states, handle simple UI state, trigger callbacks.

Components should not: call APIs directly, contain complex business logic,
know about database details, perform authorization decisions, hide
important side effects.

### Hooks

Hooks may: call services, manage local state, handle effects, expose
actions, adapt service responses for the UI.

Hooks should not: contain unrelated business logic, become large
controllers, duplicate service logic, swallow errors silently.

### Services

Services may: call APIs, validate responses, normalize external data,
handle request errors, encapsulate third-party SDK calls.

Services should not: render UI, manage React state, contain
component-specific logic, know about CSS or routes.

### Utilities

Utilities should be pure: take inputs, return outputs, no side effects,
no hidden dependencies on app state, easy to unit test.

---

## 5. Code quality rules

### TypeScript

- No `any`. Use `unknown` and narrow, or a precise type.
- Exported function signatures must have explicit return types.
- Avoid unnecessary type assertions (`as Foo`). If you reach for one, ask:
  is the type wrong upstream? fix it there.
- Function parameters have explicit types.
- Prefer discriminated unions for state that has distinct variants.
- Don't use `// @ts-ignore`. If you really must, leave a `// reason: ...`
  comment.

### React

- Function components with hooks.
- Keep components small. Extract repeated UI into reusable components and
  complex logic into hooks or utilities.
- Don't use effects for logic that can happen during render.
- Clean up subscriptions, timers, and listeners.
- Use stable keys for lists. Avoid array indices for reorderable lists.

### Naming

| Thing                                      | Convention            |
|--------------------------------------------|-----------------------|
| Variables, functions, custom hooks, props  | `camelCase`           |
| React components, types, interfaces, enums | `PascalCase`          |
| Module-level constants                     | `SCREAMING_SNAKE_CASE`|
| React component files                      | `PascalCase.tsx`      |
| Hook files                                 | `useThing.ts`         |
| Utility/service/route files                | `camelCase.ts`        |
| Python files                               | `snake_case.py`       |
| SQL files                                  | `snake_case.sql`      |
| Playwright page objects                    | `<Name>Page.ts` for full routes; `<Name>Component.ts` for in-page POMs |

Local constants inside functions may use `camelCase` when they aren't
configuration values.

### Exports

- Prefer named exports.
- Default exports only when required by the framework (e.g. Vite/Vitest
  config files).
- Keep public module APIs small. Don't export internal helpers unless they
  are reused or tested directly.
- Avoid large barrel files.

### Comments

- **Lowercase**, short, and direct. Explain **why**, not what.
- Single-line `//` comments for brief explanations. Reserve `/** ... */`
  for actual JSDoc on exported APIs.
- No decorative dividers, banners, or separator lines.
- No commenting obvious code.
- No `TODO` without owner and context (or, better, don't commit it — file
  an issue instead).
- No `console.log`, `console.warn`, `console.error` in committed code.

### Error handling

- Don't swallow errors silently. If you `catch`, do something with it.
- Don't show raw technical errors or stack traces to end users.
- Don't leak secrets or sensitive data in errors or logs.
- Use consistent error shapes for APIs: `{ error: "<message>" }` with an
  appropriate HTTP status code.

### Security

- Never trust client input. Validate at the API boundary.
- Authorization is server-enforced. Hidden UI is not security.
- Don't expose server-only secrets to the frontend.
- Parameterized SQL queries only. Never interpolate user input.
- Hash passwords with bcrypt. Don't roll your own.
- Be careful with file uploads, webhooks, and anything that touches user-
  controlled URLs.

### Performance

- Don't prematurely optimize, but don't be careless. Avoid N+1 queries,
  unnecessary re-renders, duplicate fetches, loading huge payloads.
- Memoize only when there's a real reason. `useMemo`/`useCallback` are not
  free.

### File hygiene

The following are not allowed in committed code:

- Dead code, unused imports, unused variables
- Commented-out code blocks
- Debug `console.log`s
- Temporary files
- Unexplained `TODO`s
- Duplicate helpers
- Generated files committed accidentally
- Secrets or credentials

---

## 6. Testing

### Layout

| Layer                     | Location                           | Framework               |
|---------------------------|------------------------------------|-------------------------|
| Backend unit              | `backend/tests/unit/`              | Vitest                  |
| Backend API               | `backend/tests/api/`               | Vitest + Supertest      |
| Backend test helpers      | `backend/tests/helpers/`           | —                       |
| Backend mock + env setup  | `backend/tests/setup.ts`           | runs before every file  |
| Frontend unit             | `frontend/test/`                   | Vitest + jsdom          |
| Frontend test setup       | `frontend/test/setup.ts`           | runs before every file  |
| Frontend E2E              | `frontend/e2e/`                    | Playwright              |
| Playwright page objects   | `frontend/e2e/pages/`              | POM classes             |
| Playwright fixtures       | `frontend/e2e/fixtures/`           | route mocks, sample data|

Test files live inside each package (`backend/tests/`, `frontend/test/`,
`frontend/e2e/`) rather than in a repo-root directory, because Vitest's module
resolution can't follow tests outside the project root for CJS deps like
supertest and jsonwebtoken.

### Commands

```bash
# backend
cd backend
npm test                  # all unit + api
npm run test:unit         # unit only
npm run test:api          # api only
npm run test:watch        # watch mode

# frontend unit
cd frontend
npm test
npm run test:watch

# frontend e2e
cd frontend
npm run test:e2e:install  # one-time: install playwright chromium
npm run test:e2e          # run all e2e against vite dev server
```

### Test environment variables

| Variable             | Default in tests                | Notes                                                          |
|----------------------|---------------------------------|----------------------------------------------------------------|
| `AUTH_SECRET`        | `test-auth-secret-not-for-prod` | Set in `backend/tests/setup.ts`.                               |
| `GOOGLE_CLIENT_ID`   | `test-google-client-id`         | Auth route reads this. Tests never reach Google.               |
| `DATABASE_URL`       | **deliberately unset**          | `db.ts` is mocked globally in `setup.ts`. A real pg connection is impossible from a test. |
| `ANTHROPIC_API_KEY`  | **not required**                | AI routes either short-circuit before calling Claude (mocked db) or are exercised only at their boundaries. |
| `PLAYWRIGHT_PORT`    | `5174`                          | Playwright spins up Vite on this port. Override to avoid collisions. |

### How AI / Anthropic calls are handled

Automated tests never hit the real Anthropic API:

- **Backend tests** mock `src/db.js` globally. Claude-powered routes
  short-circuit before calling `callClaude` when the mocked roster has no
  players, or are exercised only for auth/validation branches.
- **Playwright tests** intercept `/api/ai/*` endpoints and return canned
  shapes. Tests assert the UI rendered the right branch (loading,
  empty-roster, suggestions present).

If you add a route that calls Claude directly, isolate the Anthropic call
in a service module that takes inputs and returns outputs, and mock that
boundary in tests.

### Test data

- **Backend** tests use `pgResult([...])` from
  `backend/tests/helpers/mockDb.ts` to build fake `pg.QueryResult` objects,
  and `pgUniqueViolation()` to simulate duplicate-key errors.
- **Frontend unit** tests render React components with React Testing
  Library under jsdom.
- **Playwright** tests use `mockApi(page, ...)` from
  `frontend/e2e/fixtures/apiMock.ts` to satisfy every `/api/*` route used
  on first paint, plus per-test overrides.

### Database-backed tests

There are no integration tests against a real Postgres. Every backend test
mocks `src/db.js`, so no test database is required.

If you add integration tests in the future:

- Use a dedicated test database (`DATABASE_URL=postgresql://.../fantasy_nba_test`).
- Run all migrations against it before tests, truncate between tests.
- **Never** point integration tests at the production Neon database.

### The test-coverage rule

**Every new feature must include automated test coverage.**

When adding or changing a feature, you must do one of:

1. **Add new tests** — a unit test, API test, or Playwright test that
   exercises the new behavior, or
2. **Update existing tests** — adjust the affected tests to cover the new
   behavior, or
3. **Explain in your final response** why automated coverage was not
   practical and describe the manual verification performed instead.

Exception #3 should be rare. It applies when the change is unobservable
from outside (e.g. a comment-only edit) or where testing would require
infrastructure the project doesn't have (e.g. real Anthropic responses).

Tests should be **behavior-focused**, not implementation-detail focused.
Prefer asserting what the user (or API caller) sees over asserting
internal state. Don't assert exact SQL strings; assert that the response
contains the right data.

### AAA convention

Backend unit and API tests use Arrange / Act / Assert with explicit
comments:

```ts
it('does the thing', () => {
  // arrange
  const input = ...;

  // act
  const result = doTheThing(input);

  // assert
  expect(result).toBe(...);
});
```

For trivial cases (a single literal assertion), `// act + assert` is fine.
Apply the convention uniformly — don't add markers to half the tests in
a describe block.

---

## 7. CI and branch protection

### What CI runs

The workflow at `.github/workflows/ci.yml` runs on every push to `main`
and every pull request targeting `main`. Three jobs:

1. **Backend** — `npm ci`, `typecheck`, `typecheck:tests`, `npm test`
2. **Frontend** — `npm ci`, `typecheck`, `typecheck:e2e`, `npm test`, `npm run build`
3. **E2E** — `npm ci`, install Playwright Chromium (cached), `npm run test:e2e`

A failure in any job fails the workflow. Playwright HTML reports upload
as a build artifact on failure for debugging.

### Continuous deployment — two environments

The app runs in **two parallel environments**: production (live to users)
and dev (a shared preview environment for PRs). Each has its own AWS
resources and its own database.

| Resource          | Production                            | Dev (preview)                            |
|-------------------|---------------------------------------|------------------------------------------|
| Lambda + API GW   | `fantasy-nba-api-prod` stack          | `fantasy-nba-api-dev` stack              |
| Frontend bucket   | prod S3 bucket                        | dev S3 bucket                            |
| CloudFront        | prod distribution                     | dev distribution                         |
| Database          | Neon prod database                    | Neon dev branch                          |
| Frontend URL      | `PROD_FRONTEND_URL` variable          | `DEV_FRONTEND_URL` variable              |
| Triggered by      | merge to `main`                       | every push to any open PR                |

#### Prod deploys (`.github/workflows/deploy.yml`)

Triggered by `workflow_run` after CI passes on a push to `main`. Three jobs:

1. **deploy-backend** — assume AWS role via OIDC, `npx serverless deploy --stage prod`.
2. **deploy-frontend** — build with `VITE_API_URL`, sync to prod S3 with
   correct cache headers, invalidate prod CloudFront.
3. **smoke-test** — `curl /api/health` and the prod frontend root URL.

#### PR previews (`deploy-preview` job in `.github/workflows/ci.yml`)

Runs as a fourth job in the CI workflow on `pull_request` events, after
the test jobs pass:

1. Backend → `npx serverless@3 deploy --stage dev` (clobbers previous dev)
2. Frontend → built with `DEV_API_URL`, sync'd to dev S3 bucket, dev
   CloudFront invalidated

The dev environment is at a fixed URL (`DEV_FRONTEND_URL`), so once the
job goes green just visit that URL to see your PR's code running.

"Last PR push wins" — two open PRs share one dev environment. Acceptable
for solo work.

If CI fails, neither deploy runs. Both deploys use the exact git SHA
that CI tested — no "rebuild locally and ship" gap.

### Branch protection (manual one-time setup)

CI cannot enforce its own requiredness — that's a GitHub UI setting:

1. **Settings → Branches → Branch protection rules** → add a rule for `main`.
2. Enable **Require status checks to pass before merging**.
3. Mark these checks as required:
   - `Backend (typecheck + tests)`
   - `Frontend (typecheck + unit tests + build)`
   - `Frontend E2E (Playwright)`
4. Enable **Require branches to be up to date before merging** so stale
   PRs re-run CI after rebasing.

Until this is configured, the CI green checkmark is informational only.

### Deploy setup (one-time, AWS + GitHub clicks)

The deploy workflow needs an AWS IAM role it can assume via OIDC and a
handful of GitHub secrets/variables. The setup is a one-time ~30-minute
sequence. Steps assume you're logged into AWS Console as an admin and
GitHub as the repo owner.

#### A. Create the OIDC identity provider in AWS

1. AWS Console → **IAM → Identity providers → Add provider**.
2. Provider type: **OpenID Connect**.
3. Provider URL: `https://token.actions.githubusercontent.com` → click
   **Get thumbprint**.
4. Audience: `sts.amazonaws.com`.
5. Click **Add provider**.

You'll only ever do this once per AWS account, even across repos.

#### B. Create the deploy IAM role

1. AWS Console → **IAM → Roles → Create role**.
2. Trusted entity type: **Web identity**.
3. Identity provider: select the one you just made.
4. Audience: `sts.amazonaws.com`.
5. GitHub organization: your GitHub username.
6. GitHub repository: the repo name.
7. GitHub branch: `main` (this restricts the role to only be assumable
   from the `main` branch — important for security).
8. Click **Next**, then **Next** (we'll attach a custom policy next).
9. Role name: `fantasy-nba-deploy`.
10. Click **Create role**.
11. Open the role you just made. Note the **Role ARN** (top of the page,
    starts with `arn:aws:iam::...`). You'll paste this into GitHub later.

#### C. Attach a permission policy

1. With the role open: **Add permissions → Create inline policy**.
2. Switch to the **JSON** tab and paste the policy from
   `.github/deploy-iam-policy.json` — fill in your AWS account ID, S3
   bucket name, and CloudFront distribution ID where indicated by the
   `<YOUR_…>` placeholders.
3. Policy name: `fantasy-nba-deploy-policy`.
4. **Create policy**.

The policy follows the principle of least privilege: Serverless gets
what it needs to manage CloudFormation + Lambda + API Gateway, S3 access
is scoped to the two buckets we care about, and CloudFront is limited
to invalidations on the single distribution.

#### D. Add GitHub secrets (sensitive values)

Settings → **Secrets and variables → Actions → New repository secret**.
Add each of these:

| Name                 | Value                                          |
|----------------------|------------------------------------------------|
| `DATABASE_URL`       | Your Neon connection string                    |
| `ANTHROPIC_API_KEY`  | Your Anthropic API key                         |
| `AUTH_SECRET`        | The JWT signing secret (any 32+ char string)   |

#### E. Add GitHub variables (non-sensitive references)

Same page → **Variables** tab → **New repository variable**:

**Production:**

| Name                          | Value                                                                |
|-------------------------------|----------------------------------------------------------------------|
| `AWS_DEPLOY_ROLE_ARN`         | The Role ARN from step B.11                                          |
| `S3_BUCKET`                   | Name of the S3 bucket serving the prod frontend                      |
| `CLOUDFRONT_DISTRIBUTION_ID`  | The prod CloudFront distribution ID (e.g. `E1ABCDEF234567`)          |
| `PROD_API_URL`                | Backend prod URL (e.g. `https://api.cameronjim.com` or the API Gateway URL) |
| `PROD_FRONTEND_URL`           | Frontend prod URL (e.g. `https://fantasy.cameronjim.com`)            |
| `GOOGLE_CLIENT_ID`            | Google OAuth client id (public — safe as Variable, not Secret)       |
| `FROM_EMAIL`                  | Verified SES sender address for password-reset emails                |

**Dev / PR previews** (only needed if you set up the dev environment per
section H below):

| Name                              | Value                                                            |
|-----------------------------------|------------------------------------------------------------------|
| `DEV_S3_BUCKET`                   | Name of the dev frontend S3 bucket                               |
| `DEV_CLOUDFRONT_DISTRIBUTION_ID`  | The dev CloudFront distribution ID                               |
| `DEV_API_URL`                     | Dev backend URL (the existing `dev-fantasy-nba-api` invoke URL)  |
| `DEV_FRONTEND_URL`                | Dev frontend URL (e.g. `https://dev.fantasy-nba.cameronjim.com`) |

Plus secrets:

| Name                  | Value                                                                |
|-----------------------|----------------------------------------------------------------------|
| `DEV_DATABASE_URL`    | Connection string for the Neon dev branch (NOT prod's URL)           |
| `DEV_AUTH_SECRET`     | A **separate** 32+ char JWT signing secret for dev (NOT prod's). The dev env is public, so a shared secret would let a dev-minted token authenticate against prod. |

#### F. Verify it works

1. Open a tiny PR (change a comment, anything). Watch CI run; deploy
   should NOT run.
2. Merge the PR. Watch **CI** complete, then watch **Deploy** start.
3. After deploy completes, the **smoke-test** job hits prod and
   verifies `/api/health` and the frontend root respond.

If any step fails, the workflow goes red and prod is untouched (Lambda
keeps the previous version live; S3 + CloudFront keep the previous
build live until the next successful sync).

#### G. Rollback (when you eventually need it)

- **Backend:** AWS Console → Lambda → your function → **Versions** →
  pick a previous version → **Aliases** → point `live` (or whatever
  alias you set) at the previous version. Effective in seconds.
- **Frontend:** S3 keeps the previous objects only until the next
  `aws s3 sync --delete`, so for true rollback you re-run a previous
  good commit's deploy job (Actions → Deploy → previous successful run
  → **Re-run jobs**).

#### H. PR-preview / dev environment setup (one-time, optional)

This wires up the dev environment that the `deploy-preview` job in CI
writes to. Skip if you only want prod auto-deploys; the PR-preview job
will just fail without these resources.

##### H.1 Create the dev frontend S3 bucket

1. AWS Console → **S3 → Create bucket**.
2. Bucket name: `dev.<your-domain>` (e.g. `dev.fantasy-nba.cameronjim.com`)
   — must be globally unique.
3. Region: same as prod (us-east-1).
4. Block all public access: **on** (CloudFront will front it).
5. Create.

##### H.2 Create the dev CloudFront distribution

1. AWS Console → **CloudFront → Create distribution**.
2. Origin: the dev S3 bucket from H.1. Origin access: **Origin access control**
   (create new) — this is what lets CloudFront read the private bucket.
3. Default cache behavior: redirect HTTP to HTTPS.
4. Default root object: `index.html`.
5. **Custom error responses** (for SPA routing): add two — `403` and `404`
   both → response page path `/index.html`, response code `200`.
6. (Optional) Alternate domain name: `dev.<your-domain>` + ACM cert.
7. Create. Note the **Distribution ID** for the `DEV_CLOUDFRONT_DISTRIBUTION_ID` var.
8. Copy the bucket policy CloudFront generates and apply it to the dev S3
   bucket (Bucket → Permissions → Bucket policy → Edit).

##### H.3 Create a Neon dev database branch

1. Neon dashboard → your project → **Branches → Create branch**.
2. Source: `main` (or your default branch).
3. Name: `dev`.
4. Copy the connection string for the `DEV_DATABASE_URL` secret.

This gives dev its own data without affecting prod.

##### H.4 Update the IAM policy to allow dev resources

The role needs to write to the new dev bucket and invalidate the new dev
distribution. Update `.github/deploy-iam-policy.json`:

- `FrontendBuckets` resource list now has both prod and dev bucket ARNs.
- `CloudFrontInvalidation` resource list now has both prod and dev
  distribution ARNs.

Paste the updated policy into AWS Console → IAM → Roles →
`fantasy-nba-deploy` → policy → Edit JSON → Save.

##### H.5 Add the `DEV_*` Secrets and Variables to GitHub

See section E above for the full list.

##### H.6 Stop using `deploy.ps1` against the dev stage

The PR-preview workflow now owns the dev Lambda's env vars. If you keep
hand-deploying via `deploy.ps1`, the env vars in dev will oscillate
between your `.env` file and the GitHub Secrets every time you push.
Hand-deploy to a different stage if you need to — see the comment at the
top of `backend/deploy.ps1`.

##### H.7 Verify it works

Open any PR with a tiny change. Watch the **CI** workflow on the PR:

- All four jobs (`backend`, `frontend`, `e2e`, `deploy-preview`) should run.
- After they finish, visit `DEV_FRONTEND_URL` in a browser. Sign in. The
  site should serve from dev CloudFront, talk to the dev Lambda, hit the
  dev Neon database.

If `deploy-preview` fails, check its logs. The most common failures are
missing `DEV_*` variables or the IAM policy not yet including the dev
bucket/distribution.



## 8. When you're stuck

| Question                                       | Where to look                                   |
|------------------------------------------------|-------------------------------------------------|
| "How does the app behave at runtime?"          | `README.md`, then run the dev servers locally   |
| "What's the existing pattern for X?"           | Grep for a sibling that does something similar  |
| "Where do tests for Y go?"                     | §6 above                                        |
| "What commands do I run before committing?"    | §2 above                                        |
| "How is auth wired?"                           | `backend/src/middleware/auth.ts`                |
| "What's the fantasy score formula?"            | `backend/src/services/fantasyScore.ts`          |
| "What env vars do I need?"                     | `.env.example`                                  |
| "How does deployment work?"                    | `backend/serverless.yml` + `.github/workflows/deploy.yml`, plus §7 of this file |
