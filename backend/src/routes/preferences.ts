import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getUserPreferences, setUserPreferences } from '../services/preferences.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    const prefs = await getUserPreferences(userId);
    res.json(prefs);
  } catch {
    res.status(500).json({ error: 'Failed to load preferences' });
  }
});

router.patch('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    await setUserPreferences(userId, req.body ?? {});
    const updated = await getUserPreferences(userId);
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

export { router as preferencesRouter };
