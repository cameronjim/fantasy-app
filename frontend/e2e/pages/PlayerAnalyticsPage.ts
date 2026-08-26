import type { Locator, Page } from '@playwright/test';

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

  // every stat tablist here repeats the same labels, so each must stay scoped by tablist name.
  distributionTab(statLabel: string): Locator {
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

  upcomingStatTab(statLabel: string): Locator {
    return this.page
      .getByRole('tablist', { name: 'Prediction stat' })
      .getByRole('tab', { name: statLabel, exact: true });
  }

  freshnessFooter(): Locator {
    return this.page.getByText(/Game logs as of/i);
  }
}
