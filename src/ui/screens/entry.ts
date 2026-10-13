/**
 * Entry details (bottom sheet): amounts, who paid, each household's share, what it
 * means for this phone, the change log, and Edit / Delete / Restore.
 */
import { deleteEntry, getEntry, restoreEntry } from '../../api/rpc';
import type { Entry, EntryEvent } from '../../api/types';
import { formatDateTime, formatDay } from '../../dates';
import { formatCents } from '../../money/format';
import type { AppContext } from '../app';
import { effectText, entryTitle, payerName } from '../components/entry-row';
import { busy, errorLine } from '../components/forms';
import { openSheet, type Sheet } from '../components/sheet';
import { describeChanges, splitLabel } from '../describe';
import { h, replace } from '../dom';
import { messageOf } from '../errors';

function row(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'list-item' },
    h('span', { class: 'muted' }, label),
    h('span', { class: 'money detail-value' }, value),
  );
}

function eventLines(ctx: AppContext, event: EntryEvent): string[] {
  const who = event.by_person_id ? ctx.view.personName(event.by_person_id) : 'Automatically';
  const when = formatDateTime(event.at);
  switch (event.action) {
    case 'create':
      return [`Added by ${who} · ${when}`, ...(event.note ? [event.note] : [])];
    case 'delete':
      return [`Deleted by ${who} · ${when}`];
    case 'restore':
      return [`Restored by ${who} · ${when}`];
    case 'edit': {
      const changes =
        event.before && event.after ? describeChanges(ctx.view, event.before, event.after) : [];
      return [`Edited by ${who} · ${when}`, ...(changes.length ? changes : ['No visible changes'])];
    }
  }
}

/** Opens the details sheet for an entry. `onEdit` opens the matching edit form. */
export function openEntrySheet(
  ctx: AppContext,
  entry: Entry,
  onEdit?: (entry: Entry) => void,
): Sheet {
  const { view } = ctx;
  const error = errorLine();
  const log = h(
    'div',
    { class: 'list' },
    h('p', { class: 'list-item muted' }, 'Loading the change log…'),
  );

  const done = async () => {
    sheet.close();
    await ctx.refresh();
  };

  const remove = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-danger btn-block',
      'data-write': true,
      onclick: () => {
        const warning = entry.settles
          ? 'Delete this settle-up? Its period reopens and the balance comes back. You can restore it from Deleted.'
          : 'Delete this entry? It leaves the balance, and you can restore it from Deleted in History.';
        if (!confirm(warning)) return;
        void busy(remove, 'Deleting…', async () => {
          try {
            await deleteEntry(entry.id);
            await done();
          } catch (e) {
            error.show(messageOf(e));
          }
        });
      },
    },
    'Delete',
  );

  const restore = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary btn-block',
      'data-write': true,
      onclick: () => {
        void busy(restore, 'Restoring…', async () => {
          try {
            await restoreEntry(entry.id);
            await done();
          } catch (e) {
            error.show(messageOf(e));
          }
        });
      },
    },
    'Restore',
  );

  const edit =
    onEdit && !entry.deleted_at && !entry.settles
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary btn-block',
            'data-write': true,
            onclick: () => {
              sheet.close();
              onEdit(entry);
            },
          },
          'Edit',
        )
      : null;

  const shares = entry.shares.map((s) =>
    row(view.partyName(s.party_id), formatCents(s.share_cents)),
  );

  const body = h(
    'div',
    { class: 'stack' },
    entry.deleted_at
      ? h(
          'p',
          { class: 'error' },
          `Deleted${entry.deleted_by_person_id ? ` by ${view.personName(entry.deleted_by_person_id)}` : ''} · ${formatDateTime(entry.deleted_at)}. It doesn't count toward the balance.`,
        )
      : null,
    h(
      'div',
      { class: 'detail-head' },
      h('p', { class: 'detail-total money' }, formatCents(entry.total_cents)),
      h('p', { class: 'muted' }, effectText(view, entry)),
    ),
    h(
      'div',
      { class: 'list' },
      row('Date', formatDay(entry.entry_date)),
      row(entry.kind === 'payment' ? 'Sent by' : 'Paid by', payerName(view, entry)),
      entry.kind === 'expense' ? row('Split', splitLabel(entry)) : null,
      entry.settles ? row('Type', 'Settle-up (ends a period)') : null,
    ),
    h('h3', { class: 'section-title' }, entry.kind === 'payment' ? 'Received by' : 'Shares'),
    h('div', { class: 'list' }, shares),
    h('h3', { class: 'section-title' }, 'Change log'),
    log,
    error.el,
    entry.settles && !entry.deleted_at
      ? h(
          'p',
          { class: 'field-hint' },
          "A settle-up can't be edited. Delete it and settle again if it was wrong.",
        )
      : null,
    h('div', { class: 'stack' }, edit, entry.deleted_at ? restore : remove),
  );

  const sheet = openSheet(ctx.root, entryTitle(entry), body);

  getEntry(entry.id)
    .then((full) => {
      replace(
        log,
        ...full.events.map((event) =>
          h(
            'div',
            { class: 'list-item log-item' },
            h(
              'div',
              { class: 'entry-main' },
              ...eventLines(ctx, event).map((line, i) =>
                h('span', { class: i === 0 ? 'entry-title' : 'entry-meta muted' }, line),
              ),
            ),
          ),
        ),
      );
    })
    .catch((e: unknown) => {
      replace(log, h('p', { class: 'list-item error' }, messageOf(e)));
    });

  return sheet;
}
