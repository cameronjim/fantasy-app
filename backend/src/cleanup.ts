import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function cleanup() {
  // Check current state
  const p = await pool.query('SELECT COUNT(*) as total, COUNT(nba_id) as with_nba_id FROM players');
  console.log('Players:', p.rows[0]);

  const t = await pool.query('SELECT COUNT(*) as total, COUNT(nba_id) as with_nba_id FROM teams');
  console.log('Teams:', t.rows[0]);

  // Show duplicates
  const dupes = await pool.query("SELECT name, COUNT(*) as cnt FROM players GROUP BY name HAVING COUNT(*) > 1 LIMIT 10");
  console.log('Duplicate players:', dupes.rows);

  // Delete fantasy roster entries pointing to seed players (no nba_id)
  const delRoster = await pool.query('DELETE FROM fantasy_roster WHERE player_id IN (SELECT id FROM players WHERE nba_id IS NULL)');
  console.log('Deleted roster entries:', delRoster.rowCount);

  // Delete seed players (no nba_id)
  const delPlayers = await pool.query('DELETE FROM players WHERE nba_id IS NULL');
  console.log('Deleted seed players:', delPlayers.rowCount);

  // Delete seed teams (no nba_id)
  const delTeams = await pool.query('DELETE FROM teams WHERE nba_id IS NULL');
  console.log('Deleted seed teams:', delTeams.rowCount);

  // Delete seed games (no nba_game_id)
  const delGames = await pool.query('DELETE FROM games WHERE nba_game_id IS NULL');
  console.log('Deleted seed games:', delGames.rowCount);

  // Final count
  const p2 = await pool.query('SELECT COUNT(*) as total FROM players');
  const t2 = await pool.query('SELECT COUNT(*) as total FROM teams');
  const g2 = await pool.query('SELECT COUNT(*) as total FROM games');
  console.log('Remaining - Players:', p2.rows[0].total, 'Teams:', t2.rows[0].total, 'Games:', g2.rows[0].total);

  // Re-link fantasy roster to scraped players by name
  const roster = await pool.query(`
    SELECT fr.id, fr.player_id, p_old.name as player_name
    FROM fantasy_roster fr
    JOIN players p_old ON fr.player_id = p_old.id
  `);
  // If roster is empty (deleted above), try to recreate demo roster with scraped player IDs
  const league = await pool.query("SELECT id FROM fantasy_leagues LIMIT 1");
  if (league.rows.length > 0) {
    const team = await pool.query("SELECT id FROM fantasy_teams WHERE league_id = $1 LIMIT 1", [league.rows[0].id]);
    if (team.rows.length > 0) {
      const teamId = team.rows[0].id;
      const starPlayers = ['Luka Doncic', 'Jayson Tatum', 'Nikola Jokic', 'Anthony Edwards', 'Jaylen Brown'];
      for (const name of starPlayers) {
        const found = await pool.query("SELECT id FROM players WHERE name = $1 LIMIT 1", [name]);
        if (found.rows.length > 0) {
          await pool.query(
            "INSERT INTO fantasy_roster (fantasy_team_id, player_id, slot) VALUES ($1, $2, 'STARTER') ON CONFLICT DO NOTHING",
            [teamId, found.rows[0].id]
          );
          console.log('Added', name, 'to demo roster');
        }
      }
    }
  }

  await pool.end();
  console.log('Done!');
}

cleanup();
