import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// vitest runs the react unit tests under jsdom. playwright e2e tests live
// in frontend/e2e/ and are driven by playwright.config.ts, not vitest.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    css: false,
  },
});
