/**
 * Add or edit an expense in household mode.
 *
 * The form asks for the other household's share. The label and the live preview are
 * always worded from this phone's side and follow the "who paid" toggle:
 *   this household paid  -> "Their share", "Basement suite owes you $35.00"
 *   the other one paid   -> "Your share",  "You owe Main floor $40.00"
 * The preview uses the same split math as the database (src/money/split.ts).
 */
import { messageFor } from '../../api/errors';
import { addEntry, editEntry } from '../../api/rpc';
import type { Entry, EntryInput, RecurringBill } from '../../api/types';
import { today } from '../../dates';
import { centsToInput, formatCents, parseAmountToCents } from '../../money/format';
import { SplitError, splitHousehold } from '../../money/split';
import type { AppContext } from '../app';
import { busy, errorLine, field, fieldGroup, segmented } from '../components/forms';
import { openSheet } from '../components/sheet';
import { amountInput, splitColumns, splitPicker } from '../components/split-picker';
import { h } from '../dom';
import { messageOf } from '../errors';

/**
 * Opens Add expense. With `existing` it edits that entry; with `bill` (a saved bill
 * shortcut) it starts pre-filled with the bill's name, payer, split and usual amount.
 */
export function openExpenseSheet(
  ctx: AppContext,
  root: HTMLElement,
  existing?: Entry,
  bill?: RecurringBill,
): void {
  const { view } = ctx;
  const myParty = view.myPartyId ?? '';
  const otherParty = view.otherPartyId ?? '';
  const otherName = view.partyName(otherParty);
  const source = existing ?? bill;

  let payer = source?.paid_by_party_id ?? myParty;

  const description = h('input', {
    class: 'input',
    name: 'description',
    autocomplete: 'off',
    maxlength: 200,
    placeholder: 'e.g. Hydro, Dinner',
    value: existing?.description ?? bill?.name,
  });
  const amount = amountInput('amount');
  const startTotal = existing?.total_cents ?? bill?.default_total_cents;
  if (startTotal) amount.value = centsToInput(startTotal);
  const date = h('input', {
    class: 'input',
    name: 'date',
    type: 'date',
    value: existing?.entry_date ?? today(),
  });
  const person = h('select', { class: 'input', name: 'person', 'aria-label': 'Who paid (person)' });
  const preview = h('p', { class: 'preview', 'aria-live': 'polite' });
  const error = errorLine();
  const submit = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit', 'data-write': true },
    existing ? 'Save changes' : 'Add expense',
  );
  const split = splitPicker(source ?? null, () => {
    update();
  });

  /** People of the paying household. `keep` keeps an existing entry's payer, even if archived or moved. */
  const fillPeople = (keep?: string | null) => {
    const people = view.peopleOf(payer);
    const extra =
      keep && !people.some((p) => p.id === keep)
        ? [view.person(keep)].filter((p) => p !== undefined)
        : [];
    person.replaceChildren(
      h('option', { value: '' }, 'Not specified'),
      ...[...people, ...extra].map((p) => h('option', { value: p.id }, p.name)),
    );
    person.value = keep !== undefined ? (keep ?? '') : payer === myParty ? (view.me?.id ?? '') : '';
  };

  function update() {
    error.clear(); // an old error is stale once the form changes
    const iPaid = payer === myParty;
    split.setIPaid(iPaid);
    const total = parseAmountToCents(amount.value);
    const rule = split.read();
    if (total === null || total === 0 || rule === null) {
      preview.textContent = 'Enter the amount to see who owes what.';
      preview.classList.remove('preview-error');
      return;
    }
    try {
      const owed = formatCents(splitHousehold(total, rule).otherCents);
      preview.textContent = iPaid
        ? `${otherName} owes you ${owed}`
        : `You owe ${otherName} ${owed}`;
      preview.classList.remove('preview-error');
    } catch (e) {
      preview.textContent = e instanceof SplitError ? messageFor(e.code) : 'Check the amounts.';
      preview.classList.add('preview-error');
    }
  }

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      oninput: update,
      onsubmit: (event) => {
        event.preventDefault();
        error.clear();
        const total = parseAmountToCents(amount.value);
        const rule = split.read();
        if (!description.value.trim()) {
          error.show('Add a short description.');
          return;
        }
        if (total === null || total === 0) {
          error.show('Enter the amount.');
          return;
        }
        if (rule === null) {
          error.show('Fill in the share.');
          return;
        }
        try {
          splitHousehold(total, rule);
        } catch (e) {
          error.show(e instanceof SplitError ? messageFor(e.code) : 'Check the amounts.');
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
              paid_by_party_id: payer,
              paid_by_person_id: person.value || null,
              ...splitColumns(rule),
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
    fieldGroup(
      'Who paid',
      segmented(
        'Who paid',
        [
          { value: myParty, label: view.partyName(myParty) },
          { value: otherParty, label: otherName },
        ],
        payer,
        (value) => {
          payer = value;
          fillPeople();
          update();
        },
      ),
    ),
    person,
    split.el,
    preview,
    field('Date', date),
    error.el,
    submit,
  );

  fillPeople(existing ? existing.paid_by_person_id : undefined);
  update();
  const sheet = openSheet(root, existing ? 'Edit expense' : bill ? bill.name : 'Add expense', form);
  if (bill) amount.focus();
  else if (!existing) description.focus();
}
