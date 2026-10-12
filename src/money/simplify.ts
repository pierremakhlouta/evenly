import type { PartyNet } from './balance';

export interface Payment {
  fromPartyId: string;
  toPartyId: string;
  cents: number;
}

/**
 * Turns net positions into a short list of payments that settles everyone.
 * Repeatedly matches the largest creditor with the largest debtor, which needs
 * at most N - 1 payments. Ties go to the party listed first (pass nets in sort order).
 */
export function simplifyDebts(nets: readonly PartyNet[]): Payment[] {
  if (nets.reduce((acc, n) => acc + n.netCents, 0) !== 0) {
    throw new Error('Net positions must add up to 0');
  }

  const balances = nets.map((n, index) => ({ partyId: n.partyId, index, cents: n.netCents }));
  const largest = (sign: 1 | -1) =>
    balances
      .filter((b) => sign * b.cents > 0)
      .reduce<(typeof balances)[number] | undefined>(
        (best, b) => (best === undefined || sign * b.cents > sign * best.cents ? b : best),
        undefined,
      );

  const payments: Payment[] = [];
  for (;;) {
    const creditor = largest(1);
    const debtor = largest(-1);
    if (!creditor || !debtor) break;
    const cents = Math.min(creditor.cents, -debtor.cents);
    payments.push({ fromPartyId: debtor.partyId, toPartyId: creditor.partyId, cents });
    creditor.cents -= cents;
    debtor.cents += cents;
  }
  return payments;
}
