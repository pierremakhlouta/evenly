/** Human wording for entries: split rules and change-log differences. */
import type { Entry } from '../api/types';
import { formatDay } from '../dates';
import { centsToInput, formatCents } from '../money/format';
import type { GroupView } from './state';

/** Basis points as a percentage without trailing zeros: 4000 -> '40%', 3333 -> '33.33%'. */
export function percentText(basisPoints: number): string {
  return `${centsToInput(basisPoints).replace(/\.?0+$/, '')}%`;
}

/** The split rule of an expense, in the words of the form: '1/3', '40%', '$35.00'. */
export function splitLabel(entry: Pick<Entry, 'split_type' | 'split_num' | 'split_den'>): string {
  switch (entry.split_type) {
    case 'third':
      return '1/3';
    case 'half':
      return '1/2';
    case 'all':
      return 'All';
    case 'fraction':
      return `${String(entry.split_num)}/${String(entry.split_den)}`;
    case 'percent':
      return percentText(entry.split_num ?? 0);
    case 'amount':
      return formatCents(entry.split_num ?? 0);
    case 'equal':
      return 'Equally';
    case 'amounts':
      return 'By amount';
    case 'weights':
      return 'By shares';
    default:
      return '';
  }
}

/** One line per field that changed between two snapshots of an entry. */
export function describeChanges(view: GroupView, before: Entry, after: Entry): string[] {
  const lines: string[] = [];
  const change = (label: string, a: string, b: string) => {
    if (a !== b) lines.push(`${label}: ${a} → ${b}`);
  };
  change('Description', before.description || 'none', after.description || 'none');
  change('Amount', formatCents(before.total_cents), formatCents(after.total_cents));
  change('Date', formatDay(before.entry_date), formatDay(after.entry_date));
  change(
    'Paid by',
    view.partyName(before.paid_by_party_id),
    view.partyName(after.paid_by_party_id),
  );
  change(
    'Person who paid',
    before.paid_by_person_id ? view.personName(before.paid_by_person_id) : 'not specified',
    after.paid_by_person_id ? view.personName(after.paid_by_person_id) : 'not specified',
  );
  if (before.kind === 'expense') change('Split', splitLabel(before), splitLabel(after));
  return lines;
}
