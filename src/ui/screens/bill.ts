/**
 * Add or edit a saved monthly bill (household mode). A bill is either a shortcut on
 * Home (pre-fills Add expense) or, with "Add automatically", an entry the database
 * adds every month on its day for its usual amount.
 */
import { messageFor } from '../../api/errors';
import { archiveRecurringBill, upsertRecurringBill } from '../../api/rpc';
import type { RecurringBill } from '../../api/types';
import { centsToInput, formatCents, parseAmountToCents } from '../../money/format';
import { SplitError, splitHousehold } from '../../money/split';
import type { AppContext } from '../app';
import { busy, errorLine, field, fieldGroup, segmented } from '../components/forms';
import { openSheet } from '../components/sheet';
import { amountInput, splitColumns, splitPicker } from '../components/split-picker';
import { h } from '../dom';
import { messageOf } from '../errors';

/** 1 -> '1st', 2 -> '2nd', 23 -> '23rd'. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
  return `${String(n)}${suffix}`;
}

/** 'Added on the 1st · $2,400.00' or 'Shortcut · $85.00' or 'Shortcut'. */
export function billSummary(bill: RecurringBill): string {
  const amount = bill.default_total_cents ? formatCents(bill.default_total_cents) : null;
  const kind = bill.auto_add ? `Added on the ${ordinal(bill.day_of_month)}` : 'Shortcut';
  return [kind, amount].filter(Boolean).join(' · ');
}

export function openBillSheet(ctx: AppContext, existing?: RecurringBill): void {
  const { view } = ctx;
  const myParty = view.myPartyId ?? '';
  const otherParty = view.otherPartyId ?? '';
  const otherName = view.partyName(otherParty);
  let payer = existing?.paid_by_party_id ?? myParty;

  const name = h('input', {
    class: 'input',
    name: 'name',
    autocomplete: 'off',
    maxlength: 80,
    placeholder: 'e.g. Rent, Hydro',
    value: existing?.name,
  });
  const amount = amountInput('usual-amount');
  if (existing?.default_total_cents) amount.value = centsToInput(existing.default_total_cents);
  const auto = h('input', {
    type: 'checkbox',
    name: 'auto',
    class: 'switch',
    checked: existing?.auto_add === true,
  });
  const day = h(
    'select',
    { class: 'input', name: 'day' },
    Array.from({ length: 28 }, (_, i) => h('option', { value: i + 1 }, `The ${ordinal(i + 1)}`)),
  );
  day.value = String(existing?.day_of_month ?? 1);
  const dayField = field('Day of the month', day, 'Up to the 28th, so every month has it.');
  const preview = h('p', { class: 'preview', 'aria-live': 'polite' });
  const error = errorLine();
  const submit = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit', 'data-write': true },
    existing?.active === false ? 'Save and restore' : existing ? 'Save changes' : 'Add bill',
  );
  const split = splitPicker(existing ?? null, () => {
    update();
  });

  function update() {
    error.clear(); // an old error is stale once the form changes
    const iPaid = payer === myParty;
    split.setIPaid(iPaid);
    dayField.hidden = !auto.checked;
    const total = parseAmountToCents(amount.value);
    const rule = split.read();
    preview.classList.remove('preview-error');
    if (rule === null) {
      preview.textContent = 'Fill in the share.';
      return;
    }
    if (!total) {
      preview.textContent = auto.checked
        ? 'Enter the usual amount so it can be added automatically.'
        : 'Each time, you type the amount and the split is filled in.';
      return;
    }
    try {
      const owed = formatCents(splitHousehold(total, rule).otherCents);
      const who = iPaid ? `${otherName} owes you ${owed}` : `You owe ${otherName} ${owed}`;
      preview.textContent = auto.checked
        ? `${who}, added on the ${ordinal(Number(day.value))} of every month.`
        : `${who} each time.`;
    } catch (e) {
      preview.textContent = e instanceof SplitError ? messageFor(e.code) : 'Check the amounts.';
      preview.classList.add('preview-error');
    }
  }

  const archive =
    existing?.active === true
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger btn-block',
            'data-write': true,
            onclick: () => {
              if (
                !confirm(
                  `Archive ${existing.name}? It leaves Home and stops being added. Past entries stay.`,
                )
              )
                return;
              void busy(archive as HTMLButtonElement, 'Archiving…', async () => {
                try {
                  await archiveRecurringBill(existing.id);
                  sheet.close();
                  await ctx.refresh();
                } catch (e) {
                  error.show(messageOf(e));
                }
              });
            },
          },
          'Archive',
        )
      : null;

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      oninput: update,
      onchange: update,
      onsubmit: (event) => {
        event.preventDefault();
        error.clear();
        const total = parseAmountToCents(amount.value);
        const rule = split.read();
        if (!name.value.trim()) {
          error.show('Give the bill a name.');
          return;
        }
        if (amount.value.trim() && total === null) {
          error.show('The usual amount looks wrong.');
          return;
        }
        if (auto.checked && !total) {
          error.show('An automatic bill needs its usual amount.');
          return;
        }
        if (rule === null) {
          error.show('Fill in the share.');
          return;
        }
        try {
          splitHousehold(total || 100_000_000, rule);
        } catch (e) {
          error.show(e instanceof SplitError ? messageFor(e.code) : 'Check the amounts.');
          return;
        }
        void busy(submit, 'Saving…', async () => {
          try {
            await upsertRecurringBill(existing?.id ?? null, {
              name: name.value.trim(),
              paid_by_party_id: payer,
              ...splitColumns(rule),
              split_type: rule.type,
              default_total_cents: total || null,
              auto_add: auto.checked,
              day_of_month: Number(day.value),
              sort_order: existing?.sort_order ?? null,
            });
            sheet.close();
            await ctx.refresh();
          } catch (e) {
            error.show(messageOf(e));
          }
        });
      },
    },
    field('Name', name),
    fieldGroup(
      'Who usually pays',
      segmented(
        'Who usually pays',
        [
          { value: myParty, label: view.partyName(myParty) },
          { value: otherParty, label: otherName },
        ],
        payer,
        (value) => {
          payer = value;
          update();
        },
      ),
    ),
    split.el,
    field('Usual amount', amount, 'Optional for shortcuts. Pre-filled each time.'),
    h('label', { class: 'switch-row' }, h('span', {}, 'Add automatically every month'), auto),
    dayField,
    preview,
    error.el,
    submit,
    archive,
  );

  update();
  const sheet = openSheet(ctx.root, existing ? existing.name : 'New monthly bill', form);
  if (!existing) name.focus();
}
