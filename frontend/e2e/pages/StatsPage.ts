import type { Locator, Page } from '@playwright/test';
import { PlayerTableComponent } from './PlayerTableComponent';
import { PlayerModalComponent } from './PlayerModalComponent';

// page object for the home / Stats route.
export class StatsPage {
  readonly page: Page;
  readonly playerTable: PlayerTableComponent;
  readonly playerModal: PlayerModalComponent;

  constructor(page: Page) {
    this.page = page;
    this.playerTable = new PlayerTableComponent(page);
    this.playerModal = new PlayerModalComponent(page);
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  searchInput(): Locator {
    return this.page.getByPlaceholder(/Search players/i);
  }

  async searchPlayers(name: string): Promise<void> {
    await this.searchInput().fill(name);
  }

  async openPlayer(name: string): Promise<void> {
    await this.playerTable.clickRow(name);
  }
}
