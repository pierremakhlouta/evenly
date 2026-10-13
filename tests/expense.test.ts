// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Summary } from '../src/api/types';
import { fakeContext } from './helpers';
import { initialShare, openExpenseSheet, readSplit, splitColumns } from '../src/ui/screens/expense';

const blank = { amount: '', num: '', den: '', percent: '' };

describe('readSplit', () => {
  it('reads the quick chips', () => {
    expect(readSplit('third', 'amount', blank)).toEqual({ type: 'third' });
    expect(readSplit('all', 'amount', blank)).toEqual({ type: 'all' });
  });

  it('reads a $ amount as cents', () => {
    expect(readSplit('more', 'amount', { ...blank, amount: '35' })).toEqual({
      type: 'amount',
      amountCents: 3500,
    });
  });

  it('reads a fraction', () => {
    expect(readSplit('more', 'fraction', { ...blank, num: '2', den: '5' })).toEqual({
      type: 'fraction',
      num: 2,
      den: 5,
    });
  });

  it('reads a percent with decimals as basis points', () => {
    expect(readSplit('more', 'percent', { ...blank, percent: '33.33' })).toEqual({
      type: 'percent',
      basisPoints: 3333,
    });
    expect(readSplit('more', 'percent', { ...blank, percent: '40%' })).toEqual({
      type: 'percent',
      basisPoints: 4000,
    });
  });

  it('returns null until the custom share is filled in', () => {
    expect(readSplit('more', 'amount', blank)).toBeNull();
    expect(readSplit('more', 'fraction', { ...blank, num: '1' })).toBeNull();
    expect(readSplit('more', 'percent', { ...blank, percent: 'abc' })).toBeNull();
  });
});

describe('splitColumns', () => {
  it('maps each split to the database columns', () => {
    expect(splitColumns({ type: 'half' })).toEqual({ split_type: 'half' });
    expect(splitColumns({ type: 'fraction', num: 2, den: 5 })).toEqual({
      split_type: 'fraction',
      split_num: 2,
      split_den: 5,
    });
    expect(splitColumns({ type: 'percent', basisPoints: 4000 })).toEqual({
      split_type: 'percent',
      split_num: 4000,
    });
    expect(splitColumns({ type: 'amount', amountCents: 3500 })).toEqual({
      split_type: 'amount',
      split_num: 3500,
    });
  });
});

describe('Add expense sheet', () => {
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
  let root: HTMLElement;

  const type = (name: string, value: string) => {
    const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!input) throw new Error(`No input ${name}`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const tap = (groupLabel: string, label: string) => {
    const group = root.querySelector(`[role="radiogroup"][aria-label="${groupLabel}"]`);
    const button = [...(group?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === label,
    );
    if (!button) throw new Error(`No option ${label}`);
    button.click();
  };
  const text = (selector: string) => root.querySelector(selector)?.textContent;

  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    const ctx = fakeContext(summary, root);
    openExpenseSheet(ctx, root);
  });

  it('defaults to this household paying a third, worded from this phone', () => {
    type('amount', '100.01');
    expect(text('.field[aria-label="Share"] .field-label')).toBe('Their share');
    expect(text('.preview')).toBe('Basement owes you $33.34');
  });

  it('dinner $90, I paid, their share $35', () => {
    type('amount', '90');
    tap('Share', 'More');
    type('share-amount', '35');
    expect(text('.preview')).toBe('Basement owes you $35.00');
  });

  it('dinner $90, they paid, my share $40', () => {
    type('amount', '90');
    tap('Who paid', 'Basement');
    tap('Share', 'More');
    type('share-amount', '40');
    expect(text('.field[aria-label="Share"] .field-label')).toBe('Your share');
    expect(text('.preview')).toBe('You owe Basement $40.00');
  });

  it('explains a share larger than the total', () => {
    type('amount', '90');
    tap('Share', 'More');
    type('share-amount', '95');
    expect(text('.preview')).toBe('That share is more than the total.');
  });

  it("lists the paying household's people and defaults to me", () => {
    const select = root.querySelector<HTMLSelectElement>('[name="person"]');
    expect(select?.value).toBe('p1');
    tap('Who paid', 'Basement');
    expect([...(select?.options ?? [])].map((o) => o.textContent)).toEqual([
      'Not specified',
      'Sam',
    ]);
    expect(select?.value).toBe('');
  });
});

describe('initialShare', () => {
  it.each([
    [{ split_type: 'third', split_num: null, split_den: null }, { chip: 'third' }],
    [{ split_type: 'half', split_num: null, split_den: null }, { chip: 'half' }],
    [{ split_type: 'all', split_num: null, split_den: null }, { chip: 'all' }],
    [
      { split_type: 'amount', split_num: 3500, split_den: null },
      { chip: 'more', more: 'amount', amount: '35.00' },
    ],
    [
      { split_type: 'fraction', split_num: 2, split_den: 5 },
      { chip: 'more', more: 'fraction', num: '2', den: '5' },
    ],
    [
      { split_type: 'percent', split_num: 4000, split_den: null },
      { chip: 'more', more: 'percent', percent: '40' },
    ],
    [
      { split_type: 'percent', split_num: 3333, split_den: null },
      { chip: 'more', more: 'percent', percent: '33.33' },
    ],
  ] as const)('%j', (entry, expected) => {
    expect(initialShare(entry)).toMatchObject(expected);
  });

  it('round-trips through readSplit', () => {
    const entry = { split_type: 'percent', split_num: 1250, split_den: null } as const;
    const s = initialShare(entry);
    expect(readSplit(s.chip, s.more, s)).toEqual({ type: 'percent', basisPoints: 1250 });
  });
});
