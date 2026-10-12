import { describe, expect, it } from 'vitest';
import vectors from '../shared/test-vectors.json';
import {
  splitHousehold,
  splitPeople,
  SplitError,
  type HouseholdSplit,
  type PeopleSplitType,
} from '../src/money/split';

interface HouseholdVector {
  total_cents: number;
  split_type: string;
  split_num?: number;
  split_den?: number;
}

interface PeopleVector {
  total_cents: number;
  split_type: string;
  parties: { id: string; sort_order: number; value?: number }[];
}

/** Maps a vector's database-shaped split columns to the TypeScript split type. */
function householdSplit(v: HouseholdVector): HouseholdSplit {
  const num = v.split_num ?? NaN;
  switch (v.split_type) {
    case 'third':
    case 'half':
    case 'all':
      return { type: v.split_type };
    case 'fraction':
      return { type: 'fraction', num, den: v.split_den ?? NaN };
    case 'percent':
      return { type: 'percent', basisPoints: num };
    case 'amount':
      return { type: 'amount', amountCents: num };
    default:
      throw new Error(`Unknown split_type ${v.split_type}`);
  }
}

function runPeople(v: PeopleVector) {
  const parties = v.parties.map((p) =>
    p.value === undefined
      ? { partyId: p.id, sortOrder: p.sort_order }
      : { partyId: p.id, sortOrder: p.sort_order, value: p.value },
  );
  return splitPeople(v.total_cents, v.split_type as PeopleSplitType, parties);
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SplitError) return e.code;
    throw e;
  }
  throw new Error('Expected a SplitError');
}

describe('household splits (shared vectors)', () => {
  it.each(vectors.household)('$name', (v) => {
    const shares = splitHousehold(v.total_cents, householdSplit(v));
    expect(shares).toEqual({
      otherCents: v.expected.other_cents,
      payerCents: v.expected.payer_cents,
    });
    expect(shares.otherCents + shares.payerCents).toBe(v.total_cents);
  });

  it.each(vectors.household_invalid)('rejects $name', (v) => {
    expect(errorCode(() => splitHousehold(v.total_cents, householdSplit(v)))).toBe(v.error);
  });
});

describe('people splits (shared vectors)', () => {
  it.each(vectors.people)('$name', (v) => {
    const shares = runPeople(v);
    expect(Object.fromEntries(shares.map((s) => [s.partyId, s.shareCents]))).toEqual(v.expected);
    expect(shares.reduce((acc, s) => acc + s.shareCents, 0)).toBe(v.total_cents);
  });

  it.each(vectors.people_invalid)('rejects $name', (v) => {
    expect(errorCode(() => runPeople(v))).toBe(v.error);
  });
});

describe('split invariants', () => {
  it('shares always add up to the total across many totals and splits', () => {
    const splits: HouseholdSplit[] = [
      { type: 'third' },
      { type: 'half' },
      { type: 'fraction', num: 3, den: 7 },
      { type: 'percent', basisPoints: 3750 },
    ];
    for (let total = 1; total <= 2000; total++) {
      for (const split of splits) {
        const s = splitHousehold(total, split);
        expect(s.otherCents + s.payerCents).toBe(total);
        expect(s.otherCents).toBeGreaterThanOrEqual(0);
        expect(s.payerCents).toBeGreaterThanOrEqual(0);
      }
      const people = splitPeople(total, 'weights', [
        { partyId: 'a', sortOrder: 1, value: 3 },
        { partyId: 'b', sortOrder: 2, value: 5 },
        { partyId: 'c', sortOrder: 3, value: 11 },
      ]);
      expect(people.reduce((acc, p) => acc + p.shareCents, 0)).toBe(total);
    }
  });

  it('returns people shares in sort order', () => {
    const shares = splitPeople(100, 'equal', [
      { partyId: 'x', sortOrder: 2 },
      { partyId: 'y', sortOrder: 1 },
    ]);
    expect(shares.map((s) => s.partyId)).toEqual(['y', 'x']);
  });
});
