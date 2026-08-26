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
