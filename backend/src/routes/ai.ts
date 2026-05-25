import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { callClaude, buildTeamContext, buildWaiverContext } from '../services/ai.js';
import { getUserPreferences, buildPreferencesPromptBlock } from '../services/preferences.js';
import type { AuthRequest } from '../middleware/auth.js';

const router = Router();

function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];
  return text;
}

async function getRosterHash(userId: number): Promise<string> {
  const result = await query(
    `SELECT player_id FROM my_roster WHERE user_id = $1 ORDER BY player_id`,
    [userId]
  );
  const ids = result.rows.map((r: { player_id: number }) => r.player_id).join(',');
  return crypto.createHash('md5').update(ids).digest('hex');
}

router.post('/chat', async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    const { message, context_type, history } = req.body;
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    let context = '';
    if (context_type === 'myteam') context = await buildTeamContext(userId);
    else if (context_type === 'waiver') context = await buildWaiverContext(userId);

    const prefs = await getUserPreferences(userId);
    const prefsBlock = buildPreferencesPromptBlock(prefs);

    const systemPrompt = `You are an expert fantasy basketball assistant for 9-category leagues (PTS, REB, AST, STL, BLK, FG%, FT%, 3PM, TO). You help users analyze their roster and make strategic decisions.\n\n${context ? `Current context:\n\n${context}` : 'No roster context.'}${prefsBlock}\n\nProvide concise, actionable advice. Reference specific player stats. Be direct.`;

    const messages: Array<{ role: string; content: string }> = [];
    if (history && Array.isArray(history)) {
      for (const h of history) messages.push({ role: h.role, content: h.message || h.content });
    }
    messages.push({ role: 'user', content: message });

    const reply = await callClaude(systemPrompt, messages, { model: 'claude-sonnet-4-6', maxTokens: 1024 });
    res.json({ reply });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process chat' });
  }
});

router.get('/team-analysis', async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    const context = await buildTeamContext(userId);
    if (context === 'No players on roster.') {
      res.json({ strengths: [], weaknesses: [], suggestions: [], categories: {} });
      return;
    }

    const rosterHash = await getRosterHash(userId);
    // Include prefs hash in the cache key — changing prefs should bust the cache.
    const prefs = await getUserPreferences(userId);
    const prefsBlock = buildPreferencesPromptBlock(prefs);
    const cacheKey = crypto.createHash('md5').update(rosterHash + '|' + prefsBlock).digest('hex');

    const cached = await query(
      `SELECT analysis FROM analysis_cache WHERE user_id = $1 AND roster_hash = $2`,
      [userId, cacheKey]
    );
    if (cached.rows.length > 0) {
      res.json(cached.rows[0].analysis);
      return;
    }

    const systemPrompt = `You are an expert 9-category fantasy basketball analyst. Analyze the roster and return a JSON object:
{
  "categories": {
    "PTS": "strong" | "average" | "weak",
    "REB": "strong" | "average" | "weak",
    "AST": "strong" | "average" | "weak",
    "STL": "strong" | "average" | "weak",
    "BLK": "strong" | "average" | "weak",
    "FG%": "strong" | "average" | "weak",
    "FT%": "strong" | "average" | "weak",
    "3PM": "strong" | "average" | "weak",
    "TO": "strong" | "average" | "weak"
  },
  "strengths": ["<specific strength with stats>", ...],
  "weaknesses": ["<specific weakness with stats>", ...],
  "suggestions": ["<actionable suggestion>", ...]
}

For context: in a competitive 10-team 9-cat league, typical per-player averages are roughly PTS: 15, REB: 5, AST: 3.5, STL: 1.0, BLK: 0.7, FG%: 46%, FT%: 78%, 3PM: 1.5, TO: 1.8.

Rate each category relative to a competitive 9-cat league. Return ONLY valid JSON.${prefsBlock}`;

    const messages = [{ role: 'user', content: `Analyze this roster:\n\n${context}` }];
    const reply = await callClaude(systemPrompt, messages);

    try {
      const analysis = JSON.parse(extractJSON(reply));
      await query(
        `INSERT INTO analysis_cache (user_id, roster_hash, analysis, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           roster_hash = EXCLUDED.roster_hash,
           analysis = EXCLUDED.analysis,
           created_at = NOW()`,
        [userId, cacheKey, JSON.stringify(analysis)]
      );
      res.json(analysis);
    } catch {
      res.json({ raw_analysis: reply, strengths: [], weaknesses: [], suggestions: [], categories: {} });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to analyze team' });
  }
});

router.get('/waiver-suggestions', async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    const forceRefresh = req.query.refresh === 'true';
    const rosterHash = await getRosterHash(userId);
    const prefs = await getUserPreferences(userId);
    const prefsBlock = buildPreferencesPromptBlock(prefs);
    const cacheKey = crypto.createHash('md5').update(rosterHash + '|' + prefsBlock).digest('hex');

    if (!forceRefresh) {
      const cached = await query(
        `SELECT suggestions, created_at FROM waiver_cache
         WHERE user_id = $1 AND roster_hash = $2 AND created_at > NOW() - INTERVAL '4 hours'`,
        [userId, cacheKey]
      );
      if (cached.rows.length > 0) {
        res.json({ ...cached.rows[0].suggestions, cached: true, cached_at: cached.rows[0].created_at });
        return;
      }
    }

    const context = await buildWaiverContext(userId);

    const systemPrompt = `You are an expert fantasy basketball analyst for 9-category leagues (PTS, REB, AST, STL, BLK, FG%, FT%, 3PM, TO). Given the user's roster and the provided candidate lists, suggest improvements that address the team's weakest categories.${prefsBlock}

Rules:
- Only recommend players from the candidate lists provided. Do not invent player names.
- Each player name must appear at most once across the entire response.
- The "reasoning" field must be plain text only — no markdown, no rank numbers, no meta-commentary.
- Do not include phrases like "Duplicate entry", "instead recommend", or any self-correction notes.

Return a JSON object:
{
  "trade_targets": [
    { "name": "<player name>", "reasoning": "<plain text: which weak categories they address and why>" }
  ],
  "waiver_pickups": [
    { "name": "<player name>", "reasoning": "<plain text: which weak categories they address and why>" }
  ],
  "summary": "<2-3 sentence plain text strategy focused on the team's biggest weaknesses>"
}

Provide exactly 5 trade targets and exactly 5 waiver pickups. Return ONLY valid JSON.`;

    const messages = [{ role: 'user', content: `Suggest improvements:\n\n${context}` }];
    const reply = await callClaude(systemPrompt, messages);

    try {
      const raw = JSON.parse(extractJSON(reply));
      const seen = new Set<string>();
      const dedup = (list: Array<{ name: string; reasoning: string }>) =>
        (list ?? []).filter((item) => {
          const key = item.name?.toLowerCase().trim();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 5);

      const suggestions = {
        trade_targets: dedup(raw.trade_targets),
        waiver_pickups: dedup(raw.waiver_pickups),
        summary: raw.summary ?? '',
      };

      await query(
        `INSERT INTO waiver_cache (user_id, roster_hash, suggestions, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           roster_hash = EXCLUDED.roster_hash,
           suggestions = EXCLUDED.suggestions,
           created_at = NOW()`,
        [userId, cacheKey, JSON.stringify(suggestions)]
      );
      res.json(suggestions);
    } catch {
      res.json({ raw: reply, trade_targets: [], waiver_pickups: [], summary: '' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

export { router as aiRouter };
