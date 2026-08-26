import { ArrowUpRight } from 'lucide-react';
import { REASON_META, REASON_ORDER, ReasonBadge } from './ReasonBadge';

export const WatchlistLegend = ({ days }: { days: number }): JSX.Element => (
  <section className="card bg-base-200 border border-base-300">
    <div className="card-body p-4 gap-2">
      <h2 className="font-bold text-sm">What the badges mean</h2>
      <ul className="flex flex-col gap-1.5">
        {REASON_ORDER.map((reason) => (
          <li key={reason} className="flex items-start gap-2">
            <span className="shrink-0">
              <ReasonBadge reason={reason} />
            </span>
            <span className="text-xs opacity-60">{REASON_META[reason].description}</span>
          </li>
        ))}
        <li className="flex items-start gap-2">
          <span className="shrink-0">
            <span className="badge badge-outline badge-sm font-semibold">PG/SG</span>
          </span>
          <span className="text-xs opacity-60">
            Every position he is listed at, so &ldquo;PG/SG&rdquo; shows up under both Guards and
            PG.
          </span>
        </li>
        {days > 1 && (
          <li className="flex items-start gap-2">
            <span className="shrink-0">
              <span className="badge badge-primary badge-sm">4 games</span>
            </span>
            <span className="text-xs opacity-60">
              Games projected in the window. The score adds them up, so more games ranks higher.
            </span>
          </li>
        )}
      </ul>
      <p className="text-xs opacity-60 pt-1 border-t border-base-300 mt-1">
        Badges explain a row; they do not rank it.
      </p>
    </div>
  </section>
);

// always visible rather than a tooltip: a reader who does not know what the score
// means will not hover to find out.
export const RankingNote = ({ days }: { days: number }): JSX.Element => (
  <p className="text-[11px] opacity-60 flex items-start gap-1.5" data-testid="ranking-note">
    <ArrowUpRight size={13} className="text-success shrink-0 mt-0.5" />
    {days > 1 ? (
      <span>
        Ranked by how far above his usual each game projects,{' '}
        <strong className="font-semibold">added up</strong> over the window. So more games can
        outrank a better player with fewer. Open a row to see every game.
      </span>
    ) : (
      <span>
        Each row shows his usual minutes and where tonight projects. The score on the right is that
        gap, weighted by how much it matters tonight.
      </span>
    )}
  </p>
);
