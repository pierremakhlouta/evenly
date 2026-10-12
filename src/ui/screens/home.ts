import type { Entry } from '../../api/types';
import { formatDay } from '../../dates';
import { householdBalance, netChange } from '../../money/balance';
import { formatCents } from '../../money/format';
import type { AppContext } from '../app';
import { h } from '../dom';
import { messageOf } from '../errors';
import { icon } from '../icons';
import type { GroupView } from '../state';

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

/** Who paid: the person if one was recorded, otherwise the household. */
function payerName(view: GroupView, entry: Entry): string {
  return entry.paid_by_person_id
    ? view.personName(entry.paid_by_person_id)
    : view.partyName(entry.paid_by_party_id);
}

/** What this entry did to this phone's balance, in words. */
function effectText(view: GroupView, entry: Entry): string {
  const change = netChange(
    {
      paidByPartyId: entry.paid_by_party_id,
      totalCents: entry.total_cents,
      shares: entry.shares.map((s) => ({ partyId: s.party_id, shareCents: s.share_cents })),
    },
    view.myPartyId ?? '',
  );
  const amount = formatCents(Math.abs(change));
  if (entry.kind === 'payment') {
    return change > 0 ? `You paid ${amount}` : change < 0 ? `You got ${amount}` : 'Not yours';
  }
  return change > 0 ? `You're owed ${amount}` : change < 0 ? `You owe ${amount}` : 'Nothing owed';
}

export function entryRow(view: GroupView, entry: Entry): HTMLElement {
  const title =
    entry.kind === 'payment'
      ? entry.description
        ? `Payment: ${entry.description}`
        : 'Payment'
      : entry.description;
  const who =
    entry.kind === 'payment'
      ? `${payerName(view, entry)} paid ${view.partyName(entry.shares[0]?.party_id)}`
      : `Paid by ${payerName(view, entry)}`;

  return h(
    'div',
    { class: 'list-item entry-row' },
    h(
      'div',
      { class: 'entry-main' },
      h('span', { class: 'entry-title' }, title),
      h('span', { class: 'entry-meta muted' }, `${formatDay(entry.entry_date)} · ${who}`),
    ),
    h(
      'div',
      { class: 'entry-amounts' },
      h('span', { class: 'money entry-total' }, formatCents(entry.total_cents)),
      h('span', { class: 'money entry-effect muted' }, effectText(view, entry)),
    ),
  );
}

export function homeScreen(ctx: AppContext): HTMLElement {
  const { view, recent } = ctx;

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
    h(
      'section',
      { class: 'stack' },
      h('h2', { class: 'section-title' }, 'Recent'),
      recent.length
        ? h(
            'div',
            { class: 'list' },
            recent.map((e) => entryRow(view, e)),
          )
        : h('p', { class: 'empty' }, 'No entries yet. Add your first bill.'),
      recent.length
        ? h('a', { class: 'btn btn-ghost', href: '#/history' }, 'See all history')
        : null,
    ),
  );
}
