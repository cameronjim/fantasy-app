import { test, expect } from '@playwright/test';
import { ImproveTeamPage } from './pages';
import { mockApi } from './fixtures/apiMock';

// tests for the claude-powered surfaces. we never hit the real anthropic api
// in ci — mocked routes return canned shapes so the ui's empty/loading/data
// branches can be exercised deterministically.

test.describe('AI surfaces', () => {
  test('Improve Team page shows the empty-roster prompt when the api reports empty_roster', async ({ page }) => {
    await mockApi(page, {
      waiverSuggestions: {
        trade_targets: [],
        waiver_pickups: [],
        summary: '',
        empty_roster: true,
      },
    });

    // pretend the user is signed in by stashing a token before navigation.
    // the frontend only reads `auth_token` from localStorage; the api mocks
    // already return safe payloads so no real verification happens.
    await page.addInitScript(() => {
      window.localStorage.setItem('auth_token', 'fake-token-for-ui-tests');
    });

    const improve = new ImproveTeamPage(page);
    await improve.goto();

    await expect(improve.emptyRosterPrompt()).toBeVisible();
  });

  test('Improve Team page surfaces trade and waiver sections when suggestions arrive', async ({ page }) => {
    await mockApi(page, {
      waiverSuggestions: {
        trade_targets: [
          { name: 'Trade Candidate One', reasoning: 'fills assists gap' },
        ],
        waiver_pickups: [
          { name: 'Waiver Candidate One', reasoning: 'cheap rebounding upside' },
        ],
        summary: 'Focus on assists and rebounding this week.',
      },
    });

    await page.addInitScript(() => {
      window.localStorage.setItem('auth_token', 'fake-token-for-ui-tests');
    });

    const improve = new ImproveTeamPage(page);
    await improve.goto();

    await expect(improve.tradeTargetsHeader()).toBeVisible();
    await expect(improve.waiverPickupsHeader()).toBeVisible();
    await expect(page.getByText('Trade Candidate One')).toBeVisible();
    await expect(page.getByText('Waiver Candidate One')).toBeVisible();
    await expect(page.getByText(/Focus on assists/)).toBeVisible();
  });
});
