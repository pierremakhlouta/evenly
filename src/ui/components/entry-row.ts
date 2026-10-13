/** How an entry is named and summed up in lists and in its details sheet. */
import type { Entry } from '../../api/types';
import { formatDay } from '../../dates';
import { netChange } from '../../money/balance';
import { formatCents } from '../../money/format';
import type { AppContext } from '../app';
import { h } from '../dom';
import type { GroupView } from '../state';

/** 'Hydro', 'Payment: E-transfer', 'Settled up'. */
export function entryTitle(entry: Entry): string {
  if (entry.kind === 'expense') return entry.description;
  const kind = entry.settles ? 'Settled up' : 'Payment';
  return entry.description ? `${kind}: ${entry.description}` : kind;
}

/** Who paid: the person if one was recorded, otherwise the household. */
export function payerName(view: GroupView, entry: Entry): string {
  return entry.paid_by_person_id
    ? view.personName(entry.paid_by_person_id)
    : view.partyName(entry.paid_by_party_id);
}

/** What this entry did to this phone's balance, in words. */
export function effectText(view: GroupView, entry: Entry): string {
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

/** A tappable row that opens the entry's details. */
export function entryRow(ctx: AppContext, entry: Entry): HTMLElement {
  const { view } = ctx;
  const who =
    entry.kind === 'payment'
      ? `${payerName(view, entry)} paid ${view.partyName(entry.shares[0]?.party_id)}`
      : `Paid by ${payerName(view, entry)}`;

  return h(
    'button',
    {
      type: 'button',
      class: 'list-item entry-row',
      onclick: () => {
        ctx.openEntry(entry);
      },
    },
    h(
      'div',
      { class: 'entry-main' },
      h('span', { class: 'entry-title' }, entryTitle(entry)),
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
