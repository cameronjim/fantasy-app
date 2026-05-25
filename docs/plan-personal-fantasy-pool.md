# Plan — Personal Fantasy Pool (Multi-User Leagues)

## Goal

Turn Fantasy NBA from a single-player advisor into a fantasy app that also **hosts its own leagues**. Users can either:

1. **Internal league mode** — Create/join a league hosted in this app. Draft, manage roster, compete with friends. "My Team" reflects their actual drafted roster.
2. **External team mode** — They play fantasy on ESPN/Yahoo/Sleeper but want premium AI advice here. "My Team" is a manually-curated list (current behavior).

The user picks their mode in onboarding (or switches later).

---

## Mode picker

Add a `team_source` field to the users table:

```sql
ALTER TABLE users ADD COLUMN team_source VARCHAR(20) DEFAULT 'external';
-- 'external' | 'internal'
```

When the user first lands on `/fantasy` after signup, show a one-time modal:

> **Where do you play fantasy basketball?**
> [ ] I want to start a league here (or join one)
> [ ] I play elsewhere — just give me advice on the players I pick

This sets `team_source` once. They can change it later in Preferences.

---

## Schema (new tables)

```sql
-- A league is a private group of 2–14 managers
CREATE TABLE leagues (
    id                SERIAL PRIMARY KEY,
    name              VARCHAR(100) NOT NULL,
    commissioner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code       VARCHAR(16) UNIQUE NOT NULL, -- short shareable code
    max_teams         INTEGER DEFAULT 10,
    scoring_format    VARCHAR(30) DEFAULT 'h2h_categories',
    draft_status      VARCHAR(20) DEFAULT 'pending', -- pending | live | complete
    draft_start_at    TIMESTAMPTZ,
    season            VARCHAR(10) DEFAULT '2025-26',
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- A team belongs to one user in one league. One user can be in multiple leagues.
CREATE TABLE league_teams (
    id              SERIAL PRIMARY KEY,
    league_id       INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_name       VARCHAR(100) NOT NULL,
    draft_position  INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (league_id, user_id)
);

-- One row per drafted player
CREATE TABLE league_rosters (
    id            SERIAL PRIMARY KEY,
    league_team_id INTEGER NOT NULL REFERENCES league_teams(id) ON DELETE CASCADE,
    player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    acquired_at   TIMESTAMPTZ DEFAULT NOW(),
    acquired_via  VARCHAR(20) DEFAULT 'draft', -- draft | waiver | trade
    UNIQUE (league_team_id, player_id)
);

-- Draft pick log (for replay + dispute resolution)
CREATE TABLE draft_picks (
    id              SERIAL PRIMARY KEY,
    league_id       INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    league_team_id  INTEGER NOT NULL REFERENCES league_teams(id) ON DELETE CASCADE,
    player_id       INTEGER NOT NULL REFERENCES players(id),
    pick_number     INTEGER NOT NULL,
    round_number    INTEGER NOT NULL,
    picked_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (league_id, pick_number),
    UNIQUE (league_id, player_id)
);
```

`my_roster` (the existing manual table) stays around for `team_source = 'external'` users.

---

## API endpoints

```
POST   /api/leagues                        Create a league (caller becomes commissioner)
GET    /api/leagues                        Leagues the current user belongs to
GET    /api/leagues/:id                    League details (members, settings, draft status)
POST   /api/leagues/join                   { invite_code } — join by code
DELETE /api/leagues/:id/members/:userId    Kick (commissioner only)

POST   /api/leagues/:id/invite             Send invite by email (uses SES)
POST   /api/leagues/:id/draft/start        Lock teams, set initial pick order
POST   /api/leagues/:id/draft/pick         { player_id } — make current pick
GET    /api/leagues/:id/draft/state        Whose turn, time left, picks so far

GET    /api/leagues/:id/standings          H2H records / cat winners per matchup
GET    /api/leagues/:id/rosters            All teams' rosters

POST   /api/leagues/:id/trades             Propose a trade
POST   /api/leagues/:id/trades/:tid/accept Accept a trade

POST   /api/leagues/:id/waivers/claim      Pick up a free agent
```

Auth: all routes require `requireAuth` and additionally verify the user is in the league.

---

## Draft flow

**Simplest first cut: pure snake draft with a per-pick clock (e.g. 90s). No auction yet.**

1. Commissioner creates league → invite_code generated
2. Commissioner shares invite link `fantasy-nba.cameronjim.com/join/<code>`
3. Up to `max_teams` users join. Commissioner can kick.
4. Commissioner clicks "Start Draft" → status flips `live`, pick order randomized, broadcast to all members
5. Picks go in snake order (1..N then N..1 then 1..N). 90s timer per pick; auto-pick BPA on timeout.
6. Each pick: `POST /api/leagues/:id/draft/pick` validates it's the user's turn, the player isn't already drafted, persists in `draft_picks` + `league_rosters`.
7. Real-time updates: poll `GET /draft/state` every 3s (simpler than WebSocket for v1).
8. When all rounds finish → `draft_status = 'complete'`, season begins.

**Roster size:** Configurable per league. Default 13 (10 starters + 3 bench), 10 rounds.

---

## "My Team" page becomes mode-aware

```tsx
if (currentUser.team_source === 'internal') {
  if (user has no leagues) → show "Create or join a league" CTA
  else if (active league.draft_status === 'pending') → show "Draft hasn't started" lobby
  else if (active.draft_status === 'live') → show DraftRoom component (live picker)
  else → show drafted roster (read-only roster + add via waivers/trades only)
} else {
  // existing manual roster UI
}
```

If a user is in multiple leagues, add a league selector at the top of `/fantasy`.

---

## AI integration

The existing `buildTeamContext` already accepts a `userId`. For internal-league users, fetch their roster from `league_rosters` joined to the player they're acting on, instead of `my_roster`. One small refactor in `services/ai.ts` — branch on `team_source`.

Waiver suggestions become more powerful here: the AI knows which players are actually available (not on anyone's roster in this league), not just "not on this user's roster."

---

## Email invites (via existing SES setup)

Reuse `services/email.ts`. New template `leagueInviteEmail(leagueName, inviterUsername, joinUrl)`. Required scope already in IAM.

---

## Phasing (build order)

1. **Schema + mode picker** — get the `team_source` column, the modal, and league-create / join endpoints. No drafting yet.
2. **Draft room** — the snake draft UI + endpoints. This is the meatiest piece.
3. **Roster management post-draft** — waivers, trades, transactions log.
4. **Standings & scoring** — Once games have stats, compute weekly H2H category wins.
5. **Email invites** — Nice-to-have polish.

Each phase is shippable independently. The mode picker is the lowest-risk first step.

---

## Open questions to decide before phase 1

1. Roster size, starting lineup format (do we enforce position eligibility — PG/SG/SF/PF/C, or just 13 of any?)
2. Scoring categories — fixed to the 9-cat we use today, or configurable per league?
3. Trade vetoes — commissioner-only, league-vote, or no vetoes (free market)?
4. Waiver process — FAAB ($100 budget bidding), rolling list, or first-come-first-served?
5. Should the AI ever pick for a user automatically (e.g., auto-draft if they don't show up)?
