/**
 * CSV export: the backup. Every entry, deleted ones included, oldest first, with
 * amounts as plain decimals so spreadsheets read them as numbers.
 */
import type { Entry } from './api/types';
import { centsToInput } from './money/format';
import { splitLabel } from './ui/describe';
import type { GroupView } from './ui/state';

/** Quotes a CSV field when needed (RFC 4180), and defuses spreadsheet formulas. */
export function csvField(value: string): string {
  // A leading = + - @ would make a spreadsheet run the text as a formula.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(view: GroupView, entries: readonly Entry[]): string {
  const parties = view.summary.parties;
  const header = [
    'Date',
    'Description',
    'Type',
    'Total',
    'Paid by',
    'Paid by person',
    'Split',
    ...parties.map((p) => `${p.name} share`),
    'Added by',
    'Added at',
    'Deleted',
    'Deleted at',
  ];

  const rows = entries.map((e) => {
    const share = (partyId: string) => e.shares.find((s) => s.party_id === partyId)?.share_cents;
    return [
      e.entry_date,
      e.description,
      e.kind === 'expense' ? 'Expense' : e.settles ? 'Settle-up' : 'Payment',
      centsToInput(e.total_cents),
      view.partyName(e.paid_by_party_id),
      e.paid_by_person_id ? view.personName(e.paid_by_person_id) : '',
      e.kind === 'expense' ? splitLabel(e) : '',
      ...parties.map((p) => {
        const cents = share(p.id);
        return cents === undefined ? '' : centsToInput(cents);
      }),
      e.created_by_person_id ? view.personName(e.created_by_person_id) : 'Automatically',
      e.created_at,
      e.deleted_at ? 'Yes' : 'No',
      e.deleted_at ?? '',
    ];
  });

  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Hands the CSV to the browser as a file download. */
export function downloadCsv(filename: string, csv: string): void {
  // The byte order mark makes Excel read the file as UTF-8 (accents in names).
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
