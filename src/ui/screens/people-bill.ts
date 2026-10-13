/**
 * People mode: add or edit a saved monthly bill, split between people with the same
 * picker as Add expense. Like household bills, it's a shortcut on Home or, with
 * "Add automatically", added by the database every month on its day.
 */
import { archiveRecurringBill, upsertRecurringBill } from '../../api/rpc';
import type { PeopleSplitType, RecurringBill } from '../../api/types';
import { centsToInput, formatCents, parseAmountToCents } from '../../money/format';
import type { AppContext } from '../app';
import { busy, errorLine, field } from '../components/forms';
import { peopleSplit, peopleSplitMessage } from '../components/people-split';
import { openSheet } from '../components/sheet';
import { amountInput } from '../components/split-picker';
import { h } from '../dom';
import { messageOf } from '../errors';
import { ordinal } from './bill';

/** Totals used only to check a split rule when the bill has no usual amount. */
const CHECK_TOTAL = 100_000;

export function openPeopleBillSheet(ctx: AppContext, existing?: RecurringBill): void {
  const { view } = ctx;
  const parties = view.activeParties;

  const name = h('input', {
    class: 'input',
    name: 'name',
    autocomplete: 'off',
    maxlength: 80,
    placeholder: 'e.g. Rent, Internet',
    value: existing?.name,
  });
  const payer = h(
    'select',
    { class: 'input', name: 'payer' },
    parties.map((p) => h('option', { value: p.id }, p.name)),
  );
  payer.value = existing?.paid_by_party_id ?? view.myPartyId ?? '';
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
  const split = peopleSplit(
    parties,
    existing?.split_inputs
      ? { split_type: existing.split_type as PeopleSplitType, split_inputs: existing.split_inputs }
      : null,
    () => {
      update();
    },
  );

  function update() {
    error.clear();
    dayField.hidden = !auto.checked;
    const total = parseAmountToCents(amount.value);
    const result = split.read(total || CHECK_TOTAL);
    preview.classList.remove('preview-error');
    if ('error' in result) {
      preview.textContent = peopleSplitMessage(result.error);
      if (result.error !== 'incomplete') preview.classList.add('preview-error');
      return;
    }
    if (!total) {
      preview.textContent = auto.checked
        ? 'Enter the usual amount so it can be added automatically.'
        : 'Each time, you type the amount and the split is filled in.';
      return;
    }
    const mine = result.shares.find((s) => s.partyId === view.myPartyId)?.shareCents ?? 0;
    preview.textContent = `Your part: ${formatCents(mine)}${auto.checked ? `, added on the ${ordinal(Number(day.value))} of every month.` : ' each time.'}`;
  }

  const archive =
    existing?.active === true
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger btn-block',
            'data-write': true,
            onclick: (event: Event) => {
              if (
                !confirm(
                  `Archive ${existing.name}? It leaves Home and stops being added. Past entries stay.`,
                )
              )
                return;
              const button = event.currentTarget as HTMLButtonElement;
              void busy(button, 'Archiving…', async () => {
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
        const total = parseAmountToCents(amount.value);
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
        const result = split.read(total || CHECK_TOTAL);
        if ('error' in result) {
          error.show(peopleSplitMessage(result.error));
          return;
        }
        if (result.split_type === 'amounts' && !total) {
          error.show('Split by amounts needs the usual amount.');
          return;
        }
        void busy(submit, 'Saving…', async () => {
          try {
            await upsertRecurringBill(existing?.id ?? null, {
              name: name.value.trim(),
              paid_by_party_id: payer.value,
              split_type: result.split_type,
              split_inputs: result.split_inputs,
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
    field('Who usually pays', payer),
    field('Usual amount', amount, 'Optional for shortcuts. Pre-filled each time.'),
    split.el,
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
