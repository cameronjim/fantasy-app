import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AnalyticsPool, StatDistribution, StatPercentile } from '../types';
import { useChartColors } from '../hooks/useChartColors';
import { formatStat } from '../utils/stats';
import { bucketLabel, chartNumber, ordinal, clampPercentile, statLabel } from '../utils/analytics';

interface StatDistributionSectionProps {
  distributions: StatDistribution[];
  percentiles: StatPercentile[];
  pool: AnalyticsPool;
}

/**
 * Empirical histogram of one stat across the comparison pool, with the player
 * marked on it. Deliberately no fitted bell curve — these distributions are
 * skewed (most players take zero threes), and an overlaid normal would imply a
 * symmetry the data doesn't have.
 */
export const StatDistributionSection = ({
  distributions,
  percentiles,
  pool,
}: StatDistributionSectionProps): JSX.Element | null => {
  const [selected, setSelected] = useState<string>(distributions[0]?.stat ?? '');
  const colors = useChartColors();

  if (distributions.length === 0) return null;

  const active = distributions.find((d) => d.stat === selected) ?? distributions[0];
  const percentile = percentiles.find((p) => p.stat === active.stat);
  const playerValue = chartNumber(active.player_value);

  const data = active.buckets.map((bucket) => ({
    label: bucketLabel(bucket.lo, bucket.hi),
    count: chartNumber(bucket.count),
    lo: chartNumber(bucket.lo),
    hi: chartNumber(bucket.hi),
  }));

  // a categorical axis needs a category to anchor the marker to, so find the
  // bucket the player actually lands in (the last one for an out-of-range high).
  const playerBucket =
    data.find((b) => playerValue >= b.lo && playerValue < b.hi) ??
    (playerValue >= (data[data.length - 1]?.hi ?? 0) ? data[data.length - 1] : data[0]);

  return (
    <section className="card bg-base-200 border border-base-300">
      <div className="card-body p-4 sm:p-5 gap-3">
        <div>
          <h2 className="font-bold text-base">Distribution</h2>
          <p className="text-xs opacity-50 mt-0.5">
            How {pool.label} are spread across each category, counted from real games.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Distribution stat"
          className="flex flex-wrap gap-1 overflow-x-auto no-scrollbar"
        >
          {distributions.map((dist) => (
            <button
              key={dist.stat}
              role="tab"
              aria-selected={dist.stat === active.stat}
              onClick={() => setSelected(dist.stat)}
              className={`btn btn-xs ${dist.stat === active.stat ? 'btn-primary' : 'btn-ghost'}`}
            >
              {statLabel(dist.stat)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
          <span>
            <span className="opacity-50">This player </span>
            <span className="font-semibold tabular-nums">{formatStat(active.player_value)}</span>
          </span>
          {percentile && (
            <span>
              <span className="opacity-50">Percentile </span>
              <span className="font-semibold tabular-nums">
                {ordinal(clampPercentile(percentile.percentile))}
              </span>
            </span>
          )}
          <span className="opacity-50 tabular-nums">
            pool mean {formatStat(active.mean)} · sd {formatStat(active.stddev)}
          </span>
        </div>

        <div className="h-56 w-full" data-testid="distribution-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 16, right: 8, bottom: 4, left: -20 }}>
              <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: colors.content, fontSize: 10, opacity: 0.6 }}
                stroke={colors.grid}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: colors.content, fontSize: 10, opacity: 0.6 }}
                stroke={colors.grid}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: colors.grid, opacity: 0.3 }}
                contentStyle={{
                  background: colors.surface,
                  border: `1px solid ${colors.grid}`,
                  borderRadius: '0.5rem',
                  color: colors.content,
                  fontSize: '0.75rem',
                }}
                labelStyle={{ color: colors.content }}
                formatter={(value) => [`${chartNumber(String(value))} players`, statLabel(active.stat)]}
              />
              <Bar dataKey="count" fill={colors.secondary} radius={[2, 2, 0, 0]} />
              {playerBucket && (
                <ReferenceLine
                  x={playerBucket.label}
                  stroke={colors.primary}
                  strokeWidth={2}
                  label={{
                    value: percentile
                      ? `${formatStat(active.player_value)} · ${ordinal(clampPercentile(percentile.percentile))}`
                      : formatStat(active.player_value),
                    position: 'top',
                    fill: colors.primary,
                    fontSize: 10,
                  }}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
};
