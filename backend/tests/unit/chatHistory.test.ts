import { describe, it, expect } from 'vitest';
import {
  sanitizeChatHistory,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_LENGTH,
} from '../../src/services/chatHistory.js';

describe('sanitizeChatHistory', () => {
  it('returns an empty array for non-array input', () => {
    // act + assert
    expect(sanitizeChatHistory(undefined)).toEqual([]);
    expect(sanitizeChatHistory('not an array')).toEqual([]);
    expect(sanitizeChatHistory(null)).toEqual([]);
  });

  it('keeps only user/assistant turns with non-empty string content', () => {
    // arrange — mix of valid turns, an invalid role, and a non-string body.
    const input = [
      { role: 'user', message: 'hi' },
      { role: 'system', message: 'should be dropped' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', message: 42 },
      { role: 'user', message: '   ' },
    ];

    // act
    const result = sanitizeChatHistory(input);

    // assert
    expect(result).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('truncates content longer than the per-message cap', () => {
    // act
    const [turn] = sanitizeChatHistory([
      { role: 'user', message: 'x'.repeat(MAX_MESSAGE_LENGTH + 100) },
    ]);

    // assert
    expect(turn.content.length).toBe(MAX_MESSAGE_LENGTH);
  });

  it('keeps only the most recent turns up to the cap', () => {
    // arrange
    const many = Array.from({ length: MAX_HISTORY_TURNS + 10 }, (_, i) => ({
      role: 'user',
      message: `m${i}`,
    }));

    // act
    const result = sanitizeChatHistory(many);

    // assert
    expect(result).toHaveLength(MAX_HISTORY_TURNS);
    expect(result[result.length - 1].content).toBe(`m${MAX_HISTORY_TURNS + 9}`);
  });
});
