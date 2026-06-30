import type { RosterPlayer } from '../types';

interface TeamAveragesProps {
  roster: RosterPlayer[];
}

interface CategoryDef {
  key: keyof RosterPlayer;
  label: string;
  benchmark: number;
  lowerIsBetter?: boolean;
  isPercent?: boolean;
}

// Same benchmarks we pass to Claude for team-analysis so the AI's view and the
// numbers shown to the user line up.
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

const MARGIN_PCT = 0.07;

function n(v: unknown): number { return Number(v) || 0; }

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
  return cat.lowerIsBetter ? (isAbove ? 'worse' : 'better') : (isAbove ? 'better' : 'worse');
}

export const TeamAverages = ({ roster }: TeamAveragesProps) => {
  if (roster.length === 0) return null;

  return (
    <div className="px-4 py-3 border-b border-base-300 bg-base-300/30">
      <p className="text-xs font-bold uppercase tracking-wider opacity-60 mb-3">
        Team averages per game
        <span className="ml-2 text-[10px] font-normal opacity-50 normal-case tracking-normal">
          vs. competitive 9-cat benchmark
        </span>
      </p>

      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-1.5">
        {CATEGORIES.map((cat) => {
          const values = roster.map((p) => n(p[cat.key]));
          const avg = mean(values);
          const cmp = compare(avg, cat);

          // Subtle tinted background — same hue family as the existing strong/avg/weak
          // badges on the 9-cat analysis card so the two views feel related.
          const tone =
            cmp === 'better'
              ? 'bg-emerald-500/10 border-emerald-500/40'
              : cmp === 'worse'
              ? 'bg-red-500/10 border-red-500/40'
              : 'bg-base-200 border-base-300';

          const valueColor =
            cmp === 'better' ? 'text-emerald-500'
            : cmp === 'worse' ? 'text-red-500'
            : '';

          return (
            <div
              key={cat.label}
              className={`flex items-baseline justify-between px-2.5 py-1.5 rounded-md border ${tone}`}
              title={`Benchmark: ${formatValue(cat.benchmark, cat)}${cat.lowerIsBetter ? ' (lower is better)' : ''}`}
            >
              <span className="text-[10px] font-bold opacity-60 uppercase tracking-wider">{cat.label}</span>
              <span className={`text-sm font-bold tabular-nums ${valueColor}`}>
                {formatValue(avg, cat)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
