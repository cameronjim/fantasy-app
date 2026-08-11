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

// fail closed on a missing/weak signing key rather than issuing forgeable tokens.
validateAuthSecret(process.env.AUTH_SECRET);

const app = express();
// API Gateway / CloudFront set x-forwarded-for; trust it so req.ip is the real
// client (the rate limiter keys per-IP routes on it).
app.set('trust proxy', true);

const ALLOWED_ORIGINS = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:5174'];

app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '100kb' }));

// per-user daily ceiling on Claude-backed endpoints, keyed by the authenticated
// userId. bounds API spend if an account is scripted. cached responses count
// too, but 200/day is far above normal browsing.
const aiDailyLimit = rateLimit({
  scope: 'ai',
  limit: 200,
  windowSeconds: 86_400,
  keyFor: (req) => String((req as AuthRequest).userId),
  // this cap is the only bound on Anthropic spend, so a counter outage must
  // not silently uncap it.
  failClosed: true,
});

app.use('/api/auth', authRouter);
app.use('/api/players', playersRouter);
// /api/players/:id/analytics — percentiles and trends for one player, public
// like the player row it hangs off.
app.use('/api/players', playerAnalyticsRouter);
// /api/players/:id/predictions — every game the latest model run has for one
// player. Public for the same reason the analytics are.
app.use('/api/players', playerPredictionsRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/games', gamesRouter);
// season-by-season history — public, same as /api/players.
app.use('/api/history', historyRouter);
// NBA 2K ratings — public, third-party data, no user data involved.
app.use('/api/ratings2k', ratings2kRouter);
// league-wide stat distributions — public, same as /api/players.
app.use('/api/analytics', analyticsRouter);
// model-backed daily slate — public, league data with no user scope.
app.use('/api/predictions', predictionsRouter);
// deterministic waiver-discovery list — public, same rationale.
app.use('/api/watchlist', watchlistRouter);
app.use('/api/fantasy', requireAuth, fantasyRouter);
app.use('/api/ai', requireAuth, aiDailyLimit, aiRouter);
app.use('/api/preferences', preferencesRouter);
// per-endpoint auth: the odds board is public, picks/bets require a token.
app.use('/api/betting', bettingRouter);
app.use('/api/status', statusRouter);
// pageview beacon — public on purpose so anonymous visitors are counted.
app.use('/api/track', trackRouter);
// developer tools — admin-only, authorization re-checked in the db per request.
app.use('/api/admin', requireAuth, requireAdmin, adminRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export { app };
