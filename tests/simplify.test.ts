import { describe, expect, it } from 'vitest';
import type { PartyNet } from '../src/money/balance';
import { simplifyDebts, type Payment } from '../src/money/simplify';

function nets(record: Record<string, number>): PartyNet[] {
  return Object.entries(record).map(([partyId, netCents]) => ({ partyId, netCents }));
}

function applyPayments(start: readonly PartyNet[], payments: readonly Payment[]): number[] {
  const after = new Map(start.map((n) => [n.partyId, n.netCents]));
  for (const p of payments) {
    after.set(p.fromPartyId, (after.get(p.fromPartyId) ?? NaN) + p.cents);
    after.set(p.toPartyId, (after.get(p.toPartyId) ?? NaN) - p.cents);
  }
  return [...after.values()];
}

describe('simplifyDebts', () => {
  it('returns no payments when everyone is settled', () => {
    expect(simplifyDebts(nets({ a: 0, b: 0, c: 0 }))).toEqual([]);
  });

  it('settles two parties with one payment', () => {
    expect(simplifyDebts(nets({ h1: -4000, h2: 4000 }))).toEqual([
      { fromPartyId: 'h1', toPartyId: 'h2', cents: 4000 },
    ]);
  });

  it('has one debtor pay every creditor, largest first', () => {
    expect(simplifyDebts(nets({ a: 350, b: 750, c: -1250, d: 150 }))).toEqual([
      { fromPartyId: 'c', toPartyId: 'b', cents: 750 },
      { fromPartyId: 'c', toPartyId: 'a', cents: 350 },
      { fromPartyId: 'c', toPartyId: 'd', cents: 150 },
    ]);
  });

  it('matches the largest creditor with the largest debtor each step', () => {
    expect(simplifyDebts(nets({ a: 500, b: 300, c: -600, d: -200 }))).toEqual([
      { fromPartyId: 'c', toPartyId: 'a', cents: 500 },
      { fromPartyId: 'd', toPartyId: 'b', cents: 200 },
      { fromPartyId: 'c', toPartyId: 'b', cents: 100 },
    ]);
  });

  it('breaks ties by the order the parties are listed', () => {
    expect(simplifyDebts(nets({ a: 100, b: 100, c: -200 }))).toEqual([
      { fromPartyId: 'c', toPartyId: 'a', cents: 100 },
      { fromPartyId: 'c', toPartyId: 'b', cents: 100 },
    ]);
  });

  it('rejects nets that do not add up to 0', () => {
    expect(() => simplifyDebts(nets({ a: 100, b: -99 }))).toThrow();
  });

  it('settles everyone in at most N - 1 positive payments for many N-party cases', () => {
    // Small deterministic generator so failures are reproducible.
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };

    for (let round = 0; round < 300; round++) {
      const n = 2 + (round % 9);
      const values = Array.from({ length: n - 1 }, () => (next() % 200001) - 100000);
      values.push(-values.reduce((acc, v) => acc + v, 0));
      const start = values.map((netCents, i) => ({ partyId: `p${String(i)}`, netCents }));

      const payments = simplifyDebts(start);
      expect(payments.length).toBeLessThanOrEqual(n - 1);
      for (const p of payments) expect(p.cents).toBeGreaterThan(0);
      expect(applyPayments(start, payments).every((v) => v === 0)).toBe(true);
    }
  });
});
