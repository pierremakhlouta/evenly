/**
 * People mode on Home: everyone's balance, and the fewest payments that settle the
 * whole group (src/money/simplify.ts), with Settle up to record them all at once.
 */
import { settleUpAll, type SettlePayment } from '../../api/rpc';
import { today } from '../../dates';
import { formatCents } from '../../money/format';
import { simplifyDebts } from '../../money/simplify';
import type { AppContext } from '../app';
import { busy, errorLine, field } from '../components/forms';
import { openSheet } from '../components/sheet';
import { h } from '../dom';
import { messageOf } from '../errors';
import { openPeoplePaymentSheet } from './people-payment';

/** The suggested payments, in the order the database will compute them. */
export function suggestedPayments(ctx: AppContext): SettlePayment[] {
  return simplifyDebts(
    ctx.view.summary.nets.map((n) => ({ partyId: n.party_id, netCents: n.net_cents })),
  ).map((p) => ({ from: p.fromPartyId, to: p.toPartyId, cents: p.cents }));
}

function openSettleSheet(ctx: AppContext, payments: SettlePayment[]): void {
  const { view } = ctx;
  const note = h('input', {
    class: 'input',
    name: 'note',
    autocomplete: 'off',
    maxlength: 200,
    placeholder: 'Optional, e.g. E-transfers',
  });
  const date = h('input', { class: 'input', name: 'date', type: 'date', value: today() });
  const error = errorLine();
  const submit = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit', 'data-write': true },
    'Settle up',
  );
  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        void busy(submit, 'Settling…', async () => {
          try {
            await settleUpAll({
              expected: payments,
              entryDate: date.value,
              note: note.value.trim(),
            });
            sheet.close();
            await ctx.refresh();
          } catch (e) {
            error.show(messageOf(e));
          }
        });
      },
    },
    h('p', {}, 'These payments settle everyone. Record them once they have been sent.'),
    h(
      'div',
      { class: 'list' },
      payments.map((p) =>
        h(
          'div',
          { class: 'list-item' },
          h('span', {}, `${view.partyName(p.from)} pays ${view.partyName(p.to)}`),
          h('span', { class: 'money' }, formatCents(p.cents)),
        ),
      ),
    ),
    field('Note', note),
    field('Date', date),
    error.el,
    submit,
  );
  const sheet = openSheet(ctx.root, 'Settle up', form);
}

export function peopleBalances(ctx: AppContext): HTMLElement {
  const { view } = ctx;
  const me = view.myPartyId;
  const payments = suggestedPayments(ctx);
  const nets = [...view.summary.nets].filter(
    (n) => !view.party(n.party_id)?.archived || n.net_cents !== 0,
  );

  const paymentRow = (p: SettlePayment) =>
    h(
      'button',
      {
        type: 'button',
        class: `list-item chevron ${p.from === me || p.to === me ? 'mine' : ''}`,
        'data-write': true,
        onclick: () => {
          openPeoplePaymentSheet(ctx, ctx.root, undefined, p);
        },
      },
      h('span', {}, `${view.partyName(p.from)} pays ${view.partyName(p.to)}`),
      h('span', { class: 'money' }, formatCents(p.cents)),
    );

  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'stack' },
      h('h2', { class: 'section-title' }, 'Everyone'),
      h(
        'div',
        { class: 'list' },
        nets.map((n) =>
          h(
            'div',
            { class: 'list-item' },
            h(
              'span',
              {},
              n.party_id === me
                ? `${view.partyName(n.party_id)} (you)`
                : view.partyName(n.party_id),
            ),
            h(
              'span',
              { class: 'money muted' },
              n.net_cents > 0
                ? `owed ${formatCents(n.net_cents)}`
                : n.net_cents < 0
                  ? `owes ${formatCents(-n.net_cents)}`
                  : 'settled',
            ),
          ),
        ),
      ),
    ),
    payments.length
      ? h(
          'section',
          { class: 'stack' },
          h('h2', { class: 'section-title' }, 'To settle up'),
          h('div', { class: 'list' }, payments.map(paymentRow)),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-secondary btn-block',
              'data-write': true,
              onclick: () => {
                openSettleSheet(ctx, payments);
              },
            },
            'Settle up everyone',
          ),
          h('p', { class: 'field-hint' }, 'Tap a payment to record just that one.'),
        )
      : null,
  );
}
