import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme, THEMES } from '../../src/hooks/useTheme';

beforeEach(() => {
  // jsdom has no real matchMedia, so stub a deterministic default.
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTheme', () => {
  it('exposes the expected set of theme ids', () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      'lofi', 'cream', 'sage', 'slate', 'ocean', 'business', 'graphite',
    ]);
  });

  it('applies a chosen theme to the document and persists it', () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme('cream'));

    expect(result.current.theme).toBe('cream');
    expect(document.documentElement.getAttribute('data-theme')).toBe('cream');
    expect(localStorage.getItem('theme')).toBe('cream');
  });

  it('ignores an unknown theme id', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('ocean'));

    act(() => result.current.setTheme('neon-banana'));

    expect(result.current.theme).toBe('ocean');
  });

  it('initializes from a stored theme when one is present', () => {
    localStorage.setItem('theme', 'graphite');

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('graphite');
  });
});
