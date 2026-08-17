import { test, expect } from '@playwright/test';
import { PlayerAnalyticsPage, StatsPage } from './pages';
import { mockApi } from './fixtures/apiMock';
import { ALL_STAR, ALL_STAR_ANALYTICS } from './fixtures/players';

test.describe('Player analytics page', () => {
  test('renders the header, percentile bars and the distribution chart', async ({ page }) => {
    await mockApi(page, { playerAnalytics: ALL_STAR_ANALYTICS });
    const analytics = new PlayerAnalyticsPage(page);

    await analytics.goto(ALL_STAR.id);

    await expect(analytics.heading()).toHaveText(ALL_STAR.name);
    await expect(analytics.percentileSection()).toBeVisible();
    await expect(analytics.percentileBar('PTS')).toHaveAttribute('value', '94');
    await expect(analytics.distributionChart()).toBeVisible();
    await expect(analytics.backLink()).toBeVisible();
  });

  test('shows the comparison pool label, definition and sample size', async ({ page }) => {
    await mockApi(page, { playerAnalytics: ALL_STAR_ANALYTICS });
    const analytics = new PlayerAnalyticsPage(page);

    await analytics.goto(ALL_STAR.id);

    await expect(page.getByText(/vs rotation players/i)).toContainText(
      'GP >= 15 and MPG >= 12 this season'
    );
    await expect(page.getByText(/vs rotation players/i)).toContainText('n=312');
  });

  test('renders trend charts and recent games, and hides the projection card', async ({ page }) => {
    await mockApi(page, { playerAnalytics: ALL_STAR_ANALYTICS });
    const analytics = new PlayerAnalyticsPage(page);

    await analytics.goto(ALL_STAR.id);

    await expect(analytics.pointsTrendChart()).toBeVisible();
    await expect(analytics.recentGamesSection()).toBeVisible();
    await expect(analytics.freshnessFooter()).toBeVisible();
    // the api sends prediction: null until the model ships.
    await expect(analytics.predictionCard()).toHaveCount(0);
  });

  test('degrades to percentiles only when the player has no game logs', async ({ page }) => {
    await mockApi(page, {
      playerAnalytics: {
        ...ALL_STAR_ANALYTICS,
        as_of: { logs: null, distributions: '2026-02-04T13:00:00Z' },
        trends: { games: [], rolling: [], last10_vs_season: [] },
      },
    });
    const analytics = new PlayerAnalyticsPage(page);

    await analytics.goto(ALL_STAR.id);

    await expect(analytics.percentileSection()).toBeVisible();
    await expect(analytics.distributionChart()).toBeVisible();
    await expect(page.getByText('No game logs yet', { exact: true })).toBeVisible();
    await expect(analytics.pointsTrendChart()).toHaveCount(0);
    await expect(analytics.recentGamesSection()).toHaveCount(0);
  });

  test('the player modal links through to the analytics page', async ({ page }) => {
    await mockApi(page, { playerAnalytics: ALL_STAR_ANALYTICS });
    const stats = new StatsPage(page);
    const analytics = new PlayerAnalyticsPage(page);

    await stats.goto();
    await stats.openPlayer(ALL_STAR.name);
    await page.getByRole('link', { name: /Full analytics/i }).click();

    await expect(page).toHaveURL(new RegExp(`/player/${ALL_STAR.id}$`));
    await expect(analytics.heading()).toHaveText(ALL_STAR.name);
  });
});
