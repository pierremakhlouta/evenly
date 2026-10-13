/**
 * Add (and, from Phase 4, edit) an expense in household mode.
 *
 * The form asks for the other household's share. The label and the live preview are
 * always worded from this phone's side and follow the "who paid" toggle:
 *   this household paid  -> "Their share", "Basement suite owes you $35.00"
 *   the other one paid   -> "Your share",  "You owe Main floor $40.00"
 * The preview uses the same split math as the database (src/money/split.ts).
 */
import { messageFor } from '../../api/errors';
import { addEntry, editEntry } from '../../api/rpc';
import type { Entry, EntryInput, HouseholdSplitType } from '../../api/types';
import { today } from '../../dates';
import { SplitError, splitHousehold, type HouseholdSplit } from '../../money/split';
import { centsToInput, formatCents, parseAmountToCents } from '../../money/format';
import type { AppContext } from '../app';
import { busy, errorLine, field, fieldGroup, segmented } from '../components/forms';
import { openSheet } from '../components/sheet';
import { h } from '../dom';
import { messageOf } from '../errors';

type Chip = 'third' | 'half' | 'all' | 'more';
type MoreKind = 'amount' | 'fraction' | 'percent';

function amountInput(name: string, placeholder = '0.00'): HTMLInputElement {
  return h('input', {
    class: 'input money',
    name,
    inputmode: 'decimal',
    autocomplete: 'off',
    placeholder,
  });
}

function wholeInput(name: string, placeholder: string): HTMLInputElement {
  return h('input', {
    class: 'input money',
    name,
    inputmode: 'numeric',
    pattern: '[0-9]*',
    autocomplete: 'off',
    placeholder,
  });
}

/** Reads the split the form describes, or null when it is not filled in yet. */
export function readSplit(
  chip: Chip,
  more: MoreKind,
  values: { amount: string; num: string; den: string; percent: string },
): HouseholdSplit | null {
  if (chip !== 'more') return { type: chip };
  if (more === 'amount') {
    const cents = parseAmountToCents(values.amount);
    return cents === null ? null : { type: 'amount', amountCents: cents };
  }
  if (more === 'fraction') {
    if (!/^\d+$/.test(values.num) || !/^\d+$/.test(values.den)) return null;
    return { type: 'fraction', num: Number(values.num), den: Number(values.den) };
  }
  // A percentage has up to 2 decimals, like an amount: "33.33" -> 3333 basis points.
  const bp = parseAmountToCents(values.percent.replace(/%$/, ''));
  return bp === null ? null : { type: 'percent', basisPoints: bp };
}

/** The split as database columns. */
export function splitColumns(
  split: HouseholdSplit,
): Pick<EntryInput, 'split_type' | 'split_num' | 'split_den'> {
  const type: HouseholdSplitType = split.type;
  switch (split.type) {
    case 'fraction':
      return { split_type: type, split_num: split.num, split_den: split.den };
    case 'percent':
      return { split_type: type, split_num: split.basisPoints };
    case 'amount':
      return { split_type: type, split_num: split.amountCents };
    default:
      return { split_type: type };
  }
}

/** The share chips and custom inputs that reproduce an existing entry's split. */
export function initialShare(entry: Pick<Entry, 'split_type' | 'split_num' | 'split_den'>): {
  chip: Chip;
  more: MoreKind;
  amount: string;
  num: string;
  den: string;
  percent: string;
} {
  const blank = { more: 'amount' as MoreKind, amount: '', num: '', den: '', percent: '' };
  switch (entry.split_type) {
    case 'half':
    case 'all':
      return { ...blank, chip: entry.split_type };
    case 'amount':
      return { ...blank, chip: 'more', amount: centsToInput(entry.split_num ?? 0) };
    case 'fraction':
      return {
        ...blank,
        chip: 'more',
        more: 'fraction',
        num: String(entry.split_num),
        den: String(entry.split_den),
      };
    case 'percent':
      return {
        ...blank,
        chip: 'more',
        more: 'percent',
        percent: centsToInput(entry.split_num ?? 0).replace(/\.?0+$/, ''),
      };
    default:
      return { ...blank, chip: 'third' };
  }
}

/** Opens the Add expense sheet, or the Edit expense sheet when `existing` is given. */
export function openExpenseSheet(ctx: AppContext, root: HTMLElement, existing?: Entry): void {
  const { view } = ctx;
  const myParty = view.myPartyId ?? '';
  const otherParty = view.otherPartyId ?? '';
  const otherName = view.partyName(otherParty);
  const initial = existing ? initialShare(existing) : null;

  let payer = existing?.paid_by_party_id ?? myParty;
  let chip: Chip = initial?.chip ?? 'third';
  let more: MoreKind = initial?.more ?? 'amount';

  const description = h('input', {
    class: 'input',
    name: 'description',
    autocomplete: 'off',
    maxlength: 200,
    placeholder: 'e.g. Hydro, Dinner',
    value: existing?.description,
  });
  const amount = amountInput('amount');
  if (existing) amount.value = centsToInput(existing.total_cents);
  const date = h('input', {
    class: 'input',
    name: 'date',
    type: 'date',
    value: existing?.entry_date ?? today(),
  });
  const person = h('select', { class: 'input', name: 'person', 'aria-label': 'Who paid (person)' });

  const shareAmount = amountInput('share-amount');
  const fracNum = wholeInput('fraction-num', '1');
  const fracDen = wholeInput('fraction-den', '3');
  const percent = amountInput('percent', '40');
  if (initial) {
    shareAmount.value = initial.amount;
    fracNum.value = initial.num;
    fracDen.value = initial.den;
    percent.value = initial.percent;
  }
  const shareLabel = h('span', { class: 'field-label' });
  const preview = h('p', { class: 'preview', 'aria-live': 'polite' });
  const error = errorLine();
  const submit = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit', 'data-write': true },
    existing ? 'Save changes' : 'Add expense',
  );

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

  const moreInputs = {
    amount: field('Share in $', shareAmount),
    fraction: h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Fraction'),
      h('div', { class: 'fraction' }, fracNum, h('span', { class: 'muted' }, 'out of'), fracDen),
    ),
    percent: field('Percent', percent),
  };
  const moreArea = h(
    'div',
    { class: 'stack more-area', hidden: true },
    segmented<MoreKind>(
      'Custom share',
      [
        { value: 'amount', label: '$ amount' },
        { value: 'fraction', label: 'Fraction' },
        { value: 'percent', label: 'Percent' },
      ],
      more,
      (value) => {
        more = value;
        update();
      },
    ),
    moreInputs.amount,
    moreInputs.fraction,
    moreInputs.percent,
  );

  const currentSplit = () =>
    readSplit(chip, more, {
      amount: shareAmount.value,
      num: fracNum.value,
      den: fracDen.value,
      percent: percent.value,
    });

  function update() {
    const iPaid = payer === myParty;
    shareLabel.textContent = iPaid ? 'Their share' : 'Your share';
    moreArea.hidden = chip !== 'more';
    moreInputs.amount.hidden = more !== 'amount';
    moreInputs.fraction.hidden = more !== 'fraction';
    moreInputs.percent.hidden = more !== 'percent';

    const total = parseAmountToCents(amount.value);
    const split = currentSplit();
    if (total === null || total === 0 || split === null) {
      preview.textContent = 'Enter the amount to see who owes what.';
      preview.classList.remove('preview-error');
      return;
    }
    try {
      const { otherCents } = splitHousehold(total, split);
      const owed = formatCents(otherCents);
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
        const split = currentSplit();
        if (!description.value.trim()) {
          error.show('Add a short description.');
          return;
        }
        if (total === null || total === 0) {
          error.show('Enter the amount.');
          return;
        }
        if (split === null) {
          error.show('Fill in the share.');
          return;
        }
        try {
          splitHousehold(total, split);
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
              ...splitColumns(split),
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
    h(
      'div',
      { class: 'field', role: 'group', 'aria-label': 'Share' },
      shareLabel,
      segmented<Chip>(
        'Share',
        [
          { value: 'third', label: '1/3' },
          { value: 'half', label: '1/2' },
          { value: 'all', label: 'All' },
          { value: 'more', label: 'More' },
        ],
        chip,
        (value) => {
          chip = value;
          update();
          if (value === 'more')
            (more === 'amount' ? shareAmount : more === 'fraction' ? fracNum : percent).focus();
        },
      ),
    ),
    moreArea,
    preview,
    field('Date', date),
    error.el,
    submit,
  );

  fillPeople(existing ? existing.paid_by_person_id : undefined);
  update();
  const sheet = openSheet(root, existing ? 'Edit expense' : 'Add expense', form);
  if (!existing) description.focus();
}
