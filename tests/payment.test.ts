// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Summary } from '../src/api/types';
import type { AppContext } from '../src/ui/app';
import { openPaymentSheet } from '../src/ui/screens/payment';
import { GroupView } from '../src/ui/state';

function summary(myNet: number): Summary {
  return {
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
    nets: [
      { party_id: 'h1', net_cents: myNet },
      { party_id: 'h2', net_cents: -myNet },
    ],
    last_settled_at: null,
    me: { device_id: 'd', person_id: 'p1', party_id: 'h1' },
  };
}

let root: HTMLElement;
const open = (myNet: number) => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  const ctx = {
    root,
    view: new GroupView(summary(myNet)),
    recent: [],
    refresh: () => Promise.resolve(),
    leave: () => undefined,
    switchPerson: () => undefined,
  } satisfies AppContext;
  openPaymentSheet(ctx, root);
};
const button = (label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label);
const checked = () =>
  root.querySelector('[aria-label="Who paid who"] [aria-checked="true"]')?.textContent;
const amount = () => root.querySelector<HTMLInputElement>('[name="amount"]');

describe('Record payment sheet', () => {
  beforeEach(() => {
    open(70466);
  });

  it('shows the balance and defaults to the household that owes paying', () => {
    expect(root.querySelector('.settle-card p')?.textContent).toBe(
      'Basement owes Main floor $704.66.',
    );
    expect(checked()).toBe('Basement paid');
  });

  it('Settle full balance fills the exact amount and switches to settling up', () => {
    button('Settle full balance')?.click();
    expect(amount()?.value).toBe('704.66');
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe('Settle up');
    expect(root.querySelector('.preview')?.textContent).toBe(
      'Basement pays Main floor $704.66. This settles up and starts a new period.',
    );
  });

  it('a different amount is a plain payment again', () => {
    button('Settle full balance')?.click();
    const input = amount();
    if (!input) throw new Error('no amount');
    input.value = '500';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe('Record payment');
    expect(root.querySelector('.preview')?.textContent).toBe('Basement paid Main floor $500.00.');
  });

  it('when this household owes, it defaults to paying', () => {
    open(-4000);
    expect(checked()).toBe('Main floor paid');
    expect(root.querySelector('.settle-card p')?.textContent).toBe(
      'Main floor owes Basement $40.00.',
    );
  });

  it('says so when everyone is settled', () => {
    open(0);
    expect(root.querySelector('.settle-card p')?.textContent).toBe(
      "You're all settled up. Nothing to pay back.",
    );
    expect(button('Settle full balance')).toBeUndefined();
  });
});
