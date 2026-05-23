// NBA team IDs are stable and let us build CDN URLs for logos without
// needing the backend to ship logo_url for every player record.

const TEAM_IDS: Record<string, string> = {
  ATL: '1610612737', BOS: '1610612738', BKN: '1610612751', CHA: '1610612766',
  CHI: '1610612741', CLE: '1610612739', DAL: '1610612742', DEN: '1610612743',
  DET: '1610612765', GSW: '1610612744', HOU: '1610612745', IND: '1610612754',
  LAC: '1610612746', LAL: '1610612747', MEM: '1610612763', MIA: '1610612748',
  MIL: '1610612749', MIN: '1610612750', NOP: '1610612740', NYK: '1610612752',
  OKC: '1610612760', ORL: '1610612753', PHI: '1610612755', PHX: '1610612756',
  POR: '1610612757', SAC: '1610612758', SAS: '1610612759', TOR: '1610612761',
  UTA: '1610612762', WAS: '1610612764',
};

// Some scrapers return full names — map those back to abbreviations.
const NAME_TO_ABBR: Record<string, string> = {
  'atlanta hawks': 'ATL', 'boston celtics': 'BOS', 'brooklyn nets': 'BKN',
  'charlotte hornets': 'CHA', 'chicago bulls': 'CHI', 'cleveland cavaliers': 'CLE',
  'dallas mavericks': 'DAL', 'denver nuggets': 'DEN', 'detroit pistons': 'DET',
  'golden state warriors': 'GSW', 'houston rockets': 'HOU', 'indiana pacers': 'IND',
  'la clippers': 'LAC', 'los angeles clippers': 'LAC', 'los angeles lakers': 'LAL',
  'memphis grizzlies': 'MEM', 'miami heat': 'MIA', 'milwaukee bucks': 'MIL',
  'minnesota timberwolves': 'MIN', 'new orleans pelicans': 'NOP', 'new york knicks': 'NYK',
  'oklahoma city thunder': 'OKC', 'orlando magic': 'ORL', 'philadelphia 76ers': 'PHI',
  'phoenix suns': 'PHX', 'portland trail blazers': 'POR', 'sacramento kings': 'SAC',
  'san antonio spurs': 'SAS', 'toronto raptors': 'TOR', 'utah jazz': 'UTA',
  'washington wizards': 'WAS',
};

/** Returns the NBA CDN logo URL for a team abbreviation or full name, or null if unknown. */
export function getTeamLogoUrl(teamId: string | null | undefined): string | null {
  if (!teamId) return null;
  const key = teamId.trim();
  // Already an abbreviation?
  const abbr = TEAM_IDS[key.toUpperCase()] ? key.toUpperCase() : NAME_TO_ABBR[key.toLowerCase()];
  if (!abbr) return null;
  const id = TEAM_IDS[abbr];
  return id ? `https://cdn.nba.com/logos/nba/${id}/primary/L/logo.svg` : null;
}
