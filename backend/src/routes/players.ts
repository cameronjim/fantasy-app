import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { getScoresById } from '../services/fantasyScore.js';

const router = Router();

router.get('/', async (req: Request, res: Response): Promise<void> => {
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
      conditions.push(`$${paramIndex} = ANY(string_to_array(position, ','))`);
      params.push(position);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [dbResult, scores] = await Promise.all([
      query(
        `SELECT id, nba_id, name, team, position,
                points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game,
                field_goal_percentage, three_point_percentage, free_throw_percentage, three_pointers_made,
                turnovers_per_game, minutes_per_game, games_played,
                injury_status, injury_detail, headshot_url, updated_at
         FROM players ${whereClause}
         ORDER BY points_per_game DESC`,
        params
      ),
      getScoresById(),
    ]);

    const enriched = dbResult.rows.map((p) => {
      const s = scores.get(p.id);
      return {
        ...p,
        fantasy_score: s?.fantasy_score ?? null,
        fantasy_rank: s?.fantasy_rank ?? null,
      };
    });

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, nba_id, name, team, position,
              points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game,
              field_goal_percentage, three_point_percentage, free_throw_percentage, three_pointers_made,
              turnovers_per_game, minutes_per_game, games_played,
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
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});

export { router as playersRouter };
