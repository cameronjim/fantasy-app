import type { Locator, Page } from '@playwright/test';

// page object for the /fantasy (My Team) route.
export class FantasyPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto('/fantasy');
  }

  signInPrompt(): Locator {
    return this.page.getByText(/Sign in to use My Team/i);
  }
}
