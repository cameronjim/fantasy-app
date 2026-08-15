import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { formatStat, toStatNumber, STAT_PLACEHOLDER } from '../../utils/stats';
import type { SlatePlayer } from '../../types';

function availabilityClass(probability: number): string {
  if (probability >= 0.85) return 'badge-success';
  if (probability >= 0.6) return 'badge-warning';
  return 'badge-error';
}

export const AvailabilityBadge = ({
  value,
}: {
  value: SlatePlayer['prob_active'];
}): JSX.Element => {
  const probability = toStatNumber(value);
  if (probability === null) {
    return (
      <span className="badge badge-ghost badge-sm tabular-nums" title="Availability not modelled">
        {STAT_PLACEHOLDER}
      </span>
    );
  }
  return (
    <span
      className={`badge badge-sm tabular-nums ${availabilityClass(probability)}`}
      title="Modelled chance this player appears"
    >
      {Math.round(probability * 100)}%
    </span>
  );
};

export const ImpactBadge = ({ player }: { player: SlatePlayer }): JSX.Element => {
  const impact = toStatNumber(player.impact);
  if (impact === null) {
    return (
      <span
        className="badge badge-ghost badge-sm tabular-nums"
        title="No impact score for this player"
      >
        {STAT_PLACEHOLDER}
      </span>
    );
  }
  const tone = player.slate_spotlight
    ? 'badge-primary'
    : player.spotlight
      ? 'badge-primary badge-outline'
      : 'badge-ghost';
  return (
    <span
      className={`badge badge-sm tabular-nums font-semibold ${tone}`}
      title="Projected impact tonight. 0 is an average night."
    >
      {impact > 0 ? '+' : ''}
      {impact.toFixed(1)}
    </span>
  );
};

const CATEGORY_LABELS: ReadonlyArray<[keyof SlatePlayer['projected'], string]> = [
  ['reb', 'REB'],
  ['ast', 'AST'],
  ['stl', 'STL'],
  ['blk', 'BLK'],
  ['fg3m', '3PM'],
  ['tov', 'TOV'],
];

export const CategoryLine = ({ player }: { player: SlatePlayer }): JSX.Element | null => {
  const parts = CATEGORY_LABELS.filter(
    ([key]) => toStatNumber(player.projected?.[key]) !== null
  ).map(([key, label]) => `${formatStat(player.projected[key])} ${label}`);
  if (parts.length === 0) return null;
  return (
    <span className="text-[11px] opacity-50 tabular-nums">{parts.join(' · ')}</span>
  );
};

// minutes only: `min_vs_usual` compares two per-appearance numbers so it is about his
// ROLE, while `pts_vs_usual` also carries availability and would read as lost points
// for a game-time decision. the threshold comes from the server so this page can never
// disagree with the Watchlist's own role-increase bar.
export const VsUsualChip = ({
  player,
  threshold,
}: {
  player: SlatePlayer;
  threshold: number;
}): JSX.Element | null => {
  const delta = toStatNumber(player.min_vs_usual);
  const usual = toStatNumber(player.usual_min);
  if (delta === null || usual === null || threshold <= 0) return null;
  if (Math.abs(delta) < threshold) return null;

  const up = delta > 0;
  const ptsDelta = toStatNumber(player.pts_vs_usual);
  const ptsPart =
    ptsDelta === null
      ? ''
      : ` Points ${ptsDelta > 0 ? '+' : ''}${ptsDelta.toFixed(1)} vs usual.`;

  return (
    <span
      className={
        'badge badge-xs tabular-nums gap-0.5 ' +
        (up ? 'badge-success badge-outline' : 'badge-warning badge-outline')
      }
      title={`Usually ${usual.toFixed(1)} min, tonight ${formatStat(player.proj_min_p50)}.${ptsPart}`}
    >
      {up ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
      {up ? '+' : ''}
      {delta.toFixed(1)} min vs usual
    </span>
  );
};
