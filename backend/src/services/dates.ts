/**
 * Shared ET date helper. NBA game days are anchored to Eastern Time (ESPN
 * stores them as UTC midnight of the ET date), so any date window must be
 * computed in ET, not in the Lambda's UTC clock or the db's UTC CURRENT_DATE.
 */

/**
 * The ET calendar date `offsetDays` from now, as YYYY-MM-DD. en-CA formats as
 * YYYY-MM-DD, which is both the db game_date format and one strip away from
 * ESPN's YYYYMMDD.
 */
export function etIsoDate(offsetDays: number): string {
  const instant = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return instant.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
