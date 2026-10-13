/**
 * People mode "split between" picker: tick who's in, then split Equally, by
 * Amounts, by Percent or by Shares (weights). The shares preview uses the same math
 * as the database (src/money/split.ts).
 */
import type { Party, PeopleSplitType, SplitInput } from '../../api/types';
import { centsToInput, formatCents, parseAmountToCents } from '../../money/format';
import { SplitError, splitPeople, type PartyShare } from '../../money/split';
import { h } from '../dom';
import { segmented } from './forms';

const MODES: { value: PeopleSplitType; label: string; hint: string }[] = [
  { value: 'equal', label: 'Equally', hint: '' },
  { value: 'amounts', label: 'Amounts', hint: '$' },
  { value: 'percent', label: 'Percent', hint: '%' },
  { value: 'weights', label: 'Shares', hint: 'shares' },
];

/** Parses one person's typed value for a mode: cents, basis points or a whole weight. */
export function parseValue(mode: PeopleSplitType, text: string): number | null {
  const t = text.trim().replace(/[$%]/g, '');
  if (mode === 'weights') return /^\d{1,4}$/.test(t) ? Number(t) : null;
  return parseAmountToCents(t);
}

/** The text an input shows for a stored value. */
export function valueText(mode: PeopleSplitType, value: number | undefined): string {
  if (value === undefined) return '';
  if (mode === 'weights') return String(value);
  const text = centsToInput(value);
  return mode === 'percent' ? text.replace(/\.?0+$/, '') : text;
}

/** People-mode wording for split errors (the shared messages are worded for households). */
export function peopleSplitMessage(code: string): string {
  switch (code) {
    case 'invalid_amount':
      return 'The amounts must add up to the total.';
    case 'invalid_percent':
      return 'The percentages must add up to 100%.';
    case 'invalid_weights':
      return 'Shares must be whole numbers, with at least one above 0.';
    case 'invalid_parties':
      return 'Pick at least one person to split with.';
    default:
      return 'Fill in the amount and every value.';
  }
}

export interface PeopleSplitResult {
  split_type: PeopleSplitType;
  split_inputs: SplitInput[];
  shares: PartyShare[];
}

export interface PeopleSplit {
  el: HTMLElement;
  /** The split for this total, or an error code / 'incomplete' while it can't be computed. */
  read: (totalCents: number | null) => PeopleSplitResult | { error: string };
}

export function peopleSplit(
  parties: readonly Party[],
  initial: { split_type: PeopleSplitType; split_inputs: SplitInput[] } | null,
  onChange: () => void,
): PeopleSplit {
  let mode: PeopleSplitType = initial?.split_type ?? 'equal';
  const startValues = new Map((initial?.split_inputs ?? []).map((i) => [i.party_id, i.value]));
  const included = new Set(
    initial ? initial.split_inputs.map((i) => i.party_id) : parties.map((p) => p.id),
  );

  const rows = parties.map((party) => {
    const box = h('input', {
      type: 'checkbox',
      class: 'check',
      name: `in-${party.id}`,
      checked: included.has(party.id),
    });
    const input = h('input', {
      class: 'input input-small money',
      name: `value-${party.id}`,
      inputmode: 'decimal',
      autocomplete: 'off',
      'aria-label': `${party.name}'s value`,
      value: valueText(mode, startValues.get(party.id)),
    });
    const share = h('span', { class: 'money muted split-share' });
    box.addEventListener('change', () => {
      if (box.checked) included.add(party.id);
      else included.delete(party.id);
      update();
      onChange();
    });
    input.addEventListener('input', () => {
      onChange();
    });
    const el = h(
      'div',
      { class: 'list-item split-row' },
      h('label', { class: 'split-name' }, box, h('span', {}, party.name)),
      input,
      share,
    );
    return { party, box, input, share, el };
  });

  const update = () => {
    for (const r of rows) {
      r.input.hidden = mode === 'equal' || !included.has(r.party.id);
      r.input.placeholder = MODES.find((m) => m.value === mode)?.hint ?? '';
    }
  };

  const el = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'field', role: 'group', 'aria-label': 'Split between' },
      h('span', { class: 'field-label' }, 'Split between'),
      segmented<PeopleSplitType>(
        'Split method',
        MODES.map((m) => ({ value: m.value, label: m.label })),
        mode,
        (value) => {
          mode = value;
          for (const r of rows) r.input.value = '';
          update();
          onChange();
        },
      ),
    ),
    h(
      'div',
      { class: 'list' },
      rows.map((r) => r.el),
    ),
  );
  update();

  const read = (totalCents: number | null): PeopleSplitResult | { error: string } => {
    const chosen = rows.filter((r) => included.has(r.party.id));
    for (const r of rows) r.share.textContent = '';
    if (chosen.length === 0) return { error: 'invalid_parties' };
    const inputs: SplitInput[] = [];
    for (const r of chosen) {
      if (mode === 'equal') {
        inputs.push({ party_id: r.party.id });
        continue;
      }
      const value = parseValue(mode, r.input.value);
      if (value === null) return { error: 'incomplete' };
      inputs.push({ party_id: r.party.id, value });
    }
    if (!totalCents) return { error: 'incomplete' };
    try {
      const shares = splitPeople(
        totalCents,
        mode,
        chosen.map((r, i) => {
          const value = inputs[i]?.value;
          return value === undefined
            ? { partyId: r.party.id, sortOrder: r.party.sort_order }
            : { partyId: r.party.id, sortOrder: r.party.sort_order, value };
        }),
      );
      for (const s of shares) {
        const row = rows.find((r) => r.party.id === s.partyId);
        if (row) row.share.textContent = formatCents(s.shareCents);
      }
      return { split_type: mode, split_inputs: inputs, shares };
    } catch (e) {
      return { error: e instanceof SplitError ? e.code : 'incomplete' };
    }
  };

  return { el, read };
}
