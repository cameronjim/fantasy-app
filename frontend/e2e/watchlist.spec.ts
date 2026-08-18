import { test, expect } from '@playwright/test';
import { mockApi } from './fixtures/apiMock';
import { watchlistFixture } from './fixtures/watchlist';
import { WatchlistPage } from './pages';

/**
 * The watchlist's window and position controls, driven in a real browser.
 *
 * These exist because the two controls are the only place in the app where a
 * user's click changes what a NUMBER MEANS: the same column is a single game's
 * product on "Tonight" and a sum over four games on "Week". A unit test can
 * assert the wording; only a browser can confirm the click rewires the request
 * and the row redraws around the answer.
 */

const GUARD_ID = '1629630';

test.describe('Watchlist window and position', () => {
  test('opens on tonight, and the range is the one the server resolved', async ({ page }) => {
    // arrange
    await mockApi(page);
    const watchlist = new WatchlistPage(page);

    // act
    await watchlist.goto();

    // assert — a single day shows one date, not a range of one
    await expect(watchlist.windowButton('Tonight')).toHaveAttribute('aria-pressed', 'true');
    await expect(watchlist.range).not.toContainText('–');
    await expect(watchlist.rankingNote).toContainText('where tonight projects');
  });

  test('a week rewires the request and shows the resolved range', async ({ page }) => {
    // arrange
    const requested: string[] = [];
    await mockApi(page, {
      watchlist: (params) => {
        requested.push(params.get('days') ?? 'none');
        return watchlistFixture(params);
      },
    });
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();

    // act
    await watchlist.windowButton('Week').click();

    // assert
    await expect(watchlist.range).toContainText('–');
    await expect(watchlist.windowButton('Week')).toHaveAttribute('aria-pressed', 'true');
    // the default request omits `days` entirely; the week request carries it
    expect(requested).toEqual(['none', '7']);
  });

  test('a four-game guard outranks a better two-game forward over a week', async ({ page }) => {
    // arrange
    await mockApi(page);
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();

    // act
    await watchlist.windowButton('Week').click();
    await expect(watchlist.row('Windowed Guard')).toBeVisible();

    // assert — this is the whole reason the window exists, checked as an ORDER
    await expect(watchlist.rows.first()).toContainText('Windowed Guard');
    await expect(watchlist.row('Windowed Guard')).toContainText('4 games this week');
    await expect(watchlist.row('Rested Forward')).toContainText('2 games this week');
    await expect(watchlist.rankingNote).toContainText('added up');
  });

  test('a row expands to every game in the window', async ({ page }) => {
    // arrange
    await mockApi(page);
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();
    await watchlist.windowButton('Week').click();
    await expect(watchlist.row('Windowed Guard')).toBeVisible();

    // act
    await watchlist.openRow('Windowed Guard');

    // assert — four projected games, each with its own opponent
    const rows = watchlist.breakdown(GUARD_ID).locator('tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(watchlist.breakdown(GUARD_ID)).toContainText('GSW');
    await expect(watchlist.breakdown(GUARD_ID)).toContainText('SAC');
  });

  test('a position chip filters the list and says the filter is on', async ({ page }) => {
    // arrange
    await mockApi(page);
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();

    // act
    await watchlist.positionChip('Guards').click();

    // assert
    await expect(watchlist.row('Windowed Guard')).toBeVisible();
    await expect(watchlist.row('Rested Forward')).toHaveCount(0);
    await expect(page.getByTestId('position-note')).toContainText('guards only');
  });

  test('an empty position gets its own empty state, not the empty-slate one', async ({ page }) => {
    // arrange — the fixture has no centre, so this is the real answer
    await mockApi(page);
    const watchlist = new WatchlistPage(page);
    await watchlist.goto();

    // act
    await watchlist.positionChip('C').click();

    // assert
    await expect(page.getByText('No centers clear the bar tonight')).toBeVisible();
    await expect(page.getByText(/2 projected players could not be considered/)).toBeVisible();
    await expect(
      page.getByText('Nobody is projected above their own usual tonight')
    ).toHaveCount(0);

    // and the escape hatch in that empty state clears the filter
    await page.getByRole('button', { name: 'every position' }).click();
    await expect(watchlist.row('Rested Forward')).toBeVisible();
  });

  test('each row names the position the filter would match it on', async ({ page }) => {
    // arrange
    await mockApi(page);
    const watchlist = new WatchlistPage(page);

    // act
    await watchlist.goto();

    // assert — a combo player shows both, because he answers both filters
    await expect(watchlist.row('Windowed Guard')).toContainText('PG/SG');
    await expect(watchlist.row('Rested Forward')).toContainText('SF/PF');
  });

  test('the team select filters rows client-side, without a new request', async ({ page }) => {
    // arrange — the guard is MEM, the forward is BOS
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

    // act
    await watchlist.teamSelect.selectOption('BOS');

    // assert — the request log has exactly the one initial fetch
    await expect(watchlist.row('Windowed Guard')).toHaveCount(0);
    await expect(watchlist.row('Rested Forward')).toBeVisible();
    expect(requested).toEqual(['none']);
  });
});
