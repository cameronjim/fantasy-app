import type { Locator, Page } from '@playwright/test';

export class LoginPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto('/login');
  }

  // the login labels are not linked to their inputs by for/id, so getByLabel does not match.
  usernameInput(): Locator {
    return this.page.locator('input[autocomplete="username"]');
  }
}
