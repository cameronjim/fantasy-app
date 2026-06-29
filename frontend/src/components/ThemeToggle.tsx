import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';

// daisyUI themes — lofi is a clean light theme, business is a polished dark one.
const LIGHT = 'lofi';
const DARK = 'business';
const STORAGE_KEY = 'theme';

function getInitialTheme(): string {
  if (typeof window === 'undefined') return LIGHT;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === LIGHT || stored === DARK) return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT;
}

export const ThemeToggle = () => {
  const [theme, setTheme] = useState<string>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const isDark = theme === DARK;
  return (
    <button
      onClick={() => setTheme(isDark ? LIGHT : DARK)}
      className="btn btn-ghost btn-sm btn-circle"
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
};
