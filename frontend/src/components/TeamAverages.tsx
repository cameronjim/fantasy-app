import type { RosterPlayer } from '../types';

interface CategoryDef {
  key: keyof RosterPlayer;
  isPercent?: boolean;
}

// Order matches the roster table columns so the averages row lines up under
// each stat without any custom layout work.
export const AVG_CATEGORIES: CategoryDef[] = [
  { key: 'points_per_game' },
  { key: 'rebounds_per_game' },
  { key: 'assists_per_game' },
  { key: 'steals_per_game' },
  { key: 'blocks_per_game' },
  { key: 'field_goal_percentage', isPercent: true },
  { key: 'free_throw_percentage', isPercent: true },
  { key: 'three_pointers_made' },
  { key: 'turnovers_per_game' },
];

function n(v: unknown): number { return Number(v) || 0; }

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function formatAvg(val: number, cat: CategoryDef): string {
  if (cat.isPercent) return `${val.toFixed(1)}%`;
  return val.toFixed(1);
}

export function computeRosterAverages(roster: RosterPlayer[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const cat of AVG_CATEGORIES) {
    result[cat.key as string] = mean(roster.map((p) => n(p[cat.key])));
  }
  return result;
}
