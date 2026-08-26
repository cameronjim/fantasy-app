import { SegmentedFilter, type SegmentedOption } from '../SegmentedFilter';
import type { WatchlistPositionFilter } from '../../types';

// `games` is the phrase a row uses for its game count, so "4 games this week" reads as English.
export const WINDOW_OPTIONS: Array<{ days: number; label: string; games: string }> = [
  { days: 1, label: 'Tonight', games: 'tonight' },
  { days: 3, label: '3 days', games: 'in 3 days' },
  { days: 7, label: 'Week', games: 'this week' },
  { days: 14, label: '2 weeks', games: 'in 2 weeks' },
];

export const DEFAULT_WINDOW_DAYS = 1;

export function windowOption(days: number): { days: number; label: string; games: string } {
  return WINDOW_OPTIONS.find((option) => option.days === days) ?? WINDOW_OPTIONS[0];
}

// the same six segments, in the same order, as the Stats page's position control.
export const POSITION_PRIMARY: WatchlistPositionFilter[] = ['PG', 'SG', 'SF', 'PF', 'C'];

// roster-slot buckets with no Stats-page equivalent, kept as a second smaller row.
export const POSITION_SECONDARY: WatchlistPositionFilter[] = ['G', 'F'];

// prose labels, used in sentences ("Showing centers only") rather than on chips.
export const POSITION_LABELS: Record<WatchlistPositionFilter, string> = {
  G: 'Guards',
  F: 'Forwards',
  C: 'Centers',
  PG: 'PG',
  SG: 'SG',
  SF: 'SF',
  PF: 'PF',
};

export const WindowPicker = ({
  days,
  onChange,
}: {
  days: number;
  onChange: (days: number) => void;
}): JSX.Element => (
  <SegmentedFilter
    options={WINDOW_OPTIONS.map((option) => ({ value: option.days, label: option.label }))}
    value={days}
    onChange={onChange}
    ariaLabel="Time window"
  />
);

export const PositionPicker = ({
  value,
  options,
  onChange,
}: {
  value: WatchlistPositionFilter | null;
  options: WatchlistPositionFilter[];
  onChange: (value: WatchlistPositionFilter | null) => void;
}): JSX.Element => {
  // only offer what the server said it honours, so a chip can never produce a 400
  const primary = POSITION_PRIMARY.filter((pos) => options.includes(pos));
  const secondary = POSITION_SECONDARY.filter((pos) => options.includes(pos));

  const primaryOptions: SegmentedOption<WatchlistPositionFilter | null>[] = [
    { value: null, label: 'All' },
    ...primary.map((pos) => ({ value: pos, label: pos })),
  ];
  const secondaryOptions: SegmentedOption<WatchlistPositionFilter | null>[] = secondary.map((pos) => ({
    value: pos,
    label: POSITION_LABELS[pos],
  }));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="position-filter">
      <span className="sr-only">Position filter</span>
      <SegmentedFilter options={primaryOptions} value={value} onChange={onChange} ariaLabel="Position" />
      {secondaryOptions.length > 0 && (
        <SegmentedFilter
          options={secondaryOptions}
          value={value}
          onChange={onChange}
          ariaLabel="Roster slot"
        />
      )}
    </div>
  );
};
