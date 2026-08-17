import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { clearCachedResources } from '../src/api/resourceCache';

// jsdom doesn't implement scrollIntoView; ChatBox calls it on every message
// change, so tests that render the page would crash without this shim.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// jsdom has no ResizeObserver, which recharts' ResponsiveContainer constructs
// on mount. jsdom also reports zero-size elements, so the charts render empty
// under test — assertions target the containers around them, not the svg.
if (!('ResizeObserver' in window)) {
  window.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// react testing library doesn't auto-cleanup with vitest, so we wire it up
// once here instead of repeating in every test file.
afterEach(() => {
  cleanup();
});

// each test gets a clean localStorage and resource cache so state from one
// test never bleeds into the next.
beforeEach(() => {
  localStorage.clear();
  clearCachedResources();
});
