import type { Locator, Page } from '@playwright/test';

// page object for the /improve (Improve Team) route.
export class ImproveTeamPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto('/improve');
  }

  signInPrompt(): Locator {
    return this.page.getByText(/Sign in to unlock AI suggestions/i);
  }

  emptyRosterPrompt(): Locator {
    return this.page.getByText(/Add players to your team first/i);
  }

  tradeTargetsHeader(): Locator {
    return this.page.getByRole('heading', { name: /Trade Targets/i });
  }

  waiverPickupsHeader(): Locator {
    return this.page.getByRole('heading', { name: /Waiver Wire Pickups/i });
  }
}
