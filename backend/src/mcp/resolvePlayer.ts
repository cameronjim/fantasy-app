import { query } from '../db.js';

export interface ResolvedPlayer {
  id: number;
  nba_id: string | null;
  name: string;
  team: string | null;
  position: string | null;
}

export type ResolveResult =
  | { kind: 'found'; player: ResolvedPlayer }
  | { kind: 'ambiguous'; candidates: ResolvedPlayer[] }
  | { kind: 'not_found' };

interface PlayerRow {
  id: unknown;
  nba_id: unknown;
  name: unknown;
  team: unknown;
  position: unknown;
}

function toResolvedPlayer(row: PlayerRow): ResolvedPlayer {
  return {
    id: Number(row.id),
    nba_id: row.nba_id === null || row.nba_id === undefined ? null : String(row.nba_id),
    name: String(row.name ?? ''),
    team: row.team === null || row.team === undefined ? null : String(row.team),
    position: row.position === null || row.position === undefined ? null : String(row.position),
  };
}

export async function resolvePlayer(raw: string): Promise<ResolveResult> {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'not_found' };

  if (/^\d+$/.test(trimmed)) {
    const result = await query(
      `SELECT id, nba_id, name, team, position FROM players WHERE id = $1`,
      [Number(trimmed)]
    );
    const row = result.rows[0] as PlayerRow | undefined;
    return row ? { kind: 'found', player: toResolvedPlayer(row) } : { kind: 'not_found' };
  }

  const result = await query(
    `SELECT id, nba_id, name, team, position, games_played
     FROM players
     WHERE name ILIKE $1
     ORDER BY (LOWER(name) = LOWER($2)) DESC, games_played DESC NULLS LAST, id ASC
     LIMIT 6`,
    [`%${trimmed}%`, trimmed]
  );
  const rows = result.rows as PlayerRow[];

  if (rows.length === 0) return { kind: 'not_found' };
  if (rows.length === 1 || String(rows[0].name ?? '').toLowerCase() === trimmed.toLowerCase()) {
    return { kind: 'found', player: toResolvedPlayer(rows[0]) };
  }
  return { kind: 'ambiguous', candidates: rows.slice(0, 5).map(toResolvedPlayer) };
}
