import type { Locator, Page } from '@playwright/test';

// page object for the /login route.
export class LoginPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto('/login');
  }

  // the login labels are visually attached but not linked to their inputs
  // via for/id, so getByLabel doesn't match. use the autocomplete attribute,
  // which is already set on each input and is a stable, semantic anchor.
  usernameInput(): Locator {
    return this.page.locator('input[autocomplete="username"]');
  }
}
