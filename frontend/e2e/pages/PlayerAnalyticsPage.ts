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
    // scoped: the trends section has a tablist with the same stat names
    return this.page
      .getByRole('tablist', { name: 'Distribution stat' })
      .getByRole('tab', { name: statLabel, exact: true });
  }

  trendTab(statLabel: string): Locator {
    return this.page
      .getByRole('tablist', { name: 'Trend stat' })
      .getByRole('tab', { name: statLabel, exact: true });
  }

  trendChart(): Locator {
    return this.page.getByTestId('trend-chart');
  }

  recentGamesSection(): Locator {
    return this.page.getByRole('heading', { name: /Recent Games/i });
  }

  predictionCard(): Locator {
    return this.page.getByRole('heading', { name: /Projection/i });
  }

  upcomingGamesSection(): Locator {
    return this.page.getByTestId('upcoming-games-section');
  }

  upcomingGamesTable(): Locator {
    return this.page.getByTestId('upcoming-games-table');
  }

  upcomingGameRows(): Locator {
    return this.page.getByTestId('upcoming-game-row');
  }

  // scoped: the trends and distribution sections both carry stat tablists with
  // the same labels.
  upcomingStatTab(statLabel: string): Locator {
    return this.page
      .getByRole('tablist', { name: 'Prediction stat' })
      .getByRole('tab', { name: statLabel, exact: true });
  }

  freshnessFooter(): Locator {
    return this.page.getByText(/Game logs as of/i);
  }
}
