/**
 * People mode: add or edit an expense split between any of the group's people.
 * Defaults to everyone, equally. The preview shows each person's share and what it
 * means for this phone's person.
 */
import { addEntry, editEntry } from '../../api/rpc';
import type {
  Entry,
  EntryInput,
  PeopleSplitType,
  RecurringBill,
  SplitInput,
} from '../../api/types';
import { today } from '../../dates';
import { netChange } from '../../money/balance';
import { centsToInput, formatCents, parseAmountToCents } from '../../money/format';
import type { AppContext } from '../app';
import { busy, errorLine, field } from '../components/forms';
import { peopleSplit, peopleSplitMessage } from '../components/people-split';
import { openSheet } from '../components/sheet';
import { amountInput } from '../components/split-picker';
import { h } from '../dom';
import { messageOf } from '../errors';

function initialSplit(source: Entry | RecurringBill | undefined) {
  if (!source?.split_inputs || !source.split_type) return null;
  return { split_type: source.split_type as PeopleSplitType, split_inputs: source.split_inputs };
}

export function openPeopleExpenseSheet(
  ctx: AppContext,
  root: HTMLElement,
  existing?: Entry,
  bill?: RecurringBill,
): void {
  const { view } = ctx;
  const me = view.myPartyId ?? '';
  const source = existing ?? bill;
  const parties = view.activeParties;

  const description = h('input', {
    class: 'input',
    name: 'description',
    autocomplete: 'off',
    maxlength: 200,
    placeholder: 'e.g. Groceries, Gas',
    value: existing?.description ?? bill?.name,
  });
  const amount = amountInput('amount');
  const startTotal = existing?.total_cents ?? bill?.default_total_cents;
  if (startTotal) amount.value = centsToInput(startTotal);
  const payer = h(
    'select',
    { class: 'input', name: 'payer' },
    parties.map((p) => h('option', { value: p.id }, p.name)),
  );
  payer.value = source?.paid_by_party_id ?? me;
  const date = h('input', {
    class: 'input',
    name: 'date',
    type: 'date',
    value: existing?.entry_date ?? today(),
  });
  const preview = h('p', { class: 'preview', 'aria-live': 'polite' });
  const error = errorLine();
  const submit = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit', 'data-write': true },
    existing ? 'Save changes' : 'Add expense',
  );
  const split = peopleSplit(parties, initialSplit(source), () => {
    update();
  });

  function update() {
    error.clear();
    const result = split.read(parseAmountToCents(amount.value));
    preview.classList.remove('preview-error');
    if ('error' in result) {
      preview.textContent =
        result.error === 'incomplete'
          ? 'Enter the amount to see who owes what.'
          : peopleSplitMessage(result.error);
      if (result.error !== 'incomplete') preview.classList.add('preview-error');
      return;
    }
    const change = netChange(
      {
        paidByPartyId: payer.value,
        totalCents: result.shares.reduce((a, s) => a + s.shareCents, 0),
        shares: result.shares,
      },
      me,
    );
    const payerName = view.partyName(payer.value);
    preview.textContent =
      change > 0
        ? `You're owed ${formatCents(change)}`
        : change < 0
          ? `You owe ${payerName} ${formatCents(-change)}`
          : "This doesn't change your balance";
  }

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      oninput: update,
      onchange: update,
      onsubmit: (event) => {
        event.preventDefault();
        const total = parseAmountToCents(amount.value);
        if (!description.value.trim()) {
          error.show('Add a short description.');
          return;
        }
        if (!total) {
          error.show('Enter the amount.');
          return;
        }
        const result = split.read(total);
        if ('error' in result) {
          error.show(peopleSplitMessage(result.error));
          return;
        }
        if (!date.value) {
          error.show('Pick a date.');
          return;
        }
        void busy(submit, 'Saving…', async () => {
          try {
            const input: EntryInput = {
              description: description.value.trim(),
              entry_date: date.value,
              total_cents: total,
              paid_by_party_id: payer.value,
              paid_by_person_id:
                view.summary.people.find((p) => p.party_id === payer.value)?.id ?? null,
              split_type: result.split_type,
              split_inputs: result.split_inputs satisfies SplitInput[],
            };
            if (existing) await editEntry(existing.id, input);
            else await addEntry('expense', input);
            sheet.close();
            await ctx.refresh();
          } catch (e) {
            error.show(messageOf(e));
          }
        });
      },
    },
    field('Description', description),
    field('Amount', amount),
    field('Paid by', payer),
    split.el,
    preview,
    field('Date', date),
    error.el,
    submit,
  );

  update();
  const sheet = openSheet(root, existing ? 'Edit expense' : bill ? bill.name : 'Add expense', form);
  if (bill) amount.focus();
  else if (!existing) description.focus();
}
