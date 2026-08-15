import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { clearCachedResources } from '../src/api/resourceCache';

// jsdom has no scrollIntoView and ChatBox calls it on every message change.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// jsdom has no ResizeObserver, which recharts constructs on mount.
if (!('ResizeObserver' in window)) {
  window.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  localStorage.clear();
  clearCachedResources();
});
