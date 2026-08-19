import { useEffect, useState } from 'react';

/**
 * daisyUI 5 exposes its palette as custom properties on the element carrying
 * `data-theme` (our `<html>`). Recharts writes colors onto SVG presentation
 * attributes, where `var(...)` is not reliably resolved, so we read the
 * computed values once per theme and hand recharts real color strings.
 */
const COLOR_VARS = {
  primary: '--color-primary',
  secondary: '--color-secondary',
  accent: '--color-accent',
  success: '--color-success',
  error: '--color-error',
  content: '--color-base-content',
  grid: '--color-base-300',
  surface: '--color-base-100',
} as const;

export type ChartColors = Record<keyof typeof COLOR_VARS, string>;

// jsdom (and the first paint before styles resolve) hands back empty strings.
// `currentColor` inherits the themed text color, so charts stay legible rather
// than falling back to recharts' hardcoded black.
const FALLBACK = 'currentColor';

function readChartColors(): ChartColors {
  const styles = getComputedStyle(document.documentElement);
  const entries = Object.entries(COLOR_VARS).map(([name, cssVar]) => [
    name,
    styles.getPropertyValue(cssVar).trim() || FALLBACK,
  ]);
  return Object.fromEntries(entries) as ChartColors;
}

/**
 * Resolved daisyUI palette for the active theme, re-read whenever the theme
 * picker swaps `data-theme` so charts recolor without a remount.
 */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(readChartColors);

  useEffect(() => {
    const refresh = (): void => setColors(readChartColors());
    // the theme is applied in an effect, so the very first read can predate it.
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return colors;
}
