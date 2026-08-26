import { RATINGS_2K_ATTRIBUTION } from '../../utils/ratings2k';

// required wherever 2K data is shown.
export const Ratings2kAttribution = (): JSX.Element => (
  <p className="text-[11px] leading-snug opacity-40">{RATINGS_2K_ATTRIBUTION}</p>
);
