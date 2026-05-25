import { test, expect } from '@playwright/test';
import { FantasyPage, ImproveTeamPage, LoginPage, NavbarComponent } from './pages';
import { mockApi } from './fixtures/apiMock';

test.describe('Protected routes when signed out', () => {
  test('Fantasy page shows the "Sign in to use My Team" prompt', async ({ page }) => {
    await mockApi(page, { rosterRequiresAuth: true });
    const fantasy = new FantasyPage(page);

    await fantasy.goto();

    await expect(fantasy.signInPrompt()).toBeVisible();
  });

  test('Improve Team page shows the "Sign in to unlock AI suggestions" prompt', async ({ page }) => {
    await mockApi(page, { rosterRequiresAuth: true });
    const improve = new ImproveTeamPage(page);

    await improve.goto();

    await expect(improve.signInPrompt()).toBeVisible();
  });

  test('Sign In button in the navbar routes to /login', async ({ page }) => {
    await mockApi(page);
    const navbar = new NavbarComponent(page);
    const login = new LoginPage(page);

    await page.goto('/');
    await navbar.goToSignIn();

    // The login page mounts the Google OAuth iframe which pulls scripts from
    // accounts.google.com — that's slow under headless Chromium and can race
    // with the heading-visible assertion. The URL transition + presence of
    // the username field is a faster and equivalent signal that LoginPage
    // mounted.
    await expect(page).toHaveURL(/\/login$/);
    await expect(login.usernameInput()).toBeVisible();
  });
});
