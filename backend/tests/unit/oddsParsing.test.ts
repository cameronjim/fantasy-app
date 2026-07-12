import { describe, it, expect } from 'vitest';
import {
  parseSpreadDetails,
  parseEventOdds,
  computeOddsHash,
  DEFAULT_LINE_PRICE,
  type EspnEvent,
} from '../../src/services/odds.js';

// fixture modeled on a real June 2026 ESPN scoreboard payload: per-side close
// prices under pointSpread/total/moneyline, plus the legacy flat fields.
const scheduledEvent = (overrides: Partial<EspnEvent> = {}): EspnEvent => ({
  id: '401859966',
  date: '2026-06-11T00:30Z',
  status: { type: { name: 'STATUS_SCHEDULED', detail: 'Wed, June 10th at 8:30 PM EDT', shortDetail: '6/10 - 8:30 PM EDT' } },
  competitions: [
    {
      competitors: [
        { homeAway: 'home', team: { displayName: 'New York Knicks', abbreviation: 'NY' } },
        { homeAway: 'away', team: { displayName: 'San Antonio Spurs', abbreviation: 'SA' } },
      ],
      odds: [
        {
          provider: { name: 'Draft Kings' },
          details: 'NY -2.5',
          overUnder: 216.5,
          spread: -2.5,
          moneyline: {
            home: { close: { odds: '-130' } },
            away: { close: { odds: '+105' } },
          },
          pointSpread: {
            home: { close: { line: '-2.5', odds: '-105' } },
            away: { close: { line: '+2.5', odds: '-115' } },
          },
          total: {
            over: { close: { line: 'o216.5', odds: '-112' } },
            under: { close: { line: 'u216.5', odds: '-108' } },
          },
        },
      ],
    },
  ],
  ...overrides,
});

describe('parseSpreadDetails', () => {
  it('resolves the favorite abbreviation to a home-relative line', () => {
    // act + assert — favorite is home: line as-is; favorite is away: negated
    expect(parseSpreadDetails('NY -2.5', 'NY', 'SA')).toBe(-2.5);
    expect(parseSpreadDetails('SA -2.5', 'NY', 'SA')).toBe(2.5);
  });

  it('treats EVEN as a pick-em', () => {
    // act + assert
    expect(parseSpreadDetails('EVEN', 'NY', 'SA')).toBe(0);
  });

  it('returns undefined for garbage or unknown teams', () => {
    // act + assert
    expect(parseSpreadDetails('not a spread', 'NY', 'SA')).toBeUndefined();
    expect(parseSpreadDetails('BOS -6.5', 'NY', 'SA')).toBeUndefined();
    expect(parseSpreadDetails(undefined, 'NY', 'SA')).toBeUndefined();
  });
});

describe('parseEventOdds', () => {
  it('parses all three markets with per-side prices and implied probabilities', () => {
    // act
    const game = parseEventOdds(scheduledEvent());

    // assert
    expect(game).not.toBeNull();
    expect(game!.nba_game_id).toBe('401859966');
    expect(game!.home_team).toBe('New York Knicks');
    expect(game!.away_team).toBe('San Antonio Spurs');
    expect(game!.game_date).toBe('2026-06-10'); // 00:30 UTC = 8:30 PM ET previous day
    expect(game!.tipoff).toBe('6/10 - 8:30 PM EDT');
    expect(game!.provider).toBe('Draft Kings');

    expect(game!.markets.spread).toEqual({
      home_line: -2.5,
      away_line: 2.5,
      home_price: -105,
      away_price: -115,
      home_implied: expect.closeTo(0.5122, 3),
      away_implied: expect.closeTo(0.5349, 3),
    });
    expect(game!.markets.total).toEqual({
      line: 216.5,
      over_price: -112,
      under_price: -108,
      over_implied: expect.closeTo(0.5283, 3),
      under_implied: expect.closeTo(0.5192, 3),
    });
    expect(game!.markets.moneyline).toEqual({
      home: -130,
      away: 105,
      home_implied: expect.closeTo(0.5652, 3),
      away_implied: expect.closeTo(0.4878, 3),
    });
  });

  it('falls back to flat fields with default juice when close prices are missing', () => {
    // arrange — legacy shape: only details/overUnder/spread + team moneylines
    const event = scheduledEvent();
    event.competitions[0].odds = [
      {
        provider: { name: 'ESPN BET' },
        details: 'NY -2.5',
        overUnder: 216.5,
        spread: -2.5,
        homeTeamOdds: { moneyLine: -130 },
        awayTeamOdds: { moneyLine: 105 },
      },
    ];

    // act
    const game = parseEventOdds(event);

    // assert
    expect(game!.markets.spread?.home_line).toBe(-2.5);
    expect(game!.markets.spread?.home_price).toBe(DEFAULT_LINE_PRICE);
    expect(game!.markets.total?.line).toBe(216.5);
    expect(game!.markets.total?.over_price).toBe(DEFAULT_LINE_PRICE);
    expect(game!.markets.moneyline?.home).toBe(-130);
    expect(game!.markets.moneyline?.away).toBe(105);
  });

  it('returns the game with empty markets when no odds node exists', () => {
    // arrange
    const event = scheduledEvent();
    event.competitions[0].odds = undefined;

    // act
    const game = parseEventOdds(event);

    // assert
    expect(game).not.toBeNull();
    expect(game!.markets).toEqual({});
  });

  it('returns null when competitors are missing', () => {
    // arrange
    const event = scheduledEvent();
    event.competitions[0].competitors = [];

    // act + assert
    expect(parseEventOdds(event)).toBeNull();
  });
});

describe('computeOddsHash', () => {
  it('is stable across game order but changes when a line moves', () => {
    // arrange
    const a = parseEventOdds(scheduledEvent())!;
    const b = parseEventOdds(scheduledEvent({ id: '401859967' }))!;
    const aMoved = { ...a, markets: { ...a.markets, total: { ...a.markets.total!, line: 218.5 } } };

    // act + assert
    expect(computeOddsHash([a, b])).toBe(computeOddsHash([b, a]));
    expect(computeOddsHash([a, b])).not.toBe(computeOddsHash([aMoved, b]));
  });
});
