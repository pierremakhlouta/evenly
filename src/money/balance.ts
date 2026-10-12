/**
 * Net positions. A party's net = (total of entries it paid) - (total of its shares).
 * Positive means others owe it; negative means it owes others. Nets always sum to 0.
 */

export interface ShareRow {
  partyId: string;
  shareCents: number;
}

export interface BalanceEntry {
  paidByPartyId: string;
  totalCents: number;
  shares: readonly ShareRow[];
}

export interface PartyNet {
  partyId: string;
  netCents: number;
}

/**
 * Computes every party's net from active (non-deleted) entries.
 * Returns one row per party in the order given, including parties at 0.
 */
export function netPositions(
  partyIds: readonly string[],
  entries: readonly BalanceEntry[],
): PartyNet[] {
  const nets = new Map<string, number>(partyIds.map((id) => [id, 0]));
  const add = (partyId: string, cents: number) => {
    const current = nets.get(partyId);
    if (current === undefined) throw new Error(`Unknown party ${partyId}`);
    nets.set(partyId, current + cents);
  };

  for (const entry of entries) {
    const shareTotal = entry.shares.reduce((acc, s) => acc + s.shareCents, 0);
    if (shareTotal !== entry.totalCents) {
      throw new Error('Entry shares must add up to its total');
    }
    add(entry.paidByPartyId, entry.totalCents);
    for (const share of entry.shares) add(share.partyId, -share.shareCents);
  }

  return [...nets].map(([partyId, netCents]) => ({ partyId, netCents }));
}

export type HouseholdBalance =
  | { direction: 'settled'; cents: 0 }
  | { direction: 'they_owe_you' | 'you_owe_them'; cents: number };

/** Household mode: the one balance, phrased from the viewing phone's household. */
export function householdBalance(
  nets: readonly PartyNet[],
  viewerPartyId: string,
): HouseholdBalance {
  const viewer = nets.find((n) => n.partyId === viewerPartyId);
  if (!viewer) throw new Error(`Unknown party ${viewerPartyId}`);
  if (viewer.netCents > 0) return { direction: 'they_owe_you', cents: viewer.netCents };
  if (viewer.netCents < 0) return { direction: 'you_owe_them', cents: -viewer.netCents };
  return { direction: 'settled', cents: 0 };
}

/**
 * How one entry moves a party's net: what it paid minus its share. Positive means
 * the entry made others owe this party more (or this party owe less).
 */
export function netChange(entry: BalanceEntry, partyId: string): number {
  const paid = entry.paidByPartyId === partyId ? entry.totalCents : 0;
  const share = entry.shares.find((s) => s.partyId === partyId)?.shareCents ?? 0;
  return paid - share;
}
