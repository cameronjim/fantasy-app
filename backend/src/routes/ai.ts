import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { callClaude, buildTeamContext, buildWaiverContext } from '../services/ai.js';

const router = Router();

/** Strip markdown code fences from Claude's response so JSON.parse works. */
function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];
  return text;
}

/** Compute a hash of the current roster to detect changes. */
async function getRosterHash(): Promise<string> {
  const result = await query(
    `SELECT player_id FROM my_roster ORDER BY player_id`
  );
  const ids = result.rows.map((r: { player_id: number }) => r.player_id).join(',');
  return crypto.createHash('md5').update(ids).digest('hex');
}

// POST /chat — AI chat
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { message, context_type, history } = req.body;
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    let context = '';
    if (context_type === 'myteam') {
      context = await buildTeamContext();
    } else if (context_type === 'waiver') {
      context = await buildWaiverContext();
    }

    const systemPrompt = `You are an expert fantasy basketball assistant for 9-category leagues (PTS, REB, AST, STL, BLK, FG%, FT%, 3PM, TO). You help users analyze their roster and make strategic decisions.\n\n${context ? `Current context:\n\n${context}` : 'No roster context.'}\n\nProvide concise, actionable advice. Reference specific player stats. Be direct.`;

    const messages: Array<{ role: string; content: string }> = [];
    if (history && Array.isArray(history)) {
      for (const h of history) {
        messages.push({ role: h.role, content: h.message || h.content });
      }
    }
    messages.push({ role: 'user', content: message });

    const reply = await callClaude(systemPrompt, messages);
    res.json({ reply });
  } catch (error) {
    console.error('Error in AI chat:', error);
    res.status(500).json({ error: 'Failed to process chat' });
  }
});

// GET /team-analysis — analyze my roster (cached until roster changes)
router.get('/team-analysis', async (_req: Request, res: Response) => {
  try {
    const context = await buildTeamContext();
    if (context === 'No players on roster.') {
      res.json({ strengths: [], weaknesses: [], suggestions: [], categories: {} });
      return;
    }

    // Check cache — only call AI if roster has changed
    const rosterHash = await getRosterHash();
    const cached = await query(
      `SELECT analysis FROM analysis_cache WHERE id = 1 AND roster_hash = $1`,
      [rosterHash]
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

Rate each category relative to a competitive 9-cat league. Return ONLY valid JSON.`;

    const messages = [{ role: 'user', content: `Analyze this roster:\n\n${context}` }];
    const reply = await callClaude(systemPrompt, messages);

    try {
      const analysis = JSON.parse(extractJSON(reply));

      // Save to cache
      await query(
        `INSERT INTO analysis_cache (id, roster_hash, analysis, created_at)
         VALUES (1, $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET
           roster_hash = EXCLUDED.roster_hash,
           analysis = EXCLUDED.analysis,
           created_at = NOW()`,
        [rosterHash, JSON.stringify(analysis)]
      );

      res.json(analysis);
    } catch {
      res.json({ raw_analysis: reply, strengths: [], weaknesses: [], suggestions: [], categories: {} });
    }
  } catch (error) {
    console.error('Error in team analysis:', error);
    res.status(500).json({ error: 'Failed to analyze team' });
  }
});

// GET /waiver-suggestions — trade targets + waiver pickups (cached 24h, invalidated on roster change)
router.get('/waiver-suggestions', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const rosterHash = await getRosterHash();

    // Check cache — valid if same roster and < 24 hours old
    if (!forceRefresh) {
      const cached = await query(
        `SELECT suggestions, created_at FROM waiver_cache
         WHERE id = 1 AND roster_hash = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [rosterHash]
      );
      if (cached.rows.length > 0) {
        res.json({ ...cached.rows[0].suggestions, cached: true, cached_at: cached.rows[0].created_at });
        return;
      }
    }

    const context = await buildWaiverContext();

    const systemPrompt = `You are an expert fantasy basketball analyst for 9-category leagues. Given the user's roster and available players, suggest trade targets and waiver pickups that address the team's weaknesses.

Return a JSON object:
{
  "trade_targets": [
    { "name": "<player name>", "reasoning": "<why they help, which weak categories they address>" }
  ],
  "waiver_pickups": [
    { "name": "<player name>", "reasoning": "<why they help, which weak categories they address>" }
  ],
  "summary": "<brief overall strategy>"
}

Provide up to 5 trade targets and 5 waiver pickups. Return ONLY valid JSON.`;

    const messages = [{ role: 'user', content: `Suggest improvements:\n\n${context}` }];
    const reply = await callClaude(systemPrompt, messages);

    try {
      const suggestions = JSON.parse(extractJSON(reply));

      await query(
        `INSERT INTO waiver_cache (id, roster_hash, suggestions, created_at)
         VALUES (1, $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET
           roster_hash = EXCLUDED.roster_hash,
           suggestions = EXCLUDED.suggestions,
           created_at = NOW()`,
        [rosterHash, JSON.stringify(suggestions)]
      );

      res.json(suggestions);
    } catch {
      res.json({ raw: reply, trade_targets: [], waiver_pickups: [], summary: '' });
    }
  } catch (error) {
    console.error('Error in waiver suggestions:', error);
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

export default router;
