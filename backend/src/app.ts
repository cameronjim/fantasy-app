import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../.env') });

import express from 'express';
import cors from 'cors';
import { playersRouter } from './routes/players.js';
import { teamsRouter } from './routes/teams.js';
import { gamesRouter } from './routes/games.js';
import { fantasyRouter } from './routes/fantasy.js';
import { aiRouter } from './routes/ai.js';
import { authRouter } from './routes/auth.js';
import { preferencesRouter } from './routes/preferences.js';
import { bettingRouter } from './routes/betting.js';
import { statusRouter } from './routes/status.js';
import { requireAuth } from './middleware/auth.js';

const app = express();

const ALLOWED_ORIGINS = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:5174'];

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/players', playersRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/games', gamesRouter);
app.use('/api/fantasy', requireAuth, fantasyRouter);
app.use('/api/ai', requireAuth, aiRouter);
app.use('/api/preferences', preferencesRouter);
// per-endpoint auth: the odds board is public, picks/bets require a token.
app.use('/api/betting', bettingRouter);
app.use('/api/status', statusRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export { app };
