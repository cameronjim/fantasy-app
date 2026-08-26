
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_HISTORY_TURNS = 20;

export function sanitizeChatHistory(history: unknown): ChatTurn[] {
  if (!Array.isArray(history)) return [];

  const turns: ChatTurn[] = [];
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;

    const role = (entry as { role?: unknown }).role;
    if (role !== 'user' && role !== 'assistant') continue;

    const rawContent =
      (entry as { message?: unknown }).message ?? (entry as { content?: unknown }).content;
    if (typeof rawContent !== 'string') continue;

    const content = rawContent.slice(0, MAX_MESSAGE_LENGTH).trim();
    if (content.length === 0) continue;

    turns.push({ role, content });
  }

  return turns.slice(-MAX_HISTORY_TURNS);
}
