import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../.env') });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { playersRouter } from './routes/players.js';
import { teamsRouter } from './routes/teams.js';
import { gamesRouter } from './routes/games.js';
import { historyRouter } from './routes/history.js';
import { analyticsRouter, playerAnalyticsRouter } from './routes/analytics.js';
import { predictionsRouter, watchlistRouter, playerPredictionsRouter } from './routes/predictions.js';
import { ratings2kRouter } from './routes/ratings2k.js';
import { fantasyRouter } from './routes/fantasy.js';
import { aiRouter } from './routes/ai.js';
import { authRouter } from './routes/auth.js';
import { preferencesRouter } from './routes/preferences.js';
import { bettingRouter } from './routes/betting.js';
import { statusRouter } from './routes/status.js';
import { trackRouter } from './routes/track.js';
import { adminRouter } from './routes/admin.js';
import { requireAuth, type AuthRequest } from './middleware/auth.js';
import { requireAdmin } from './middleware/admin.js';
import { rateLimit } from './middleware/rateLimit.js';
import { validateAuthSecret } from './config.js';

validateAuthSecret(process.env.AUTH_SECRET);

const app = express();
app.set('trust proxy', true);

const ALLOWED_ORIGINS = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:5174'];

app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '100kb' }));

// this cap is the only bound on Anthropic spend, so a counter outage must not silently uncap it
const aiDailyLimit = rateLimit({
  scope: 'ai',
  limit: 200,
  windowSeconds: 86_400,
  keyFor: (req) => String((req as AuthRequest).userId),
  failClosed: true,
});

app.use('/api/auth', authRouter);
app.use('/api/players', playersRouter);
app.use('/api/players', playerAnalyticsRouter);
app.use('/api/players', playerPredictionsRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/games', gamesRouter);
app.use('/api/history', historyRouter);
app.use('/api/ratings2k', ratings2kRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/predictions', predictionsRouter);
app.use('/api/watchlist', watchlistRouter);
app.use('/api/fantasy', requireAuth, fantasyRouter);
app.use('/api/ai', requireAuth, aiDailyLimit, aiRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/api/betting', bettingRouter);
app.use('/api/status', statusRouter);
app.use('/api/track', trackRouter);
app.use('/api/admin', requireAuth, requireAdmin, adminRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export { app };
