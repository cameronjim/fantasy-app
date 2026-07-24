import type { Locator, Page } from '@playwright/test';

// page object for the per-player analytics route, /player/:id.
export class PlayerAnalyticsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(playerId: number): Promise<void> {
    await this.page.goto(`/player/${playerId}`);
  }

  heading(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }

  backLink(): Locator {
    return this.page.getByRole('link', { name: /Back to stats/i });
  }

  percentileSection(): Locator {
    return this.page.getByRole('heading', { name: /Category Percentiles/i });
  }

  percentileBar(statLabel: string): Locator {
    return this.page.getByLabel(`${statLabel} percentile`);
  }

  distributionChart(): Locator {
    return this.page.getByTestId('distribution-chart');
  }

  distributionTab(statLabel: string): Locator {
    return this.page.getByRole('tab', { name: statLabel, exact: true });
  }

  pointsTrendChart(): Locator {
    return this.page.getByTestId('points-trend-chart');
  }

  recentGamesSection(): Locator {
    return this.page.getByRole('heading', { name: /Recent Games/i });
  }

  predictionCard(): Locator {
    return this.page.getByRole('heading', { name: /Projection/i });
  }

  freshnessFooter(): Locator {
    return this.page.getByText(/Game logs as of/i);
  }
}
