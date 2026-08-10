/**
 * The segmented filter control shared by the Stats page (position, conference)
 * and the Watchlist (time window, position) — a daisyUI `join` of
 * `btn btn-sm join-item` buttons, with the active option filled solid via
 * `btn-primary` and every other option left as a plain flat button.
 *
 * StatsPage.tsx's position row is the source of truth for this look: pulling
 * it out here means the two pages read the same classes from one place and
 * cannot drift apart again the way Watchlist's old pill-badge chips did.
 */
export interface SegmentedOption<T> {
  value: T;
  label: string;
}

export function SegmentedFilter<T>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}): JSX.Element {
  return (
    <div className="join" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={'btn btn-sm join-item ' + (option.value === value ? 'btn-primary' : '')}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
