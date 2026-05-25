import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// react testing library doesn't auto-cleanup with vitest, so we wire it up
// once here instead of repeating in every test file.
afterEach(() => {
  cleanup();
});

// each test gets a clean localStorage so token state from one test never
// bleeds into the next.
beforeEach(() => {
  localStorage.clear();
});
