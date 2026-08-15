import { test, expect } from '@playwright/test';
import { mockApi } from './fixtures/apiMock';
import { watchlistFixture } from './fixtures/watchlist';
import { WatchlistPage } from './pages';

const GUARD_ID = '1629630';

test.describe('Watchlist window and position', () => {
  test('opens on tonight, and the range is the one the server resolved', async ({ page }) => {
    await mockApi(page);
    const watchlist = new WatchlistPage(page);

    await watchlist.goto();

    await expect(watchlist.windowButton('Tonight')).toHaveAttribute('aria-pressed', 'true');
    await expect(watchlist.range).not.toContainText(' to ');
    await expect(watchlist.rankingNote).toContainText('where tonight projects');
  });

  test('a week rewires the request and shows the resolved range', async ({ page }) => {
    const requested: string[] = [];
    await mockApi(page, {
      watchlist: (params) => {
        requested.push(params.get('days') ?? 'none');
        return watchlistFixture(params);
      },
    });
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();

    await watchlist.windowButton('Week').click();

    await expect(watchlist.range).toContainText(' to ');
    await expect(watchlist.windowButton('Week')).toHaveAttribute('aria-pressed', 'true');
    expect(requested).toEqual(['none', '7']);
  });

  test('a four-game guard outranks a better two-game forward over a week', async ({ page }) => {
    await mockApi(page);
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();

    await watchlist.windowButton('Week').click();
    await expect(watchlist.row('Windowed Guard')).toBeVisible();

    await expect(watchlist.rows.first()).toContainText('Windowed Guard');
    await expect(watchlist.row('Windowed Guard')).toContainText('4 games this week');
    await expect(watchlist.row('Rested Forward')).toContainText('2 games this week');
    await expect(watchlist.rankingNote).toContainText('added up');
  });

  test('a row expands to every game in the window', async ({ page }) => {
    await mockApi(page);
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();
    await watchlist.windowButton('Week').click();
    await expect(watchlist.row('Windowed Guard')).toBeVisible();

    await watchlist.openRow('Windowed Guard');

    const rows = watchlist.breakdown(GUARD_ID).locator('tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(watchlist.breakdown(GUARD_ID)).toContainText('GSW');
    await expect(watchlist.breakdown(GUARD_ID)).toContainText('SAC');
  });

  test('a position chip filters the list and says the filter is on', async ({ page }) => {
    await mockApi(page);
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();

    await watchlist.positionChip('Guards').click();

    await expect(watchlist.row('Windowed Guard')).toBeVisible();
    await expect(watchlist.row('Rested Forward')).toHaveCount(0);
    await expect(page.getByTestId('position-note')).toContainText('guards only');
  });

  test('an empty position gets its own empty state, not the empty-slate one', async ({ page }) => {
    await mockApi(page);
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();

    await watchlist.positionChip('C').click();

    await expect(page.getByText('No centers clear the bar tonight')).toBeVisible();
    await expect(page.getByText(/2 projected players have no position on record/)).toBeVisible();
    await expect(
      page.getByText('Nobody is projected above their own usual tonight')
    ).toHaveCount(0);

    await page.getByRole('button', { name: 'every position' }).click();
    await expect(watchlist.row('Rested Forward')).toBeVisible();
  });

  test('each row names the position the filter would match it on', async ({ page }) => {
    await mockApi(page);
    const watchlist = new WatchlistPage(page);

    await watchlist.goto();

    await expect(watchlist.row('Windowed Guard')).toContainText('PG/SG');
    await expect(watchlist.row('Rested Forward')).toContainText('SF/PF');
  });

  test('the team select filters rows client-side, without a new request', async ({ page }) => {
    const requested: string[] = [];
    await mockApi(page, {
      watchlist: (params) => {
        requested.push(params.get('days') ?? 'none');
        return watchlistFixture(params);
      },
    });
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();
    await expect(watchlist.row('Windowed Guard')).toBeVisible();

    await watchlist.teamSelect.selectOption('BOS');

    await expect(watchlist.row('Windowed Guard')).toHaveCount(0);
    await expect(watchlist.row('Rested Forward')).toBeVisible();
    expect(requested).toEqual(['none']);
  });
});
