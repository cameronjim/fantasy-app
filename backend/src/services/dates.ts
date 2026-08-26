
// NBA game days are anchored to eastern time, not the lambda's UTC clock or the db's UTC CURRENT_DATE
export function etIsoDate(offsetDays: number): string {
  const instant = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return instant.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
