import { Router, Request, Response } from 'express';
import { query } from '../db.js';

const router = Router();

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT id, nba_id, name, abbreviation, conference, division,
              wins, losses,
              points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game,
              field_goal_percentage, three_point_percentage, free_throw_percentage, turnovers_per_game,
              defensive_rating, offensive_rating, net_rating,
              logo_url, updated_at
       FROM teams
       ORDER BY wins DESC`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, nba_id, name, abbreviation, conference, division,
              wins, losses,
              points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game,
              field_goal_percentage, three_point_percentage, free_throw_percentage, turnovers_per_game,
              defensive_rating, offensive_rating, net_rating,
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
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

export { router as teamsRouter };
