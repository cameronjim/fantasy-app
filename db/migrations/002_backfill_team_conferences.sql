-- Backfill abbreviation + conference + division for all 30 NBA teams.
-- Run on Neon SQL editor.
-- The team scraper hits stats.nba.com which is blocked from GitHub Actions IPs,
-- so abbreviations/conferences never got populated. Hardcoding the static parts.

UPDATE teams SET abbreviation = 'BOS', conference = 'East', division = 'Atlantic'  WHERE name = 'Boston Celtics';
UPDATE teams SET abbreviation = 'BKN', conference = 'East', division = 'Atlantic'  WHERE name = 'Brooklyn Nets';
UPDATE teams SET abbreviation = 'NYK', conference = 'East', division = 'Atlantic'  WHERE name = 'New York Knicks';
UPDATE teams SET abbreviation = 'PHI', conference = 'East', division = 'Atlantic'  WHERE name = 'Philadelphia 76ers';
UPDATE teams SET abbreviation = 'TOR', conference = 'East', division = 'Atlantic'  WHERE name = 'Toronto Raptors';

UPDATE teams SET abbreviation = 'CHI', conference = 'East', division = 'Central'   WHERE name = 'Chicago Bulls';
UPDATE teams SET abbreviation = 'CLE', conference = 'East', division = 'Central'   WHERE name = 'Cleveland Cavaliers';
UPDATE teams SET abbreviation = 'DET', conference = 'East', division = 'Central'   WHERE name = 'Detroit Pistons';
UPDATE teams SET abbreviation = 'IND', conference = 'East', division = 'Central'   WHERE name = 'Indiana Pacers';
UPDATE teams SET abbreviation = 'MIL', conference = 'East', division = 'Central'   WHERE name = 'Milwaukee Bucks';

UPDATE teams SET abbreviation = 'ATL', conference = 'East', division = 'Southeast' WHERE name = 'Atlanta Hawks';
UPDATE teams SET abbreviation = 'CHA', conference = 'East', division = 'Southeast' WHERE name = 'Charlotte Hornets';
UPDATE teams SET abbreviation = 'MIA', conference = 'East', division = 'Southeast' WHERE name = 'Miami Heat';
UPDATE teams SET abbreviation = 'ORL', conference = 'East', division = 'Southeast' WHERE name = 'Orlando Magic';
UPDATE teams SET abbreviation = 'WAS', conference = 'East', division = 'Southeast' WHERE name = 'Washington Wizards';

UPDATE teams SET abbreviation = 'DEN', conference = 'West', division = 'Northwest' WHERE name = 'Denver Nuggets';
UPDATE teams SET abbreviation = 'MIN', conference = 'West', division = 'Northwest' WHERE name = 'Minnesota Timberwolves';
UPDATE teams SET abbreviation = 'OKC', conference = 'West', division = 'Northwest' WHERE name = 'Oklahoma City Thunder';
UPDATE teams SET abbreviation = 'POR', conference = 'West', division = 'Northwest' WHERE name = 'Portland Trail Blazers';
UPDATE teams SET abbreviation = 'UTA', conference = 'West', division = 'Northwest' WHERE name = 'Utah Jazz';

UPDATE teams SET abbreviation = 'GSW', conference = 'West', division = 'Pacific'   WHERE name = 'Golden State Warriors';
UPDATE teams SET abbreviation = 'LAC', conference = 'West', division = 'Pacific'   WHERE name IN ('Los Angeles Clippers', 'LA Clippers');
UPDATE teams SET abbreviation = 'LAL', conference = 'West', division = 'Pacific'   WHERE name = 'Los Angeles Lakers';
UPDATE teams SET abbreviation = 'PHX', conference = 'West', division = 'Pacific'   WHERE name = 'Phoenix Suns';
UPDATE teams SET abbreviation = 'SAC', conference = 'West', division = 'Pacific'   WHERE name = 'Sacramento Kings';

UPDATE teams SET abbreviation = 'DAL', conference = 'West', division = 'Southwest' WHERE name = 'Dallas Mavericks';
UPDATE teams SET abbreviation = 'HOU', conference = 'West', division = 'Southwest' WHERE name = 'Houston Rockets';
UPDATE teams SET abbreviation = 'MEM', conference = 'West', division = 'Southwest' WHERE name = 'Memphis Grizzlies';
UPDATE teams SET abbreviation = 'NOP', conference = 'West', division = 'Southwest' WHERE name = 'New Orleans Pelicans';
UPDATE teams SET abbreviation = 'SAS', conference = 'West', division = 'Southwest' WHERE name = 'San Antonio Spurs';
