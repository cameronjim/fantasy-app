import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme, THEMES } from '../../src/hooks/useTheme';

beforeEach(() => {
  // deterministic default regardless of jsdom's matchMedia support.
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTheme', () => {
  it('exposes the expected set of theme ids', () => {
    // act + assert
    expect(THEMES.map((t) => t.id)).toEqual([
      'lofi', 'cream', 'sage', 'slate', 'ocean', 'business', 'graphite',
    ]);
  });

  it('applies a chosen theme to the document and persists it', () => {
    // arrange
    const { result } = renderHook(() => useTheme());

    // act
    act(() => result.current.setTheme('cream'));

    // assert
    expect(result.current.theme).toBe('cream');
    expect(document.documentElement.getAttribute('data-theme')).toBe('cream');
    expect(localStorage.getItem('theme')).toBe('cream');
  });

  it('ignores an unknown theme id', () => {
    // arrange
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('ocean'));

    // act
    act(() => result.current.setTheme('neon-banana'));

    // assert — stays on the last valid theme.
    expect(result.current.theme).toBe('ocean');
  });

  it('initializes from a stored theme when one is present', () => {
    // arrange
    localStorage.setItem('theme', 'graphite');

    // act
    const { result } = renderHook(() => useTheme());

    // assert
    expect(result.current.theme).toBe('graphite');
  });
});
