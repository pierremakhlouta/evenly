import { formatDay, today } from '../../dates';
import { householdBalance } from '../../money/balance';
import { formatCents } from '../../money/format';
import type { AppContext } from '../app';
import { entryRow } from '../components/entry-row';
import { h } from '../dom';
import { messageOf } from '../errors';
import { icon } from '../icons';
import type { GroupView } from '../state';
import { openExpenseSheet } from './expense';
import { openPaymentSheet } from './payment';

/** The balance card, phrased from this phone's household. */
function balanceCard(view: GroupView): HTMLElement {
  const nets = view.summary.nets.map((n) => ({ partyId: n.party_id, netCents: n.net_cents }));
  const myParty = view.myPartyId ?? '';

  if (view.mode !== 'households') {
    // People mode gets its own balance screen in Phase 8.
    const mine = nets.find((n) => n.partyId === myParty)?.netCents ?? 0;
    return h(
      'section',
      { class: 'card balance' },
      h('p', { class: 'balance-label' }, mine >= 0 ? "You're owed" : 'You owe'),
      h('p', { class: 'balance-amount money' }, formatCents(Math.abs(mine))),
    );
  }

  const other = view.partyName(view.otherPartyId);
  const balance = householdBalance(nets, myParty);
  const label =
    balance.direction === 'they_owe_you'
      ? `${other} owes you`
      : balance.direction === 'you_owe_them'
        ? `You owe ${other}`
        : 'All settled up';

  return h(
    'section',
    { class: `card balance balance-${balance.direction}`, 'aria-live': 'polite' },
    h('p', { class: 'balance-label' }, label),
    h('p', { class: 'balance-amount money' }, formatCents(balance.cents)),
    h(
      'p',
      { class: 'balance-sub muted' },
      `${view.partyName(view.myPartyId)} · ${view.me?.name ?? ''}`,
    ),
  );
}

export function homeScreen(ctx: AppContext): HTMLElement {
  const { view, recent } = ctx;
  const lastSettled = view.summary.last_settled_at;
  const settledOn = lastSettled ? formatDay(today(new Date(lastSettled))) : null;
  // Automatic bills add themselves, so only shortcut bills get a button.
  const shortcuts =
    view.mode === 'households' ? ctx.bills.filter((b) => b.active && !b.auto_add) : [];

  const refreshButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Refresh',
      onclick: () => {
        refreshButton.classList.add('spinning');
        ctx.refresh().catch((e: unknown) => {
          refreshButton.classList.remove('spinning');
          alert(messageOf(e));
        });
      },
    },
    icon('refresh'),
  );

  return h(
    'main',
    { class: 'screen with-tabbar' },
    h('header', { class: 'topbar' }, h('h1', {}, view.summary.group.name), refreshButton),
    balanceCard(view),
    shortcuts.length
      ? h(
          'div',
          { class: 'bill-chips', role: 'group', 'aria-label': 'Saved bills' },
          shortcuts.map((bill) =>
            h(
              'button',
              {
                type: 'button',
                class: 'bill-chip',
                'data-write': true,
                onclick: () => {
                  openExpenseSheet(ctx, ctx.root, undefined, bill);
                },
              },
              bill.name,
            ),
          ),
        )
      : null,
    view.mode === 'households'
      ? h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary btn-block',
              'data-write': true,
              onclick: () => {
                openExpenseSheet(ctx, ctx.root);
              },
            },
            'Add expense',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-secondary btn-block',
              'data-write': true,
              onclick: () => {
                openPaymentSheet(ctx, ctx.root);
              },
            },
            'Record payment',
          ),
        )
      : null,
    h(
      'section',
      { class: 'stack' },
      h(
        'h2',
        { class: 'section-title' },
        settledOn ? `Since you settled up on ${settledOn}` : 'Recent',
      ),
      recent.length
        ? h(
            'div',
            { class: 'list' },
            recent.map((e) => entryRow(ctx, e)),
          )
        : h(
            'p',
            { class: 'empty' },
            settledOn
              ? 'Nothing new since you settled up.'
              : 'No entries yet. Add your first bill.',
          ),
      h('a', { class: 'btn btn-ghost', href: '#/history' }, 'See all history'),
    ),
  );
}
