/**
 * Split math. Pure functions on integer cents: no DOM, no network, no floats.
 *
 * The database is the source of truth for stored shares; this copy powers the
 * live form preview and must match it exactly (see shared/test-vectors.json).
 */

/** Largest allowed entry total: $1,000,000.00. Keeps every product a safe integer. */
export const MAX_TOTAL_CENTS = 100_000_000;
/** Percentages are stored as basis points: 40% = 4000. */
export const BASIS_POINTS = 10_000;
/** Largest whole-number weight in a people-mode weights split. */
export const MAX_WEIGHT = 1_000;

export type SplitErrorCode =
  | 'invalid_total'
  | 'invalid_fraction'
  | 'invalid_percent'
  | 'invalid_amount'
  | 'invalid_weights'
  | 'invalid_parties';

export class SplitError extends Error {
  constructor(
    readonly code: SplitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SplitError';
  }
}

// ---------------------------------------------------------------------------
// Household mode: two parties, the form asks for the other household's share.
// ---------------------------------------------------------------------------

export type HouseholdSplit =
  | { type: 'third' }
  | { type: 'half' }
  | { type: 'all' }
  | { type: 'fraction'; num: number; den: number }
  | { type: 'percent'; basisPoints: number }
  | { type: 'amount'; amountCents: number };

export interface HouseholdShares {
  /** What the other household owes the payer. */
  otherCents: number;
  /** What the payer spent on themselves. Always totalCents - otherCents. */
  payerCents: number;
}

export function splitHousehold(totalCents: number, split: HouseholdSplit): HouseholdShares {
  assertTotal(totalCents);
  const otherCents = householdOtherShare(totalCents, split);
  return { otherCents, payerCents: totalCents - otherCents };
}

function householdOtherShare(totalCents: number, split: HouseholdSplit): number {
  switch (split.type) {
    case 'third':
      return roundHalfUpDiv(totalCents, 3);
    case 'half':
      return roundHalfUpDiv(totalCents, 2);
    case 'all':
      return totalCents;
    case 'fraction': {
      const { num, den } = split;
      if (!isInt(num) || !isInt(den) || num <= 0 || den <= 0 || num > den) {
        throw new SplitError('invalid_fraction', 'Fraction must satisfy 0 < num <= den');
      }
      return roundHalfUpDiv(totalCents * num, den);
    }
    case 'percent': {
      const bp = split.basisPoints;
      if (!isInt(bp) || bp <= 0 || bp > BASIS_POINTS) {
        throw new SplitError('invalid_percent', 'Percent must be above 0% and at most 100%');
      }
      return roundHalfUpDiv(totalCents * bp, BASIS_POINTS);
    }
    case 'amount': {
      const amount = split.amountCents;
      if (!isInt(amount) || amount <= 0 || amount > totalCents) {
        throw new SplitError('invalid_amount', 'Amount must be above 0 and at most the total');
      }
      return amount;
    }
  }
}

// ---------------------------------------------------------------------------
// People mode: any number of parties.
// ---------------------------------------------------------------------------

export type PeopleSplitType = 'equal' | 'amounts' | 'percent' | 'weights';

export interface PartyInput {
  partyId: string;
  sortOrder: number;
  /** Cents for 'amounts', basis points for 'percent', weight for 'weights'. Unused for 'equal'. */
  value?: number;
}

export interface PartyShare {
  partyId: string;
  shareCents: number;
}

/** Returns one share per party, ordered by sortOrder (then partyId). */
export function splitPeople(
  totalCents: number,
  type: PeopleSplitType,
  parties: readonly PartyInput[],
): PartyShare[] {
  assertTotal(totalCents);
  const sorted = sortParties(parties);

  switch (type) {
    case 'equal':
      return allocate(
        totalCents,
        sorted,
        sorted.map(() => 1),
      );
    case 'amounts': {
      const amounts = values(sorted, 'invalid_amount', (v) => v >= 0);
      if (sum(amounts) !== totalCents) {
        throw new SplitError('invalid_amount', 'Amounts must add up to the total');
      }
      return sorted.map((p, i) => ({ partyId: p.partyId, shareCents: amounts[i] ?? 0 }));
    }
    case 'percent': {
      const bps = values(sorted, 'invalid_percent', (v) => v >= 0 && v <= BASIS_POINTS);
      if (sum(bps) !== BASIS_POINTS) {
        throw new SplitError('invalid_percent', 'Percentages must add up to 100%');
      }
      return allocate(totalCents, sorted, bps);
    }
    case 'weights': {
      const weights = values(sorted, 'invalid_weights', (v) => v >= 0 && v <= MAX_WEIGHT);
      if (sum(weights) === 0) {
        throw new SplitError('invalid_weights', 'At least one weight must be above 0');
      }
      return allocate(totalCents, sorted, weights);
    }
  }
}

/**
 * Largest remainder allocation: everyone gets floor(total * w / W), then the
 * leftover cents go one each by largest remainder, ties by sort order.
 * With equal weights this is "floor, then leftovers in sort order".
 */
function allocate(
  totalCents: number,
  sorted: readonly PartyInput[],
  weights: readonly number[],
): PartyShare[] {
  const weightSum = sum(weights);
  const rows = sorted.map((p, i) => {
    const product = totalCents * (weights[i] ?? 0);
    return {
      partyId: p.partyId,
      index: i,
      shareCents: floorDiv(product, weightSum),
      remainder: product % weightSum,
    };
  });

  let leftover = totalCents - sum(rows.map((r) => r.shareCents));
  const byRemainder = [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const row of byRemainder) {
    if (leftover === 0) break;
    row.shareCents += 1;
    leftover -= 1;
  }

  return rows.map(({ partyId, shareCents }) => ({ partyId, shareCents }));
}

function sortParties(parties: readonly PartyInput[]): PartyInput[] {
  if (parties.length === 0) {
    throw new SplitError('invalid_parties', 'At least one party is required');
  }
  const ids = new Set(parties.map((p) => p.partyId));
  if (ids.size !== parties.length) {
    throw new SplitError('invalid_parties', 'Each party can appear only once');
  }
  if (!parties.every((p) => isInt(p.sortOrder))) {
    throw new SplitError('invalid_parties', 'Sort order must be a whole number');
  }
  return [...parties].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || (a.partyId < b.partyId ? -1 : a.partyId > b.partyId ? 1 : 0),
  );
}

function values(
  sorted: readonly PartyInput[],
  code: SplitErrorCode,
  inRange: (v: number) => boolean,
): number[] {
  return sorted.map((p) => {
    const v = p.value;
    if (v === undefined || !isInt(v) || !inRange(v)) {
      throw new SplitError(code, 'Each party needs a valid whole-number value');
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Integer helpers
// ---------------------------------------------------------------------------

function assertTotal(totalCents: number): void {
  if (!isInt(totalCents) || totalCents <= 0 || totalCents > MAX_TOTAL_CENTS) {
    throw new SplitError('invalid_total', 'Total must be between $0.01 and $1,000,000.00');
  }
}

function isInt(n: number): boolean {
  return Number.isSafeInteger(n);
}

/** floor(a / b) for a >= 0, b > 0, using exact integer arithmetic. */
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/** round_half_up(a / b) for a >= 0, b > 0: floor((2a + b) / 2b). */
export function roundHalfUpDiv(a: number, b: number): number {
  return floorDiv(2 * a + b, 2 * b);
}

function sum(ns: readonly number[]): number {
  return ns.reduce((acc, n) => acc + n, 0);
}
