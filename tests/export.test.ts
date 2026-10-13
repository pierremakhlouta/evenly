import { describe, expect, it } from 'vitest';
import type { Entry, Summary } from '../src/api/types';
import { csvField, toCsv } from '../src/export';
import { GroupView } from '../src/ui/state';

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

const base: Entry = {
  id: 'e1',
  kind: 'expense',
  description: 'Hydro',
  entry_date: '2026-10-05',
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
  created_at: '2026-10-05T16:00:00Z',
  updated_at: '2026-10-05T16:00:00Z',
  deleted_at: null,
  deleted_by_person_id: null,
  shares: [
    { party_id: 'h1', share_cents: 6667 },
    { party_id: 'h2', share_cents: 3334 },
  ],
};

describe('csvField', () => {
  it.each([
    ['plain', 'plain'],
    ['a, b', '"a, b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-5', "'-5"],
    ['@cmd', "'@cmd"],
  ])('%j becomes %j', (input, output) => {
    expect(csvField(input)).toBe(output);
  });
});

describe('toCsv', () => {
  const view = new GroupView(summary);

  it('writes a header with one share column per household', () => {
    expect(toCsv(view, []).split('\r\n')[0]).toBe(
      'Date,Description,Type,Total,Paid by,Paid by person,Split,Main floor share,Basement share,Added by,Added at,Deleted,Deleted at',
    );
  });

  it('writes an expense with exact decimal amounts', () => {
    expect(toCsv(view, [base]).split('\r\n')[1]).toBe(
      '2026-10-05,Hydro,Expense,100.01,Main floor,Alex,1/3,66.67,33.34,Alex,2026-10-05T16:00:00Z,No,',
    );
  });

  it('marks settle-ups, automatic and deleted entries', () => {
    const settle: Entry = {
      ...base,
      kind: 'payment',
      description: 'E-transfer, October',
      settles: true,
      split_type: null,
      paid_by_party_id: 'h2',
      paid_by_person_id: null,
      created_by_person_id: null,
      deleted_at: '2026-11-01T12:00:00Z',
      shares: [{ party_id: 'h1', share_cents: 3334 }],
    };
    expect(toCsv(view, [settle]).split('\r\n')[1]).toBe(
      '2026-10-05,"E-transfer, October",Settle-up,100.01,Basement,,,33.34,,Automatically,2026-10-05T16:00:00Z,Yes,2026-11-01T12:00:00Z',
    );
  });
});
