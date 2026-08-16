/**
 * Inline silhouette used whenever a player image is missing or fails to load.
 * A data URI so the fallback never costs a request and can't itself 404.
 */
export const PLAYER_IMAGE_FALLBACK =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%23252836'/%3E%3Ccircle cx='20' cy='15' r='7' fill='%234b5563'/%3E%3Cellipse cx='20' cy='35' rx='12' ry='8' fill='%234b5563'/%3E%3C/svg%3E";
