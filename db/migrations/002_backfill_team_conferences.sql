-- Backfill conference + division for all 30 NBA teams.
-- Run on Neon SQL editor.
-- These don't change in practice — last realignment was 2004.

UPDATE teams SET conference = 'East', division = 'Atlantic'   WHERE abbreviation = 'BOS';
UPDATE teams SET conference = 'East', division = 'Atlantic'   WHERE abbreviation = 'BKN';
UPDATE teams SET conference = 'East', division = 'Atlantic'   WHERE abbreviation = 'NYK';
UPDATE teams SET conference = 'East', division = 'Atlantic'   WHERE abbreviation = 'PHI';
UPDATE teams SET conference = 'East', division = 'Atlantic'   WHERE abbreviation = 'TOR';

UPDATE teams SET conference = 'East', division = 'Central'    WHERE abbreviation = 'CHI';
UPDATE teams SET conference = 'East', division = 'Central'    WHERE abbreviation = 'CLE';
UPDATE teams SET conference = 'East', division = 'Central'    WHERE abbreviation = 'DET';
UPDATE teams SET conference = 'East', division = 'Central'    WHERE abbreviation = 'IND';
UPDATE teams SET conference = 'East', division = 'Central'    WHERE abbreviation = 'MIL';

UPDATE teams SET conference = 'East', division = 'Southeast'  WHERE abbreviation = 'ATL';
UPDATE teams SET conference = 'East', division = 'Southeast'  WHERE abbreviation = 'CHA';
UPDATE teams SET conference = 'East', division = 'Southeast'  WHERE abbreviation = 'MIA';
UPDATE teams SET conference = 'East', division = 'Southeast'  WHERE abbreviation = 'ORL';
UPDATE teams SET conference = 'East', division = 'Southeast'  WHERE abbreviation = 'WAS';

UPDATE teams SET conference = 'West', division = 'Northwest'  WHERE abbreviation = 'DEN';
UPDATE teams SET conference = 'West', division = 'Northwest'  WHERE abbreviation = 'MIN';
UPDATE teams SET conference = 'West', division = 'Northwest'  WHERE abbreviation = 'OKC';
UPDATE teams SET conference = 'West', division = 'Northwest'  WHERE abbreviation = 'POR';
UPDATE teams SET conference = 'West', division = 'Northwest'  WHERE abbreviation = 'UTA';

UPDATE teams SET conference = 'West', division = 'Pacific'    WHERE abbreviation = 'GSW';
UPDATE teams SET conference = 'West', division = 'Pacific'    WHERE abbreviation = 'LAC';
UPDATE teams SET conference = 'West', division = 'Pacific'    WHERE abbreviation = 'LAL';
UPDATE teams SET conference = 'West', division = 'Pacific'    WHERE abbreviation = 'PHX';
UPDATE teams SET conference = 'West', division = 'Pacific'    WHERE abbreviation = 'SAC';

UPDATE teams SET conference = 'West', division = 'Southwest'  WHERE abbreviation = 'DAL';
UPDATE teams SET conference = 'West', division = 'Southwest'  WHERE abbreviation = 'HOU';
UPDATE teams SET conference = 'West', division = 'Southwest'  WHERE abbreviation = 'MEM';
UPDATE teams SET conference = 'West', division = 'Southwest'  WHERE abbreviation = 'NOP';
UPDATE teams SET conference = 'West', division = 'Southwest'  WHERE abbreviation = 'SAS';
