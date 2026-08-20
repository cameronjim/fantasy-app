-- Backfill teams.abbreviation/conference/division: the scraper used to read
-- an endpoint field that comes back empty and wrote blanks for all three.
-- Keyed on nba_id, not name, since team ids never change. Idempotent; run
-- against both prod and dev.

UPDATE teams SET
  abbreviation = m.abbr,
  conference   = m.conf,
  division     = m.div
FROM (VALUES
  ('1610612737', 'ATL', 'East', 'Southeast'),
  ('1610612738', 'BOS', 'East', 'Atlantic'),
  ('1610612751', 'BKN', 'East', 'Atlantic'),
  ('1610612766', 'CHA', 'East', 'Southeast'),
  ('1610612741', 'CHI', 'East', 'Central'),
  ('1610612739', 'CLE', 'East', 'Central'),
  ('1610612742', 'DAL', 'West', 'Southwest'),
  ('1610612743', 'DEN', 'West', 'Northwest'),
  ('1610612765', 'DET', 'East', 'Central'),
  ('1610612744', 'GSW', 'West', 'Pacific'),
  ('1610612745', 'HOU', 'West', 'Southwest'),
  ('1610612754', 'IND', 'East', 'Central'),
  ('1610612746', 'LAC', 'West', 'Pacific'),
  ('1610612747', 'LAL', 'West', 'Pacific'),
  ('1610612763', 'MEM', 'West', 'Southwest'),
  ('1610612748', 'MIA', 'East', 'Southeast'),
  ('1610612749', 'MIL', 'East', 'Central'),
  ('1610612750', 'MIN', 'West', 'Northwest'),
  ('1610612740', 'NOP', 'West', 'Southwest'),
  ('1610612752', 'NYK', 'East', 'Atlantic'),
  ('1610612760', 'OKC', 'West', 'Northwest'),
  ('1610612753', 'ORL', 'East', 'Southeast'),
  ('1610612755', 'PHI', 'East', 'Atlantic'),
  ('1610612756', 'PHX', 'West', 'Pacific'),
  ('1610612757', 'POR', 'West', 'Northwest'),
  ('1610612758', 'SAC', 'West', 'Pacific'),
  ('1610612759', 'SAS', 'West', 'Southwest'),
  ('1610612761', 'TOR', 'East', 'Atlantic'),
  ('1610612762', 'UTA', 'West', 'Northwest'),
  ('1610612764', 'WAS', 'East', 'Southeast')
) AS m(nba_id, abbr, conf, div)
WHERE teams.nba_id = m.nba_id;

-- Verify: expect 30 rows, 15 East / 15 West, no blanks.
SELECT conference, COUNT(*) AS teams
FROM teams
GROUP BY conference
ORDER BY conference;
