import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { RosterPlayer } from '../types';

interface TeamAveragesProps {
  roster: RosterPlayer[];
}

interface CategoryDef {
  key: keyof RosterPlayer;
  label: string;
  benchmark: number;
  /** When true, lower is better (e.g. turnovers). */
  lowerIsBetter?: boolean;
  /** When true, format as a percentage (45.6% not 45.6). */
  isPercent?: boolean;
}

// Benchmarks are the per-player averages from a competitive 10-team 9-cat league
// (same numbers we hand to Claude in the team-analysis prompt for consistency).
const CATEGORIES: CategoryDef[] = [
  { key: 'points_per_game',         label: 'PTS', benchmark: 15.0 },
  { key: 'rebounds_per_game',       label: 'REB', benchmark: 5.0 },
  { key: 'assists_per_game',        label: 'AST', benchmark: 3.5 },
  { key: 'steals_per_game',         label: 'STL', benchmark: 1.0 },
  { key: 'blocks_per_game',         label: 'BLK', benchmark: 0.7 },
  { key: 'field_goal_percentage',   label: 'FG%', benchmark: 46.0, isPercent: true },
  { key: 'free_throw_percentage',   label: 'FT%', benchmark: 78.0, isPercent: true },
  { key: 'three_pointers_made',     label: '3PM', benchmark: 1.5 },
  { key: 'turnovers_per_game',      label: 'TO',  benchmark: 1.8, lowerIsBetter: true },
];

// What counts as "meaningfully better/worse" — anything within this margin
// of the benchmark is considered roughly average.
const MARGIN_PCT = 0.07;

function n(v: unknown): number {
  return Number(v) || 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function formatValue(val: number, cat: CategoryDef): string {
  if (cat.isPercent) return `${val.toFixed(1)}%`;
  return val.toFixed(1);
}

type Comparison = 'better' | 'worse' | 'similar';

function compare(val: number, cat: CategoryDef): Comparison {
  const diff = (val - cat.benchmark) / cat.benchmark;
  if (Math.abs(diff) < MARGIN_PCT) return 'similar';
  const isAbove = diff > 0;
  // Most cats: higher = better. Turnovers: lower = better.
  return cat.lowerIsBetter ? (isAbove ? 'worse' : 'better') : (isAbove ? 'better' : 'worse');
}

export const TeamAverages = ({ roster }: TeamAveragesProps) => {
  if (roster.length === 0) return null;

  return (
    <div className="px-4 py-3 border-b border-base-300 bg-base-300/30">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-bold uppercase tracking-wider opacity-60">Team averages per game</p>
        <p className="text-[10px] opacity-40">vs. competitive 9-cat benchmark</p>
      </div>
      <div className="grid grid-cols-5 sm:grid-cols-9 gap-2">
        {CATEGORIES.map((cat) => {
          const values = roster.map((p) => n(p[cat.key]));
          const avg = mean(values);
          const cmp = compare(avg, cat);

          const color =
            cmp === 'better' ? 'text-emerald-500'
            : cmp === 'worse' ? 'text-red-500'
            : 'opacity-60';

          const Icon =
            cmp === 'better' ? TrendingUp
            : cmp === 'worse' ? TrendingDown
            : Minus;

          return (
            <div
              key={cat.label}
              className="flex flex-col items-center justify-center rounded-lg bg-base-200 px-2 py-1.5"
              title={`Benchmark: ${formatValue(cat.benchmark, cat)}${cat.lowerIsBetter ? ' (lower is better)' : ''}`}
            >
              <div className="text-[10px] font-bold opacity-50 uppercase tracking-wider">{cat.label}</div>
              <div className="flex items-center gap-1 mt-0.5">
                <Icon size={12} className={color} />
                <span className={`text-sm font-semibold tabular-nums ${color}`}>
                  {formatValue(avg, cat)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
