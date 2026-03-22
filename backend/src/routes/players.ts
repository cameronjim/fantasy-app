import { Router, Request, Response } from 'express';
import { query } from '../db.js';

const router = Router();

// GET / — list players with optional filters: search, team, position
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, team, position } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`name ILIKE $${paramIndex}`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (team) {
      conditions.push(`team = $${paramIndex}`);
      params.push(team);
      paramIndex++;
    }

    if (position) {
      conditions.push(`position = $${paramIndex}`);
      params.push(position);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT id, nba_id, name, team, position, ppg, rpg, apg, spg, bpg,
              fg_pct, three_pct, ft_pct, tov, mpg, gp,
              injury_status, injury_detail, headshot_url, updated_at
       FROM players ${whereClause}
       ORDER BY ppg DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching players:', error);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// GET /:id — single player by id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, nba_id, name, team, position, ppg, rpg, apg, spg, bpg,
              fg_pct, three_pct, ft_pct, tov, mpg, gp,
              injury_status, injury_detail, headshot_url, updated_at
       FROM players
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching player:', error);
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});

export default router;
