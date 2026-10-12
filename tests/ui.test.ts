// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Summary } from '../src/api/types';
import { currentTab } from '../src/ui/app';
import { h } from '../src/ui/dom';
import { GroupView } from '../src/ui/state';

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
