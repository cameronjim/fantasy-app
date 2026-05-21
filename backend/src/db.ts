import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../.env') });

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

export async function query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  const result = await pool.query(text, params);
  return result;
}

export { pool };
