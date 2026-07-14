/**
 * Display formatting for betting numbers. Pure string helpers — all odds math
 * (implied probability, edges) is computed server-side and arrives in the API
 * payload.
 */

/** -110 → "-110", 150 → "+150" */
export function formatAmerican(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/** 0.5238 → "52.4%" */
export function formatPercent(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** signed percent for edges: 0.067 → "+6.7%", -0.02 → "-2.0%" */
export function formatSignedPercent(p: number): string {
  const formatted = formatPercent(Math.abs(p));
  return p >= 0 ? `+${formatted}` : `-${formatted}`;
}

/** spread line for display: -2.5 → "-2.5", 2.5 → "+2.5" */
export function formatLine(line: number): string {
  return line > 0 ? `+${line}` : `${line}`;
}
