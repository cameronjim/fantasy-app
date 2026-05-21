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
import { requireAuth } from './middleware/auth.js';

const app = express();

const ALLOWED_ORIGINS = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : ['http://localhost:5173'];

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/players', playersRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/games', gamesRouter);
app.use('/api/fantasy', requireAuth, fantasyRouter);
app.use('/api/ai', requireAuth, aiRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export { app };
