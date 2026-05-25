import type { Locator, Page } from '@playwright/test';

// component object for the top-of-page navigation. exposes user-level
// actions ("go to my team") instead of leaking selectors to tests.
export class NavbarComponent {
  readonly page: Page;
  readonly root: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByRole('navigation').or(page.locator('.navbar')).first();
  }

  statsLink(): Locator {
    return this.page.getByRole('link', { name: /^Stats$/i });
  }

  signInButton(): Locator {
    return this.page.getByRole('button', { name: /Sign In/i });
  }

  async goToSignIn(): Promise<void> {
    await this.signInButton().click();
  }
}
