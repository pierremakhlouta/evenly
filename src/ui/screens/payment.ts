/**
 * Record payment (household mode): one household paying the other back.
 *
 * "Use full balance" fills in the current balance in the right direction. Saving it
 * records a settle-up (settle_up), which ends the current period; any other amount
 * is a plain payment (add_entry). Changing the amount or direction afterwards turns
 * it back into a plain payment.
 */
import { addEntry, settleUp } from '../../api/rpc';
import { today } from '../../dates';
import { householdBalance } from '../../money/balance';
import { centsToInput, formatCents, parseAmountToCents } from '../../money/format';
import type { AppContext } from '../app';
import { busy, errorLine, field, fieldGroup, segmented } from '../components/forms';
import { openSheet } from '../components/sheet';
import { h, replace } from '../dom';
import { messageOf } from '../errors';

export function openPaymentSheet(ctx: AppContext, root: HTMLElement): void {
  const { view } = ctx;
  const mine = view.myPartyId ?? '';
  const other = view.otherPartyId ?? '';
  const nets = view.summary.nets.map((n) => ({ partyId: n.party_id, netCents: n.net_cents }));
  const balance = householdBalance(nets, mine);

  // Default direction: whoever owes pays. 'out' = this household pays the other.
  let direction: 'out' | 'in' = balance.direction === 'they_owe_you' ? 'in' : 'out';
  let settling = false;

  const payer = () => (direction === 'out' ? mine : other);
  const receiver = () => (direction === 'out' ? other : mine);

  const amount = h('input', {
    class: 'input money',
    name: 'amount',
    inputmode: 'decimal',
    autocomplete: 'off',
    placeholder: '0.00',
  });
  const note = h('input', {
    class: 'input',
    name: 'note',
    autocomplete: 'off',
    maxlength: 200,
    placeholder: 'Optional, e.g. E-transfer',
  });
  const date = h('input', { class: 'input', name: 'date', type: 'date', value: today() });
  const person = h('select', {
    class: 'input',
    name: 'person',
    'aria-label': 'Who sent it (person)',
  });
  const status = h('p', { class: 'preview', 'aria-live': 'polite' });
  const error = errorLine();
  const submit = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit', 'data-write': true },
    'Record payment',
  );

  const directionToggle = segmented<'out' | 'in'>(
    'Who paid who',
    [
      { value: 'out', label: `${view.partyName(mine)} paid` },
      { value: 'in', label: `${view.partyName(other)} paid` },
    ],
    direction,
    (value) => {
      direction = value;
      settling = false;
      fillPeople();
      update();
    },
  );

  const fillPeople = () => {
    person.replaceChildren(
      h('option', { value: '' }, 'Not specified'),
      ...view.peopleOf(payer()).map((p) => h('option', { value: p.id }, p.name)),
    );
    person.value = payer() === mine ? (view.me?.id ?? '') : '';
  };

  const selectDirection = (value: 'out' | 'in') => {
    direction = value;
    for (const button of directionToggle.querySelectorAll('button')) {
      button.setAttribute('aria-checked', String(button.dataset.value === value));
    }
    fillPeople();
  };

  const settleCard = h('div', { class: 'card stack settle-card' });
  if (balance.direction === 'settled') {
    replace(settleCard, h('p', { class: 'muted' }, "You're all settled up. Nothing to pay back."));
  } else {
    const debtorName = view.partyName(balance.direction === 'they_owe_you' ? other : mine);
    const creditorName = view.partyName(balance.direction === 'they_owe_you' ? mine : other);
    replace(
      settleCard,
      h(
        'p',
        {},
        `${debtorName} owes ${creditorName} `,
        h('strong', { class: 'money' }, formatCents(balance.cents)),
        '.',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary btn-block',
          onclick: () => {
            selectDirection(balance.direction === 'they_owe_you' ? 'in' : 'out');
            amount.value = centsToInput(balance.cents);
            settling = true;
            update();
          },
        },
        'Settle full balance',
      ),
    );
  }

  function update() {
    const cents = parseAmountToCents(amount.value);
    submit.textContent = settling ? 'Settle up' : 'Record payment';
    if (settling) {
      status.textContent = `${view.partyName(payer())} pays ${view.partyName(receiver())} ${formatCents(balance.cents)}. This settles up and starts a new period.`;
    } else if (cents === null || cents === 0) {
      status.textContent = 'Enter the amount that was sent.';
    } else {
      status.textContent = `${view.partyName(payer())} paid ${view.partyName(receiver())} ${formatCents(cents)}.`;
    }
  }

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      oninput: (event: Event) => {
        // Typing a different amount turns a settle-up back into a plain payment.
        if (
          event.target === amount &&
          settling &&
          parseAmountToCents(amount.value) !== balance.cents
        )
          settling = false;
        update();
      },
      onsubmit: (event: Event) => {
        event.preventDefault();
        error.clear();
        const cents = parseAmountToCents(amount.value);
        if (cents === null || cents === 0) {
          error.show('Enter the amount that was sent.');
          return;
        }
        if (!date.value) {
          error.show('Pick a date.');
          return;
        }
        void busy(submit, 'Saving…', async () => {
          try {
            if (settling) {
              await settleUp({
                expectedCents: balance.cents,
                entryDate: date.value,
                note: note.value.trim(),
                paidByPersonId: person.value || null,
              });
            } else {
              await addEntry('payment', {
                description: note.value.trim(),
                entry_date: date.value,
                total_cents: cents,
                paid_by_party_id: payer(),
                paid_by_person_id: person.value || null,
                to_party_id: receiver(),
              });
            }
            sheet.close();
            await ctx.refresh();
          } catch (e) {
            error.show(messageOf(e));
          }
        });
      },
    },
    settleCard,
    fieldGroup('Who paid who', directionToggle),
    person,
    field('Amount', amount),
    status,
    field('Note', note),
    field('Date', date),
    error.el,
    submit,
  );

  fillPeople();
  update();
  const sheet = openSheet(root, 'Record payment', form);
}
