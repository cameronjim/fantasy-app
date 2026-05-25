import { defineConfig, devices } from '@playwright/test';

// e2e tests drive the vite dev server with route interception, so no real
// backend (and no real anthropic key) is needed. browsers are installed via
// `npm run test:e2e:install` (also done by ci before the test:e2e step).
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 5174);
// use `localhost` (not 127.0.0.1) — vite binds to localhost-only by default,
// and on windows that resolves to ::1 first, which means a 127.0.0.1 probe
// times out even though the server is up. match what `vite` prints.
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
