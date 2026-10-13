/**
 * The household split picker: 1/3, 1/2, All, or More ($ amount, fraction, percent),
 * labelled from this phone's side ("Their share" / "Your share"). Used by the
 * expense form and the monthly bill form.
 */
import type { Entry, EntryInput, HouseholdSplitType } from '../../api/types';
import type { HouseholdSplit } from '../../money/split';
import { centsToInput, parseAmountToCents } from '../../money/format';
import { h } from '../dom';
import { field, segmented } from './forms';

export type Chip = 'third' | 'half' | 'all' | 'more';
export type MoreKind = 'amount' | 'fraction' | 'percent';
type SplitRule = Pick<Entry, 'split_type' | 'split_num' | 'split_den'>;

export function amountInput(name: string, placeholder = '0.00'): HTMLInputElement {
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

/** The chips and custom inputs that reproduce a saved split rule. */
export function initialShare(rule: SplitRule): {
  chip: Chip;
  more: MoreKind;
  amount: string;
  num: string;
  den: string;
  percent: string;
} {
  const blank = { more: 'amount' as MoreKind, amount: '', num: '', den: '', percent: '' };
  switch (rule.split_type) {
    case 'half':
    case 'all':
      return { ...blank, chip: rule.split_type };
    case 'amount':
      return { ...blank, chip: 'more', amount: centsToInput(rule.split_num ?? 0) };
    case 'fraction':
      return {
        ...blank,
        chip: 'more',
        more: 'fraction',
        num: String(rule.split_num),
        den: String(rule.split_den),
      };
    case 'percent':
      return {
        ...blank,
        chip: 'more',
        more: 'percent',
        percent: centsToInput(rule.split_num ?? 0).replace(/\.?0+$/, ''),
      };
    default:
      return { ...blank, chip: 'third' };
  }
}

export interface SplitPicker {
  el: HTMLElement;
  /** The split described so far, or null while a custom share is incomplete. */
  read: () => HouseholdSplit | null;
  /** Rewords the label for who paid: this household ("Their share") or the other ("Your share"). */
  setIPaid: (iPaid: boolean) => void;
}

/** onChange runs after every change, so the form can refresh its preview. */
export function splitPicker(initial: SplitRule | null, onChange: () => void): SplitPicker {
  const start = initial ? initialShare(initial) : null;
  let chip: Chip = start?.chip ?? 'third';
  let more: MoreKind = start?.more ?? 'amount';

  const shareAmount = amountInput('share-amount');
  const fracNum = wholeInput('fraction-num', '1');
  const fracDen = wholeInput('fraction-den', '3');
  const percent = amountInput('percent', '40');
  if (start) {
    shareAmount.value = start.amount;
    fracNum.value = start.num;
    fracDen.value = start.den;
    percent.value = start.percent;
  }
  const label = h('span', { class: 'field-label' });

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

  const show = () => {
    moreArea.hidden = chip !== 'more';
    moreInputs.amount.hidden = more !== 'amount';
    moreInputs.fraction.hidden = more !== 'fraction';
    moreInputs.percent.hidden = more !== 'percent';
  };

  const moreArea = h(
    'div',
    { class: 'stack more-area' },
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
        show();
        onChange();
      },
    ),
    moreInputs.amount,
    moreInputs.fraction,
    moreInputs.percent,
  );

  const el = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'field', role: 'group', 'aria-label': 'Share' },
      label,
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
          show();
          onChange();
          if (value === 'more')
            (more === 'amount' ? shareAmount : more === 'fraction' ? fracNum : percent).focus();
        },
      ),
    ),
    moreArea,
  );
  show();

  return {
    el,
    read: () =>
      readSplit(chip, more, {
        amount: shareAmount.value,
        num: fracNum.value,
        den: fracDen.value,
        percent: percent.value,
      }),
    setIPaid: (iPaid) => {
      label.textContent = iPaid ? 'Their share' : 'Your share';
    },
  };
}
