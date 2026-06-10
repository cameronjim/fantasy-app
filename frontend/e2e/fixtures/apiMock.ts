import type { Page, Route } from '@playwright/test';
import { ALL_PLAYERS, type PlayerFixture } from './players';
import type {
  Team, Game, TeamAnalysis,
  BettingGame, BettingPicksResponse, Bet, LedgerSummary,
} from '../../src/types';

// route handlers that satisfy the api calls the app makes on first paint.
// tests opt in to richer responses by passing overrides; we never hit a
// real backend or anthropic key during e2e.

export interface DataStatus {
  players_updated_at: string | null;
  teams_updated_at: string | null;
  games_updated_at: string | null;
}

export interface WaiverSuggestionsResponse {
  trade_targets: Array<{ name: string; reasoning: string }>;
  waiver_pickups: Array<{ name: string; reasoning: string }>;
  summary: string;
  empty_roster?: boolean;
  cached?: boolean;
  cached_at?: string;
}

export interface MockOptions {
  players?: PlayerFixture[];
  teams?: Team[];
  games?: Game[];
  status?: DataStatus;
  rosterRequiresAuth?: boolean;
  teamAnalysis?: TeamAnalysis;
  waiverSuggestions?: WaiverSuggestionsResponse;
  bettingOdds?: BettingGame[];
  bettingPicks?: BettingPicksResponse;
  bets?: { bets: Bet[]; summary: LedgerSummary };
  // extra handlers applied before the defaults — useful for forcing a
  // specific status code or asserting that a particular call was made.
  custom?: Array<{ url: RegExp | string; handler: (route: Route) => Promise<void> | void }>;
}

const DEFAULT_STATUS: DataStatus = {
  players_updated_at: '2026-05-24T12:00:00Z',
  teams_updated_at: '2026-05-24T12:00:00Z',
  games_updated_at: '2026-05-24T12:00:00Z',
};

export async function mockApi(page: Page, opts: MockOptions = {}): Promise<void> {
  const players = opts.players ?? ALL_PLAYERS;
  const teams = opts.teams ?? [];
  const games = opts.games ?? [];
  const status = opts.status ?? DEFAULT_STATUS;

  // block all third-party origins so e2e tests don't depend on network
  // weather. in particular, GoogleLogin loads scripts from accounts.google.com
  // when LoginPage mounts — left alone, that races with assertions on the
  // login page and intermittently fails the suite.
  await page.route(/https:\/\/(accounts\.google\.com|cdn\.nba\.com|.*\.nba\.com)/, (route) => {
    route.abort();
  });

  for (const { url, handler } of opts.custom ?? []) {
    await page.route(url, handler);
  }

  await page.route('**/api/status', (route) => {
    route.fulfill({ json: status });
  });
  // catch-all sub-route under /api/status (e.g. /benchmarks).
  await page.route('**/api/status/**', (route) => route.fulfill({ json: {} }));

  await page.route('**/api/players*', (route) => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get('search')?.toLowerCase();
    const filtered = search
      ? players.filter((p) => p.name.toLowerCase().includes(search))
      : players;
    route.fulfill({ json: filtered });
  });

  await page.route('**/api/teams', (route) => route.fulfill({ json: teams }));
  await page.route('**/api/games**', (route) => route.fulfill({ json: games }));

  await page.route('**/api/fantasy/**', (route) => {
    if (opts.rosterRequiresAuth) {
      route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
      return;
    }
    route.fulfill({ json: [] });
  });

  await page.route('**/api/ai/team-analysis', (route) => {
    const fallback: TeamAnalysis = {
      categories: {},
      strengths: [],
      weaknesses: [],
      suggestions: [],
    };
    route.fulfill({ json: opts.teamAnalysis ?? fallback });
  });

  await page.route('**/api/ai/waiver-suggestions*', (route) => {
    const fallback: WaiverSuggestionsResponse = {
      trade_targets: [],
      waiver_pickups: [],
      summary: '',
      empty_roster: true,
    };
    route.fulfill({ json: opts.waiverSuggestions ?? fallback });
  });

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: { error: 'Unauthorized' } }),
  );

  // betting page first-paint endpoints. defaults are safe empties; tests opt
  // into picks/odds/ledger content via the options above.
  await page.route('**/api/betting/odds', (route) =>
    route.fulfill({ json: { games: opts.bettingOdds ?? [], fetched_at: '2026-05-24T12:00:00Z' } }),
  );

  await page.route('**/api/betting/picks*', (route) => {
    const fallback: BettingPicksResponse = { picks: [], parlay: null, summary: '', no_games: true };
    route.fulfill({ json: opts.bettingPicks ?? fallback });
  });

  await page.route('**/api/betting/bets**', (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      route.fulfill({
        status: 201,
        json: { id: 1, status: 'pending', created_at: '2026-05-24T12:00:00Z', settled_at: null, ...body },
      });
      return;
    }
    if (method === 'DELETE') {
      route.fulfill({ status: 204, body: '' });
      return;
    }
    const emptyLedger = {
      bets: [],
      summary: { wins: 0, losses: 0, pushes: 0, pending: 0, total_staked: 0, profit: 0, roi: 0 },
    };
    route.fulfill({ json: opts.bets ?? emptyLedger });
  });

  // the betting prefs panel (and PreferencesPrompt) read these; PATCH echoes
  // the payload back like the real route returns the updated prefs.
  await page.route('**/api/preferences', (route) => {
    if (route.request().method() === 'PATCH') {
      route.fulfill({ json: route.request().postDataJSON() ?? {} });
      return;
    }
    route.fulfill({ json: {} });
  });
}
