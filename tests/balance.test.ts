import { describe, expect, it } from 'vitest';
import vectors from '../shared/test-vectors.json';
import { householdBalance, netPositions, type BalanceEntry } from '../src/money/balance';

function toEntries(raw: (typeof vectors.balance)[number]['entries']): BalanceEntry[] {
  return raw.map((e) => ({
    paidByPartyId: e.paid_by,
    totalCents: e.total_cents,
    shares: Object.entries(e.shares).map(([partyId, shareCents]) => ({ partyId, shareCents })),
  }));
}

describe('net positions (shared vectors)', () => {
  it.each(vectors.balance)('$name', (v) => {
    const nets = netPositions(v.parties, toEntries(v.entries));
    expect(Object.fromEntries(nets.map((n) => [n.partyId, n.netCents]))).toEqual(v.expected);
    expect(nets.reduce((acc, n) => acc + n.netCents, 0)).toBe(0);
  });
});

describe('netPositions', () => {
  it('rejects an entry whose shares do not add up', () => {
    expect(() =>
      netPositions(['a', 'b'], [{ paidByPartyId: 'a', totalCents: 100, shares: [] }]),
    ).toThrow();
  });

  it('rejects an unknown party', () => {
    expect(() =>
      netPositions(
        ['a'],
        [{ paidByPartyId: 'a', totalCents: 100, shares: [{ partyId: 'z', shareCents: 100 }] }],
      ),
    ).toThrow();
  });
});

describe('householdBalance', () => {
  const nets = [
    { partyId: 'h1', netCents: 4000 },
    { partyId: 'h2', netCents: -4000 },
  ];

  it('says the other household owes you when your net is positive', () => {
    expect(householdBalance(nets, 'h1')).toEqual({ direction: 'they_owe_you', cents: 4000 });
  });

  it('says you owe them when your net is negative', () => {
    expect(householdBalance(nets, 'h2')).toEqual({ direction: 'you_owe_them', cents: 4000 });
  });

  it('says settled at zero', () => {
    const zero = [
      { partyId: 'h1', netCents: 0 },
      { partyId: 'h2', netCents: 0 },
    ];
    expect(householdBalance(zero, 'h1')).toEqual({ direction: 'settled', cents: 0 });
  });
});
