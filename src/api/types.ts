/**
 * Shapes returned by the database RPCs. Field names match the database (snake_case)
 * so there is no mapping layer to get wrong.
 */

export type Mode = 'households' | 'people';
export type EntryKind = 'expense' | 'payment';
export type HouseholdSplitType = 'third' | 'half' | 'all' | 'fraction' | 'percent' | 'amount';
export type PeopleSplitType = 'equal' | 'amounts' | 'percent' | 'weights';
export type SplitType = HouseholdSplitType | PeopleSplitType;

export interface Group {
  id: string;
  name: string;
  mode: Mode;
}

export interface Party {
  id: string;
  name: string;
  kind: 'household' | 'person';
  sort_order: number;
  archived: boolean;
}

export interface Person {
  id: string;
  name: string;
  party_id: string;
  sort_order: number;
  archived: boolean;
  is_admin: boolean;
  has_pin: boolean;
}

export interface PartyNet {
  party_id: string;
  net_cents: number;
}

export interface Summary {
  group: Group;
  parties: Party[];
  people: Person[];
  nets: PartyNet[];
  /** Creation time of the latest settle-up, or null if the group never settled. */
  last_settled_at: string | null;
  me: { device_id: string; person_id: string | null; party_id: string | null };
}

export interface Share {
  party_id: string;
  share_cents: number;
}

export interface SplitInput {
  party_id: string;
  value?: number;
}

export interface Entry {
  id: string;
  kind: EntryKind;
  description: string;
  entry_date: string; // YYYY-MM-DD
  total_cents: number;
  paid_by_party_id: string;
  paid_by_person_id: string | null;
  split_type: SplitType | null;
  split_num: number | null;
  split_den: number | null;
  split_inputs: SplitInput[] | null;
  recurring_bill_id: string | null;
  bill_period: string | null;
  /** A "Settle full balance" payment, which ends a period. */
  settles: boolean;
  created_by_person_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by_person_id: string | null;
  shares: Share[];
}

export interface EntryEvent {
  action: 'create' | 'edit' | 'delete' | 'restore';
  by_person_id: string | null;
  at: string;
  before: Entry | null;
  after: Entry | null;
  note: string | null;
}

export interface EntryWithEvents extends Entry {
  events: EntryEvent[];
}

export interface EntryPage {
  entries: Entry[];
  next_before: string | null;
}

export interface RecurringBill {
  id: string;
  name: string;
  paid_by_party_id: string;
  split_type: SplitType;
  split_num: number | null;
  split_den: number | null;
  split_inputs: SplitInput[] | null;
  default_total_cents: number | null;
  auto_add: boolean;
  day_of_month: number;
  active: boolean;
  sort_order: number;
}

export interface Device {
  id: string;
  label: string | null;
  person_id: string | null;
  created_at: string;
  last_seen_at: string;
  revoked: boolean;
  is_me: boolean;
}

/** Fields shared by add_entry and edit_entry. */
export interface EntryInput {
  description: string;
  entry_date: string;
  total_cents: number;
  paid_by_party_id: string;
  paid_by_person_id?: string | null;
  split_type?: SplitType | null;
  split_num?: number | null;
  split_den?: number | null;
  split_inputs?: SplitInput[] | null;
  to_party_id?: string | null;
}

/** A settle-up period, bounded by creation time (pass the bounds to list_entries). */
export interface PeriodInfo {
  created_after: string | null;
  entry_count: number;
  first_date: string | null;
  last_date: string | null;
}

export interface SettledPeriod extends PeriodInfo {
  created_until: string;
  settlement: Entry;
}

export interface Periods {
  current: PeriodInfo;
  settled: SettledPeriod[];
}
