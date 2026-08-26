import type { NumericLike } from './core';

// the same person can appear under more than one roster, so `slug` identifies a row, not name.
export type Rating2kTeamType = 'curr' | 'class' | 'allt';

export interface Rating2kSummary {
  slug: string;
  name: string;
  team: string | null;
  team_type: Rating2kTeamType;
  overall: NumericLike | null;
  // the source sends either a list or a single joined string ("PG / SG").
  positions: string[] | string | null;
  game_version: string | null;
  player_image: string | null;
}

export interface Rating2kPlayer extends Rating2kSummary {
  archetype: string | null;
  build: string | null;
  height: string | null;
  weight: string | null;
  wingspan: string | null;
}

export interface Rating2kAttribute {
  attribute_name: string;
  value: NumericLike | null;
}

export interface Rating2kBadge {
  badge_name: string;
  tier?: string | null;
}

export interface Rating2kRatingHistoryEntry {
  game_version: string;
  overall: NumericLike | null;
  delta: NumericLike | null;
}

export interface Rating2kDetail {
  player: Rating2kPlayer;
  attributes: Rating2kAttribute[];
  badges: Rating2kBadge[];
  rating_history: Rating2kRatingHistoryEntry[];
}
