import type { Locator, Page } from '@playwright/test';

// component object for the player stats table. exposes user-level actions
// (sort, select) and per-row locators so tests don't need to know about
// the underlying dom structure or column widths.
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

  // returns the cell under the FS header for the given player row. the
  // table's column layout is fixed (PlayerTable.COLUMNS); when the compare-
  // checkbox column is rendered (StatsPage always renders it), the columns
  // Player/Team/Pos/FS sit at td indices 1/2/3/4.
  fsCellFor(name: string): Locator {
    return this.rowFor(name).locator('td').nth(4);
  }

  // match the column header text exactly so the regex doesn't collide with
  // similar labels (e.g. FS vs FT% in tooltips).
  async clickSort(label: 'PPG' | 'FS' | 'Player' | 'RPG' | 'APG'): Promise<void> {
    await this.root.locator('thead th', { hasText: new RegExp(`^${label}\\b`) }).click();
  }

  async clickRow(name: string): Promise<void> {
    await this.rowFor(name).click();
  }
}
