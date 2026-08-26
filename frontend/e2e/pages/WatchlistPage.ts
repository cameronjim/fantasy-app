import type { Locator, Page } from '@playwright/test';

export class WatchlistPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/watchlist');
    await this.page.getByRole('heading', { name: 'Watchlist' }).waitFor();
  }

  windowButton(label: string): Locator {
    return this.page.getByRole('button', { name: label, exact: true });
  }

  positionChip(label: string): Locator {
    return this.page.getByTestId('position-filter').getByRole('button', { name: label, exact: true });
  }

  get teamSelect(): Locator {
    return this.page.getByRole('combobox', { name: 'Filter by team' });
  }

  get range(): Locator {
    return this.page.getByTestId('window-range');
  }

  get rankingNote(): Locator {
    return this.page.getByTestId('ranking-note');
  }

  get rows(): Locator {
    return this.page.locator('li').filter({ has: this.page.locator('details') });
  }

  row(name: string): Locator {
    return this.rows.filter({ hasText: name });
  }

  breakdown(playerId: string): Locator {
    return this.page.getByTestId(`games-${playerId}`);
  }

  async openRow(name: string): Promise<void> {
    await this.row(name).getByText(name, { exact: true }).click();
  }
}
