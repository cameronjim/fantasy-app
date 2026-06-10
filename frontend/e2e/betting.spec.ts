import { test, expect } from '@playwright/test';
import { BettingPage } from './pages';
import { mockApi } from './fixtures/apiMock';
import type { BettingGame, BettingPicksResponse } from '../src/types';

// the betting page never hits real ESPN or anthropic in e2e — fixtures return
// canned odds and picks so every ui branch is deterministic.

const ODDS_FIXTURE: BettingGame[] = [
  {
    nba_game_id: '401859966',
    home_team: 'New York Knicks',
    away_team: 'San Antonio Spurs',
    home_abbrev: 'NY',
    away_abbrev: 'SA',
    game_date: '2026-06-10',
    tipoff: '6/10 - 8:30 PM EDT',
    provider: 'Draft Kings',
    markets: {
      spread: { home_line: -2.5, away_line: 2.5, home_price: -105, away_price: -115, home_implied: 0.5122, away_implied: 0.5349 },
      total: { line: 216.5, over_price: -112, under_price: -108, over_implied: 0.5283, under_implied: 0.5192 },
      moneyline: { home: -130, away: 105, home_implied: 0.5652, away_implied: 0.4878 },
    },
  },
];

const PICKS_FIXTURE: BettingPicksResponse = {
  picks: [
    {
      game_id: '401859966', category: 'best_value', market: 'spread', selection: 'home',
      matchup: 'San Antonio Spurs @ New York Knicks', game_date: '2026-06-10',
      tipoff: '6/10 - 8:30 PM EDT', selection_label: 'New York Knicks -2.5',
      line: -2.5, american_odds: -105, implied_prob: 0.5122,
      estimated_win_prob: 0.58, edge: 0.0678,
      rationale: 'Rest advantage and a top-five defense at home.', confidence: 'medium',
      kelly: { full: 0.06, quarter: 0.015, suggested_stake: 15 },
    },
    {
      game_id: '401859966', category: 'safe', market: 'moneyline', selection: 'home',
      matchup: 'San Antonio Spurs @ New York Knicks', game_date: '2026-06-10',
      tipoff: '6/10 - 8:30 PM EDT', selection_label: 'New York Knicks ML (-130)',
      line: null, american_odds: -130, implied_prob: 0.5652,
      estimated_win_prob: 0.62, edge: 0.0548,
      rationale: 'Better team straight up.', confidence: 'high',
      kelly: { full: 0.05, quarter: 0.0125, suggested_stake: 12.5 },
    },
  ],
  parlay: {
    legs: [
      { game_id: '401859966', market: 'spread', selection: 'home', selection_label: 'New York Knicks -2.5', matchup: 'San Antonio Spurs @ New York Knicks', american_odds: -105 },
      { game_id: '401859967', market: 'total', selection: 'under', selection_label: 'Under 216.5', matchup: 'Boston Celtics @ Miami Heat', american_odds: -108 },
    ],
    combined_american: 271,
    combined_implied_prob: 0.2695,
    rationale: 'Two correlated slow-pace plays.',
    ev_note: 'Parlays multiply the house edge — keep the stake small.',
  },
  summary: 'One strong value play on a thin slate.',
};

const signIn = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.addInitScript(() => {
    window.localStorage.setItem('auth_token', 'fake-token-for-ui-tests');
  });
};

test.describe('Betting page', () => {
  test('signed-out visitors see the disclaimer, odds board, and glossary with a sign-in prompt', async ({ page }) => {
    await mockApi(page, { bettingOdds: ODDS_FIXTURE });

    const betting = new BettingPage(page);
    await betting.goto();

    await expect(betting.disclaimer().first()).toBeVisible();
    await expect(betting.signInPrompt()).toBeVisible();
    await expect(betting.oddsBoardHeading()).toBeVisible();
    await expect(betting.glossaryHeading()).toBeVisible();
    // odds render with implied-probability badges
    await expect(page.getByText('New York Knicks').first()).toBeVisible();
    await expect(page.getByText('56.5%').first()).toBeVisible();
  });

  test('signed-in users see categorized AI picks and the parlay with its -EV note', async ({ page }) => {
    await mockApi(page, { bettingOdds: ODDS_FIXTURE, bettingPicks: PICKS_FIXTURE });
    await signIn(page);

    const betting = new BettingPage(page);
    await betting.goto();

    await expect(betting.categoryHeading('Best Value')).toBeVisible();
    await expect(betting.categoryHeading('Safe')).toBeVisible();
    await expect(betting.categoryHeading('Hail Mary')).toBeVisible();
    await expect(page.getByText('New York Knicks ML (-130)')).toBeVisible();
    await expect(betting.parlayHeading()).toBeVisible();
    await expect(page.getByText(/Parlays multiply the house edge/i)).toBeVisible();
  });

  test('tracking a pick posts the bet and the ledger shows it', async ({ page }) => {
    await mockApi(page, { bettingOdds: ODDS_FIXTURE, bettingPicks: PICKS_FIXTURE });
    await signIn(page);

    // stateful ledger mock registered after mockApi so it takes precedence:
    // POSTs append, GETs return what's been tracked so far.
    const tracked: Array<Record<string, unknown>> = [];
    await page.route('**/api/betting/bets**', (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        tracked.push({
          id: tracked.length + 1,
          home_team: 'New York Knicks',
          away_team: 'San Antonio Spurs',
          game_date: '2026-06-10',
          status: 'pending',
          created_at: '2026-06-09T12:00:00Z',
          settled_at: null,
          profit: 0,
          ...body,
        });
        route.fulfill({ status: 201, json: tracked[tracked.length - 1] });
        return;
      }
      route.fulfill({
        json: {
          bets: tracked,
          summary: {
            wins: 0, losses: 0, pushes: 0, pending: tracked.length,
            total_staked: tracked.reduce((sum, b) => sum + (b.stake as number), 0),
            profit: 0, roi: 0,
          },
        },
      });
    });

    const betting = new BettingPage(page);
    await betting.goto();

    await betting.trackBetButton().first().click();

    await expect(page.getByText('Added to your ledger ✓')).toBeVisible();
    // the ledger re-fetched and now lists the tracked spread bet
    await expect(betting.ledgerHeading()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'New York Knicks -2.5', exact: true })).toBeVisible();
  });

  test('saving betting preferences re-runs the analysis with refresh=true', async ({ page }) => {
    await mockApi(page, { bettingOdds: ODDS_FIXTURE, bettingPicks: PICKS_FIXTURE });
    await signIn(page);

    const betting = new BettingPage(page);
    await betting.goto();

    await betting.prefsToggle().click();
    await page.getByRole('button', { name: 'Aggressive' }).click();

    const refreshRequest = page.waitForRequest((req) =>
      req.url().includes('/api/betting/picks') && req.url().includes('refresh=true')
    );
    await betting.savePrefsButton().click();
    await refreshRequest;
  });

  test('glossary entries expand with plain-english explanations', async ({ page }) => {
    await mockApi(page, { bettingOdds: ODDS_FIXTURE });

    const betting = new BettingPage(page);
    await betting.goto();

    await betting.glossaryToggle('Moneyline').check();

    await expect(page.getByText(/pick which team wins the game/i)).toBeVisible();
  });
});
