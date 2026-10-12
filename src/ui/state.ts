import type { Party, Person, Summary } from '../api/types';

/** Read helpers over the summary, so screens never repeat lookups. */
export class GroupView {
  constructor(readonly summary: Summary) {}

  get mode() {
    return this.summary.group.mode;
  }

  party(id: string | null | undefined): Party | undefined {
    return this.summary.parties.find((p) => p.id === id);
  }

  person(id: string | null | undefined): Person | undefined {
    return this.summary.people.find((p) => p.id === id);
  }

  partyName(id: string | null | undefined): string {
    return this.party(id)?.name ?? 'Unknown';
  }

  personName(id: string | null | undefined): string {
    return this.person(id)?.name ?? 'Unknown';
  }

  get me(): Person | undefined {
    return this.person(this.summary.me.person_id);
  }

  get myPartyId(): string | null {
    return this.summary.me.party_id;
  }

  /** Active parties in sort order. */
  get activeParties(): Party[] {
    return this.summary.parties.filter((p) => !p.archived);
  }

  /** Household mode: the household that is not this phone's. */
  get otherPartyId(): string | null {
    return this.activeParties.find((p) => p.id !== this.myPartyId)?.id ?? null;
  }

  /** Active people of a party, in sort order. */
  peopleOf(partyId: string): Person[] {
    return this.summary.people.filter((p) => p.party_id === partyId && !p.archived);
  }

  /** True when this phone has picked a person that is still active. */
  get hasPerson(): boolean {
    const me = this.me;
    return me !== undefined && !me.archived;
  }
}
