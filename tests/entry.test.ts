// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Entry, Summary } from '../src/api/types';
import { configureRpc } from '../src/api/rpc';
import { today } from '../src/dates';
import { openEntrySheet } from '../src/ui/screens/entry';
import { fakeContext } from './helpers';

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
    {
      id: 'p2',
      name: 'Sam',
      party_id: 'h2',
      sort_order: 2,
      archived: false,
      is_admin: false,
      has_pin: true,
    },
  ],
  nets: [],
  last_settled_at: null,
  me: { device_id: 'd', person_id: 'p1', party_id: 'h1' },
};

const hydro: Entry = {
  id: 'e1',
  kind: 'expense',
  description: 'Hydro',
  entry_date: `${year}-10-05`,
  total_cents: 10001,
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
  created_at: `${year}-10-05T16:00:00Z`,
  updated_at: `${year}-10-05T16:00:00Z`,
  deleted_at: null,
  deleted_by_person_id: null,
  shares: [
    { party_id: 'h1', share_cents: 6667 },
    { party_id: 'h2', share_cents: 3334 },
  ],
};

let root: HTMLElement;
const open = (entry: Entry, onEdit?: (e: Entry) => void) => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  openEntrySheet(fakeContext(summary, root), entry, onEdit);
};
const buttons = () => [...root.querySelectorAll('.sheet-panel button')].map((b) => b.textContent);

describe('Entry details', () => {
  beforeEach(() => {
    configureRpc(null); // the change log request fails fast; these tests check the rest
  });

  it('shows the amounts, who paid, the split and each share', () => {
    open(hydro, () => undefined);
    const text = root.textContent;
    expect(root.querySelector('.sheet-title')?.textContent).toBe('Hydro');
    expect(root.querySelector('.detail-total')?.textContent).toBe('$100.01');
    expect(text).toContain("You're owed $33.34");
    expect(text).toContain('Paid byAlex');
    expect(text).toContain('Split1/3');
    expect(text).toContain('Main floor$66.67');
    expect(text).toContain('Basement$33.34');
    expect(buttons()).toEqual(['Cancel', 'Edit', 'Delete']);
  });

  it('a deleted entry says so and offers Restore instead', () => {
    open(
      { ...hydro, deleted_at: `${year}-10-06T16:00:00Z`, deleted_by_person_id: 'p2' },
      () => undefined,
    );
    expect(root.querySelector('.sheet-panel .error')?.textContent).toMatch(
      /^Deleted by Sam · Oct 6/,
    );
    expect(buttons()).toEqual(['Cancel', 'Restore']);
  });

  it('a settle-up cannot be edited, only deleted', () => {
    open(
      {
        ...hydro,
        kind: 'payment',
        description: 'E-transfer',
        settles: true,
        split_type: null,
        paid_by_party_id: 'h2',
        paid_by_person_id: 'p2',
        shares: [{ party_id: 'h1', share_cents: 10001 }],
      },
      () => undefined,
    );
    expect(root.querySelector('.sheet-title')?.textContent).toBe('Settled up: E-transfer');
    expect(root.textContent).toContain("A settle-up can't be edited.");
    expect(buttons()).toEqual(['Cancel', 'Delete']);
  });
});
