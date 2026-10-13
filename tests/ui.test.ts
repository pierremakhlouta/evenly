// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Summary } from '../src/api/types';
import { currentTab } from '../src/ui/app';
import { h } from '../src/ui/dom';
import { today } from '../src/dates';
import { billSummary, ordinal } from '../src/ui/screens/bill';
import { dateRange } from '../src/ui/screens/history';
import { GroupView } from '../src/ui/state';

const thisYear = today().slice(0, 4);

describe('h()', () => {
  it('treats user text as text, never as HTML', () => {
    const el = h('p', {}, '<img src=x onerror="alert(1)">');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it('sets attributes, classes and event handlers, and skips empty values', () => {
    let clicks = 0;
    const el = h('button', {
      class: 'btn',
      type: 'button',
      disabled: false,
      'aria-label': null,
      onclick: () => {
        clicks += 1;
      },
    });
    el.click();
    expect([
      el.className,
      el.getAttribute('type'),
      el.hasAttribute('disabled'),
      el.hasAttribute('aria-label'),
      clicks,
    ]).toEqual(['btn', 'button', false, false, 1]);
  });
});

describe('currentTab', () => {
  it.each([
    ['', 'home'],
    ['#/home', 'home'],
    ['#/history', 'history'],
    ['#/settings', 'settings'],
    ['#/history/open', 'history'],
    ['#/history/2026-09-30T20%3A00%3A00%2B00%3A00', 'history'],
    ['#/nonsense', 'home'],
  ])('%j opens %s', (hash, tab) => {
    expect(currentTab(hash)).toBe(tab);
  });
});

describe('GroupView', () => {
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
      {
        id: 'p3',
        name: 'Old',
        party_id: 'h2',
        sort_order: 3,
        archived: true,
        is_admin: false,
        has_pin: false,
      },
    ],
    nets: [],
    last_settled_at: null,
    me: { device_id: 'd', person_id: 'p1', party_id: 'h1' },
  };
  const view = new GroupView(summary);

  it('knows this phone and the other household', () => {
    expect([view.me?.name, view.myPartyId, view.otherPartyId]).toEqual(['Alex', 'h1', 'h2']);
  });

  it('lists only active people of a household', () => {
    expect(view.peopleOf('h2').map((p) => p.name)).toEqual(['Sam']);
  });

  it('needs an active person', () => {
    expect(view.hasPerson).toBe(true);
    expect(new GroupView({ ...summary, me: { ...summary.me, person_id: 'p3' } }).hasPerson).toBe(
      false,
    );
    expect(new GroupView({ ...summary, me: { ...summary.me, person_id: null } }).hasPerson).toBe(
      false,
    );
  });
});

describe('dateRange', () => {
  const period = (first: string | null, last: string | null) => ({
    created_after: null,
    entry_count: 0,
    first_date: first,
    last_date: last,
  });

  it('shows the first and last entry dates', () => {
    expect(dateRange(period(`${thisYear}-09-01`, `${thisYear}-09-30`))).toBe('Sep 1 to Sep 30');
  });

  it('shows one date when they are the same', () => {
    expect(dateRange(period(`${thisYear}-09-30`, `${thisYear}-09-30`))).toBe('Sep 30');
  });

  it('is empty for an empty period', () => {
    expect(dateRange(period(null, null))).toBe('');
  });
});

describe('bill wording', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [28, '28th'],
  ])('%i is %s', (n, text) => {
    expect(ordinal(n)).toBe(text);
  });

  const bill = {
    id: 'b',
    name: 'Rent',
    paid_by_party_id: 'h1',
    split_type: 'third' as const,
    split_num: null,
    split_den: null,
    split_inputs: null,
    default_total_cents: 240000,
    auto_add: true,
    day_of_month: 1,
    active: true,
    sort_order: 1,
  };

  it('summarises automatic bills and shortcuts', () => {
    expect(billSummary(bill)).toBe('Added on the 1st · $2,400.00');
    expect(billSummary({ ...bill, auto_add: false })).toBe('Shortcut · $2,400.00');
    expect(billSummary({ ...bill, auto_add: false, default_total_cents: null })).toBe('Shortcut');
  });
});
