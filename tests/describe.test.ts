import { describe, expect, it } from 'vitest';
import type { Entry, Summary } from '../src/api/types';
import { today } from '../src/dates';
import { describeChanges, percentText, splitLabel } from '../src/ui/describe';
import { GroupView } from '../src/ui/state';

const year = today().slice(0, 4);

const summary: Summary = {
  group: { id: 'g', name: 'Test House', mode: 'households' },
  parties: [
    { id: 'h1', name: 'Main floor', kind: 'household', sort_order: 1, archived: false },
    { id: 'h2', name: 'Basement', kind: 'household', sort_order: 2, archived: false },
  ],
  people: [
    {
      id: 'p1',
      name: 'Alex',
      party_id: 'h1',
      sort_order: 1,
      archived: false,
      is_admin: true,
      has_pin: true,
    },
  ],
  nets: [],
  last_settled_at: null,
  me: { device_id: 'd', person_id: 'p1', party_id: 'h1' },
};

const entry: Entry = {
  id: 'e',
  kind: 'expense',
  description: 'Hydro',
  entry_date: `${year}-10-01`,
  total_cents: 10000,
  paid_by_party_id: 'h1',
  paid_by_person_id: 'p1',
  split_type: 'third',
  split_num: null,
  split_den: null,
  split_inputs: null,
  recurring_bill_id: null,
  bill_period: null,
  settles: false,
  created_by_person_id: 'p1',
  created_at: '',
  updated_at: '',
  deleted_at: null,
  deleted_by_person_id: null,
  shares: [],
};

describe('splitLabel', () => {
  it.each([
    [{ split_type: 'third', split_num: null, split_den: null }, '1/3'],
    [{ split_type: 'half', split_num: null, split_den: null }, '1/2'],
    [{ split_type: 'all', split_num: null, split_den: null }, 'All'],
    [{ split_type: 'fraction', split_num: 2, split_den: 5 }, '2/5'],
    [{ split_type: 'percent', split_num: 4000, split_den: null }, '40%'],
    [{ split_type: 'percent', split_num: 3333, split_den: null }, '33.33%'],
    [{ split_type: 'percent', split_num: 1250, split_den: null }, '12.5%'],
    [{ split_type: 'amount', split_num: 3500, split_den: null }, '$35.00'],
  ] as const)('%j is %s', (split, label) => {
    expect(splitLabel(split)).toBe(label);
  });
});

describe('percentText', () => {
  it('never shows trailing zeros', () => {
    expect([percentText(10000), percentText(5), percentText(10)]).toEqual([
      '100%',
      '0.05%',
      '0.1%',
    ]);
  });
});

describe('describeChanges', () => {
  const view = new GroupView(summary);

  it('lists only what changed, in plain words', () => {
    const after: Entry = {
      ...entry,
      total_cents: 12000,
      split_type: 'half',
      entry_date: `${year}-10-02`,
    };
    expect(describeChanges(view, entry, after)).toEqual([
      'Amount: $100.00 → $120.00',
      'Date: Oct 1 → Oct 2',
      'Split: 1/3 → 1/2',
    ]);
  });

  it('names households and people', () => {
    const after: Entry = { ...entry, paid_by_party_id: 'h2', paid_by_person_id: null };
    expect(describeChanges(view, entry, after)).toEqual([
      'Paid by: Main floor → Basement',
      'Person who paid: Alex → not specified',
    ]);
  });

  it('is empty when nothing changed', () => {
    expect(describeChanges(view, entry, { ...entry })).toEqual([]);
  });
});
