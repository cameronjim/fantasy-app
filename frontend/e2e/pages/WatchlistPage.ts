import type { Locator, Page } from '@playwright/test';

/**
 * The watchlist route. Its controls — the window picker, the position
 * segmented control, and the team select — are the same segmented-button /
 * select pattern as the Stats page (see StatsPage.ts / StatsPage.tsx), so
 * this object exposes them by their visible label rather than by a test id: a
 * spec that clicks "Week" is asserting the label a manager reads, not an
 * implementation detail.
 */
export class WatchlistPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/watchlist');
    await this.page.getByRole('heading', { name: 'Watchlist' }).waitFor();
  }

  /** One of Tonight / 3 days / Week / 2 weeks. */
  windowButton(label: string): Locator {
    return this.page.getByRole('button', { name: label, exact: true });
  }

  /** One of All / PG / SG / SF / PF / C / Guards / Forwards. */
  positionChip(label: string): Locator {
    return this.page.getByTestId('position-filter').getByRole('button', { name: label, exact: true });
  }

  /** The client-side team filter — same classes as the Stats page's team select. */
  get teamSelect(): Locator {
    return this.page.getByRole('combobox', { name: 'Filter by team' });
  }

  /** The resolved date range the server sent back. */
  get range(): Locator {
    return this.page.getByTestId('window-range');
  }

  /** The always-visible sentence explaining how rows are ranked. */
  get rankingNote(): Locator {
    return this.page.getByTestId('ranking-note');
  }

  /** Candidate rows, in the server's order. */
  get rows(): Locator {
    return this.page.locator('li').filter({ has: this.page.locator('details') });
  }

  row(name: string): Locator {
    return this.rows.filter({ hasText: name });
  }

  /** The per-game breakdown inside one row, once the row is open. */
  breakdown(playerId: string): Locator {
    return this.page.getByTestId(`games-${playerId}`);
  }

  async openRow(name: string): Promise<void> {
    await this.row(name).getByText(name, { exact: true }).click();
  }
}
