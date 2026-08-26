import { useEffect, useState } from 'react';

const STORAGE_KEY = 'theme';

export interface ThemeOption {
  id: string;
  label: string;
  scheme: 'light' | 'dark';
}

export const THEMES: readonly ThemeOption[] = [
  { id: 'lofi', label: 'Light', scheme: 'light' },
  { id: 'cream', label: 'Cream', scheme: 'light' },
  { id: 'sage', label: 'Sage', scheme: 'light' },
  { id: 'slate', label: 'Slate', scheme: 'light' },
  { id: 'ocean', label: 'Ocean', scheme: 'light' },
  { id: 'business', label: 'Dark', scheme: 'dark' },
  { id: 'graphite', label: 'Graphite', scheme: 'dark' },
];

const THEME_IDS = new Set(THEMES.map((t) => t.id));
const DEFAULT_LIGHT = 'lofi';
const DEFAULT_DARK = 'business';

function getInitialTheme(): string {
  if (typeof window === 'undefined') return DEFAULT_LIGHT;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && THEME_IDS.has(stored)) return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? DEFAULT_DARK : DEFAULT_LIGHT;
}

// the pre-paint script in index.html mirrors this logic and must change with it.
export function useTheme(): {
  theme: string;
  setTheme: (id: string) => void;
  themes: readonly ThemeOption[];
} {
  const [theme, setThemeState] = useState<string>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = (id: string): void => {
    if (THEME_IDS.has(id)) setThemeState(id);
  };

  return { theme, setTheme, themes: THEMES };
}
