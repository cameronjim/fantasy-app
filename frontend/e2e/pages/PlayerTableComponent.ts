import type { Locator, Page } from '@playwright/test';

export class PlayerTableComponent {
  readonly page: Page;
  readonly root: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator('table').first();
  }

  rows(): Locator {
    return this.root.locator('tbody tr');
  }

  rowFor(name: string): Locator {
    return this.root.locator('tbody tr', { hasText: name });
  }

  // td 0 is the compare checkbox StatsPage always renders, which puts FS at td 4.
  fsCellFor(name: string): Locator {
    return this.rowFor(name).locator('td').nth(4);
  }

  async clickSort(label: 'PPG' | 'FS' | 'Player' | 'RPG' | 'APG'): Promise<void> {
    await this.root.locator('thead th', { hasText: new RegExp(`^${label}\\b`) }).click();
  }

  async clickRow(name: string): Promise<void> {
    await this.rowFor(name).click();
  }
}
