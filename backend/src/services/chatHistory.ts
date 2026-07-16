/**
 * Sanitizes untrusted chat history before it's forwarded to the Anthropic API.
 *
 * The client sends prior turns so the assistant has conversational context, but
 * that payload is fully attacker-controlled. Bounding the role set, content
 * length, and turn count stops a caller from running up token cost or smuggling
 * an oversized / malformed prompt through the chat endpoint.
 */

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

    // the client uses `message`; assistant echoes may use `content`.
    const rawContent =
      (entry as { message?: unknown }).message ?? (entry as { content?: unknown }).content;
    if (typeof rawContent !== 'string') continue;

    const content = rawContent.slice(0, MAX_MESSAGE_LENGTH).trim();
    if (content.length === 0) continue;

    turns.push({ role, content });
  }

  // keep only the most recent turns — older context matters least, and the cap
  // bounds prompt size no matter how much history the client sends.
  return turns.slice(-MAX_HISTORY_TURNS);
}
