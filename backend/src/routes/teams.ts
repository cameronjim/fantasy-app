import { Router, Request, Response } from 'express';
import { query } from '../db.js';

const router = Router();

// GET / — all teams with stats
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT id, nba_id, name, abbreviation, conference, division,
              wins, losses, ppg, rpg, apg, spg, bpg,
              fg_pct, three_pct, ft_pct, tov,
              def_rating, off_rating, net_rating,
              logo_url, updated_at
       FROM teams
       ORDER BY wins DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// GET /:id — single team by id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, nba_id, name, abbreviation, conference, division,
              wins, losses, ppg, rpg, apg, spg, bpg,
              fg_pct, three_pct, ft_pct, tov,
              def_rating, off_rating, net_rating,
              logo_url, updated_at
       FROM teams
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

export default router;
