import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedAnalysis,
  setCachedAnalysis,
  getCachedSuggestions,
  setCachedSuggestions,
  invalidateAIClientCaches,
} from '../../src/api/clientCaches';
import type { TeamAnalysis } from '../../src/types';

const analysis: TeamAnalysis = {
  categories: { PTS: 'strong', REB: 'average', AST: 'weak', STL: 'average', BLK: 'weak', 'FG%': 'average', 'FT%': 'strong', '3PM': 'average', TO: 'average' },
  strengths: ['scoring'],
  weaknesses: ['assists'],
  suggestions: ['add a playmaker'],
};

beforeEach(() => {
  invalidateAIClientCaches();
});

describe('clientCaches', () => {
  it('returns null when nothing is cached', () => {
    // act + assert
    expect(getCachedAnalysis()).toBeNull();
    expect(getCachedSuggestions()).toBeNull();
  });

  it('returns the value that was set', () => {
    // arrange + act
    setCachedAnalysis(analysis);

    // assert
    expect(getCachedAnalysis()).toEqual(analysis);
  });

  it('invalidateAIClientCaches clears both caches', () => {
    // arrange
    setCachedAnalysis(analysis);
    setCachedSuggestions({ trade_targets: [], waiver_pickups: [], summary: 'x' });

    // act
    invalidateAIClientCaches();

    // assert
    expect(getCachedAnalysis()).toBeNull();
    expect(getCachedSuggestions()).toBeNull();
  });
});
