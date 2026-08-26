import { test, expect } from '@playwright/test';
import { ImproveTeamPage } from './pages';
import { mockApi } from './fixtures/apiMock';

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
