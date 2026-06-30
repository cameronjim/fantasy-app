import type { Locator, Page } from '@playwright/test';

// component object for the player detail modal.
export class PlayerModalComponent {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  root(): Locator {
    return this.page.locator('.modal.modal-open');
  }

  heading(): Locator {
    return this.root().getByRole('heading');
  }

  closeButton(): Locator {
    return this.root().getByRole('button', { name: '✕' });
  }

  async close(): Promise<void> {
    await this.closeButton().click();
  }
}
