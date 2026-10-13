/** People mode: record (or edit) one person paying another back. */
import { addEntry, editEntry } from '../../api/rpc';
import type { Entry, EntryInput } from '../../api/types';
import { today } from '../../dates';
import { centsToInput, formatCents, parseAmountToCents } from '../../money/format';
import type { AppContext } from '../app';
import { busy, errorLine, field } from '../components/forms';
import { openSheet } from '../components/sheet';
import { amountInput } from '../components/split-picker';
import { h } from '../dom';
import { messageOf } from '../errors';

export function openPeoplePaymentSheet(
  ctx: AppContext,
  root: HTMLElement,
  existing?: Entry,
  suggestion?: { from: string; to: string; cents: number },
): void {
  const { view } = ctx;
  const parties = view.activeParties;
  const select = (name: string, value: string) => {
    const el = h(
      'select',
      { class: 'input', name },
      parties.map((p) => h('option', { value: p.id }, p.name)),
    );
    el.value = value;
    return el;
  };
  const me = view.myPartyId ?? '';
  const from = select('from', existing?.paid_by_party_id ?? suggestion?.from ?? me);
  const to = select(
    'to',
    existing?.shares[0]?.party_id ??
      suggestion?.to ??
      parties.find((p) => p.id !== from.value)?.id ??
      '',
  );
  const amount = amountInput('amount');
  const startCents = existing?.total_cents ?? suggestion?.cents;
  if (startCents) amount.value = centsToInput(startCents);
  const note = h('input', {
    class: 'input',
    name: 'note',
    autocomplete: 'off',
    maxlength: 200,
    placeholder: 'Optional, e.g. E-transfer',
    value: existing?.description,
  });
  const date = h('input', {
    class: 'input',
    name: 'date',
    type: 'date',
    value: existing?.entry_date ?? today(),
  });
  const status = h('p', { class: 'preview', 'aria-live': 'polite' });
  const error = errorLine();
  const submit = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit', 'data-write': true },
    existing ? 'Save changes' : 'Record payment',
  );

  const update = () => {
    error.clear();
    const cents = parseAmountToCents(amount.value);
    status.textContent =
      from.value === to.value
        ? 'Pick two different people.'
        : cents
          ? `${view.partyName(from.value)} paid ${view.partyName(to.value)} ${formatCents(cents)}.`
          : 'Enter the amount that was sent.';
  };

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      oninput: update,
      onchange: update,
      onsubmit: (event) => {
        event.preventDefault();
        const cents = parseAmountToCents(amount.value);
        if (from.value === to.value) {
          error.show('Pick two different people.');
          return;
        }
        if (!cents) {
          error.show('Enter the amount that was sent.');
          return;
        }
        void busy(submit, 'Saving…', async () => {
          try {
            const input: EntryInput = {
              description: note.value.trim(),
              entry_date: date.value,
              total_cents: cents,
              paid_by_party_id: from.value,
              paid_by_person_id:
                view.summary.people.find((p) => p.party_id === from.value)?.id ?? null,
              to_party_id: to.value,
            };
            if (existing) await editEntry(existing.id, input);
            else await addEntry('payment', input);
            sheet.close();
            await ctx.refresh();
          } catch (e) {
            error.show(messageOf(e));
          }
        });
      },
    },
    field('From', from),
    field('To', to),
    field('Amount', amount),
    status,
    field('Note', note),
    field('Date', date),
    error.el,
    submit,
  );

  update();
  const sheet = openSheet(root, existing ? 'Edit payment' : 'Record payment', form);
}
