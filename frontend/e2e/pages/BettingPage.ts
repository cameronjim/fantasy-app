import type { Locator, Page } from '@playwright/test';

// page object for the /betting route.
export class BettingPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto('/betting');
  }

  disclaimer(): Locator {
    return this.page.getByText(/1-800-GAMBLER/);
  }

  signInPrompt(): Locator {
    return this.page.getByText(/Sign in to unlock AI betting picks/i);
  }

  oddsBoardHeading(): Locator {
    return this.page.getByRole('heading', { name: /Upcoming Games & Odds/i });
  }

  glossaryHeading(): Locator {
    return this.page.getByRole('heading', { name: /New to betting\? Start here/i });
  }

  // daisyui collapse puts an invisible checkbox over the title, so clicks
  // must target the checkbox (by its aria-label), not the title text.
  glossaryToggle(term: string): Locator {
    return this.page.getByLabel(`Toggle explanation of ${term}`);
  }

  categoryHeading(name: 'Best Value' | 'Safe' | 'Hail Mary'): Locator {
    return this.page.getByRole('heading', { name, exact: true });
  }

  parlayHeading(): Locator {
    return this.page.getByRole('heading', { name: /Suggested Parlay/i });
  }

  ledgerHeading(): Locator {
    return this.page.getByRole('heading', { name: 'My Bets' });
  }

  addBetButton(): Locator {
    return this.page.getByRole('button', { name: '+ Add bet' });
  }

  prefsToggle(): Locator {
    return this.page.getByRole('button', { name: /Betting Preferences/i });
  }

  savePrefsButton(): Locator {
    return this.page.getByRole('button', { name: /Save & Re-analyze/i });
  }

  chatHeading(): Locator {
    return this.page.getByText('AI Assistant', { exact: true });
  }

  seeMoreButton(): Locator {
    return this.page.getByRole('button', { name: /See more/ });
  }
}
