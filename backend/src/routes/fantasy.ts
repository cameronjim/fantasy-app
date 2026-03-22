import { Router, Request, Response } from 'express';
import { query } from '../db.js';

const router = Router();

// GET /roster — get my roster with player stats
router.get('/roster', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT mr.id, mr.player_id, mr.added_at,
              p.id, p.nba_id, p.name, p.team, p.position,
              p.ppg, p.rpg, p.apg, p.spg, p.bpg,
              p.fg_pct, p.three_pct, p.ft_pct, p.three_pm, p.tov, p.mpg, p.gp,
              p.injury_status, p.injury_detail, p.headshot_url
       FROM my_roster mr
       JOIN players p ON mr.player_id = p.id
       ORDER BY p.ppg DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching roster:', error);
    res.status(500).json({ error: 'Failed to fetch roster' });
  }
});

// POST /roster — add player to my roster
router.post('/roster', async (req: Request, res: Response) => {
  try {
    const { player_id } = req.body;
    if (!player_id) {
      res.status(400).json({ error: 'player_id is required' });
      return;
    }
    const result = await query(
      `INSERT INTO my_roster (player_id) VALUES ($1)
       RETURNING id, player_id, added_at`,
      [player_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === '23505') {
      res.status(409).json({ error: 'Player is already on your roster' });
      return;
    }
    console.error('Error adding to roster:', error);
    res.status(500).json({ error: 'Failed to add player' });
  }
});

// DELETE /roster/:playerId — remove player from my roster
router.delete('/roster/:playerId', async (req: Request, res: Response) => {
  try {
    const { playerId } = req.params;
    const result = await query(
      `DELETE FROM my_roster WHERE player_id = $1 RETURNING id`,
      [playerId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Player not on roster' });
      return;
    }
    res.json({ message: 'Player removed' });
  } catch (error) {
    console.error('Error removing from roster:', error);
    res.status(500).json({ error: 'Failed to remove player' });
  }
});

export default router;
