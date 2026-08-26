import { Info } from 'lucide-react';
import type { AnalyticsPool, StatPercentile } from '../../types';
import { formatStat } from '../../utils/stats';
import { clampPercentile, ordinal, percentileTier, statHint, statLabel } from '../../utils/analytics';

interface PercentilePanelProps {
  percentiles: StatPercentile[];
  pool: AnalyticsPool;
}

// tailwind only emits classes it can see as literals, so the map is spelled out.
const TIER_CLASS = {
  success: 'progress-success',
  primary: 'progress-primary',
  warning: 'progress-warning',
  error: 'progress-error',
} as const;

// turnover percentiles arrive already inverted, so every bar reads further-right-is-better.
export const PercentilePanel = ({ percentiles, pool }: PercentilePanelProps): JSX.Element => (
  <section className="card bg-base-200 border border-base-300">
    <div className="card-body p-4 sm:p-5 gap-3">
      <div>
        <h2 className="font-bold text-base">Category Percentiles</h2>
        <p className="text-xs opacity-50 mt-0.5">
          vs {pool.label} · {pool.definition} · n={formatStat(pool.sample_size, 0)}
        </p>
      </div>

      {percentiles.length === 0 ? (
        <p className="text-sm opacity-50 py-4">No percentile data for this player yet.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {percentiles.map((row) => {
            const pct = clampPercentile(row.percentile);
            const hint = statHint(row.stat);
            const label = statLabel(row.stat);
            return (
              <li
                key={row.stat}
                className="grid grid-cols-[72px_1fr_auto] items-center gap-2 sm:gap-3"
              >
                {/* opacity must stay off this container: a translucent ancestor makes the
                    tooltip bubble translucent and traps it under later progress bars. */}
                <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider">
                  <span className="truncate opacity-70">{label}</span>
                  {hint && (
                    <span className="tooltip tooltip-right" data-tip={hint}>
                      <Info size={11} className="opacity-50" aria-label={`${label} explanation`} />
                    </span>
                  )}
                </span>

                <span className="flex items-center gap-2 min-w-0">
                  <progress
                    className={`progress ${TIER_CLASS[percentileTier(pct)]} w-full h-2.5`}
                    value={pct}
                    max={100}
                    aria-label={`${label} percentile`}
                  />
                  <span className="text-xs tabular-nums opacity-60 w-9 shrink-0 text-right">
                    {ordinal(pct)}
                  </span>
                </span>

                <span className="text-sm font-semibold tabular-nums w-12 text-right">
                  {formatStat(row.value)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  </section>
);
