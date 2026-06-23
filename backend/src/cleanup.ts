import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function cleanup(): Promise<void> {
  await pool.query('SELECT COUNT(*) as total, COUNT(nba_id) as with_nba_id FROM players');

  await pool.query('SELECT COUNT(*) as total, COUNT(nba_id) as with_nba_id FROM teams');

  await pool.query("SELECT name, COUNT(*) as cnt FROM players GROUP BY name HAVING COUNT(*) > 1 LIMIT 10");

  await pool.query('DELETE FROM fantasy_roster WHERE player_id IN (SELECT id FROM players WHERE nba_id IS NULL)');

  await pool.query('DELETE FROM players WHERE nba_id IS NULL');

  await pool.query('DELETE FROM teams WHERE nba_id IS NULL');

  await pool.query('DELETE FROM games WHERE nba_game_id IS NULL');

  await pool.query('SELECT COUNT(*) as total FROM players');
  await pool.query('SELECT COUNT(*) as total FROM teams');
  await pool.query('SELECT COUNT(*) as total FROM games');

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
        }
      }
    }
  }

  await pool.end();
}

cleanup();
