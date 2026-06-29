import { useEffect, useState } from 'react';

const LIGHT = 'lofi';
const DARK = 'business';
const STORAGE_KEY = 'theme';

type Theme = typeof LIGHT | typeof DARK;

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return LIGHT;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === LIGHT || stored === DARK) return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT;
}

/**
 * Shared theme hook. Use in any component that needs to read or toggle the
 * current daisyUI theme. Persists in localStorage; matches the pre-paint
 * script in index.html that prevents flash-of-light.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === LIGHT ? DARK : LIGHT)),
  };
}
