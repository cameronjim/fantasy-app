import { Sparkles } from 'lucide-react';
import type { AnalyticsStat, PlayerPrediction } from '../types';
import { formatStat } from '../utils/stats';
import { formatTimestamp, statLabel } from '../utils/analytics';

interface PlayerPredictionCardProps {
  prediction: PlayerPrediction;
}

const CONFIDENCE_CLASS = {
  low: 'badge-ghost',
  medium: 'badge-warning',
  high: 'badge-success',
} as const;

/**
 * Forward projection, rendered only when the api actually returns one. The
 * endpoint sends `prediction: null` until the model ships, so the page has to
 * look identical with and without it.
 */
export const PlayerPredictionCard = ({ prediction }: PlayerPredictionCardProps): JSX.Element => {
  const projected = Object.entries(prediction.projected ?? {}) as Array<
    [AnalyticsStat, number | string]
  >;
  const asOf = formatTimestamp(prediction.as_of ?? null);

  return (
    <section className="card bg-base-200 border border-primary/30">
      <div className="card-body p-4 sm:p-5 gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Sparkles size={16} className="text-primary" />
          <h2 className="font-bold text-base">Projection</h2>
          {prediction.confidence && (
            <span className={`badge badge-sm ${CONFIDENCE_CLASS[prediction.confidence]}`}>
              {prediction.confidence} confidence
            </span>
          )}
        </div>

        {prediction.summary && <p className="text-sm opacity-80">{prediction.summary}</p>}

        {projected.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {projected.map(([stat, value]) => (
              <div key={stat} className="rounded-box bg-base-100 border border-base-300 px-2 py-1.5">
                <p className="text-sm font-semibold tabular-nums">{formatStat(value)}</p>
                <p className="text-[10px] uppercase tracking-wider opacity-50">{statLabel(stat)}</p>
              </div>
            ))}
          </div>
        )}

        {asOf && <p className="text-[10px] opacity-40">Projected {asOf}</p>}
      </div>
    </section>
  );
};
