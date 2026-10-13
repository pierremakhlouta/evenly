import {
  exportEntries,
  listDevices,
  renameParty,
  revokeDevice,
  updateGroup,
  upsertPerson,
  upsertRecurringBill,
} from '../../api/rpc';
import type { Device, RecurringBill } from '../../api/types';
import { formatDateTime, today } from '../../dates';
import { downloadCsv, toCsv } from '../../export';
import type { Person } from '../../api/types';
import { APP_NAME, APP_VERSION } from '../../config';
import type { AppContext } from '../app';
import { busy, errorLine, field, fieldGroup, segmented } from '../components/forms';
import { h, replace } from '../dom';
import { messageOf } from '../errors';
import { icon } from '../icons';
import { billSummary, openBillSheet } from './bill';
import { openPeopleBillSheet } from './people-bill';
import { openPersonSheet } from './person';

/**
 * Settings. For now: this phone, group and household names, and the people list
 * where admins can add people. The rest (archiving, admins, bills, devices,
 * export) comes in Phase 6.
 */
export function settingsScreen(ctx: AppContext): HTMLElement {
  const { view } = ctx;
  const isAdmin = view.me?.is_admin === true;

  const personRow = (p: Person) => {
    const label = [
      p.id === view.me?.id ? 'You' : null,
      p.is_admin ? 'Admin' : null,
      p.has_pin ? null : 'No PIN yet',
    ]
      .filter(Boolean)
      .join(' · ');
    return isAdmin
      ? h(
          'button',
          {
            type: 'button',
            class: 'list-item chevron',
            onclick: () => {
              openPersonSheet(ctx, p);
            },
          },
          h('span', {}, p.name),
          h('span', { class: 'muted' }, label),
        )
      : h(
          'div',
          { class: 'list-item' },
          h('span', {}, p.name),
          h('span', { class: 'muted' }, label),
        );
  };

  const archivedPeople = view.summary.people.filter((p) => p.archived);

  const peopleLists =
    view.mode === 'households'
      ? view.activeParties.map((party) => {
          const people = view.peopleOf(party.id);
          return h(
            'div',
            { class: 'stack' },
            h('h3', { class: 'field-label' }, party.name),
            people.length
              ? h('div', { class: 'list' }, people.map(personRow))
              : h('p', { class: 'muted' }, 'Nobody yet.'),
          );
        })
      : [
          h(
            'div',
            { class: 'list' },
            view.summary.people.filter((p) => !p.archived).map(personRow),
          ),
        ];

  /** A row showing a name; admins can tap it to rename in place. */
  const nameRow = (label: string, value: string, save: (name: string) => Promise<unknown>) => {
    const slot = h('div', {});
    const showRow = () => {
      replace(
        slot,
        isAdmin
          ? h(
              'button',
              { type: 'button', class: 'list-item chevron', onclick: showForm },
              h('span', {}, label),
              h('span', { class: 'muted' }, value),
            )
          : h(
              'div',
              { class: 'list-item' },
              h('span', {}, label),
              h('span', { class: 'muted' }, value),
            ),
      );
    };
    const showForm = () => {
      const error = errorLine();
      const input = h('input', {
        class: 'input',
        name: 'name',
        autocomplete: 'off',
        maxlength: 80,
        value,
      });
      const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Save');
      replace(
        slot,
        h(
          'form',
          {
            class: 'stack',
            style: 'padding: 16px',
            novalidate: true,
            onsubmit: (event) => {
              event.preventDefault();
              error.clear();
              if (!input.value.trim()) {
                error.show('Enter a name.');
                return;
              }
              void busy(submit, 'Saving…', async () => {
                try {
                  await save(input.value.trim());
                  await ctx.refresh();
                } catch (e) {
                  error.show(messageOf(e));
                }
              });
            },
          },
          field(label, input),
          error.el,
          submit,
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: showRow }, 'Cancel'),
        ),
      );
      input.focus();
      input.select();
    };
    showRow();
    return slot;
  };

  const groupSection = h(
    'section',
    { class: 'stack' },
    h('h2', { class: 'section-title' }, 'Group'),
    h(
      'div',
      { class: 'list' },
      nameRow('Group name', view.summary.group.name, updateGroup),
      view.mode === 'households'
        ? view.activeParties.map((party, i) =>
            nameRow(`Household ${String(i + 1)}`, party.name, (name) =>
              renameParty(party.id, name),
            ),
          )
        : null,
    ),
    isAdmin
      ? null
      : h('p', { class: 'muted' }, 'Only an admin can rename the group or households.'),
  );

  /** Swaps a bill's place with its neighbour (sort orders are rewritten in list order). */
  const moveBill = async (bills: RecurringBill[], index: number, by: -1 | 1) => {
    const order = [...bills];
    const [moved] = order.splice(index, 1);
    if (!moved) return;
    order.splice(index + by, 0, moved);
    for (const [i, b] of order.entries()) {
      if (b.sort_order === i + 1) continue;
      await upsertRecurringBill(b.id, {
        name: b.name,
        paid_by_party_id: b.paid_by_party_id,
        split_type: b.split_type,
        split_num: b.split_num,
        split_den: b.split_den,
        split_inputs: b.split_inputs,
        default_total_cents: b.default_total_cents,
        auto_add: b.auto_add,
        day_of_month: b.day_of_month,
        sort_order: i + 1,
      });
    }
    await ctx.refresh();
  };

  const billRow = (bill: RecurringBill, index: number, list: RecurringBill[]) => {
    const move = (by: -1 | 1, label: string, name: 'up' | 'down') =>
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': `${label} ${bill.name}`,
          'data-write': true,
          disabled: index + by < 0 || index + by >= list.length,
          onclick: () => {
            moveBill(list, index, by).catch((e: unknown) => {
              alert(messageOf(e));
            });
          },
        },
        icon(name),
      );
    return h(
      'div',
      { class: 'list-item bill-row' },
      h(
        'button',
        {
          type: 'button',
          class: 'bill-open',
          onclick: () => {
            if (view.mode === 'people') openPeopleBillSheet(ctx, bill);
            else openBillSheet(ctx, bill);
          },
        },
        h('span', { class: 'entry-title' }, bill.name),
        h('span', { class: 'entry-meta muted' }, billSummary(bill)),
      ),
      bill.active ? move(-1, 'Move up', 'up') : null,
      bill.active ? move(1, 'Move down', 'down') : null,
    );
  };

  const activeBills = ctx.bills.filter((b) => b.active);
  const archivedBills = ctx.bills.filter((b) => !b.active);
  // Both modes have monthly bills; the bill form follows the group's mode.
  const billsSection = h(
    'section',
    { class: 'stack' },
    h('h2', { class: 'section-title' }, 'Monthly bills'),
    activeBills.length
      ? h(
          'div',
          { class: 'list' },
          activeBills.map((b, i) => billRow(b, i, activeBills)),
        )
      : h('p', { class: 'muted' }, 'Save bills like Rent or Hydro to add them in one tap.'),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-secondary btn-block',
        'data-write': true,
        onclick: () => {
          if (view.mode === 'people') openPeopleBillSheet(ctx);
          else openBillSheet(ctx);
        },
      },
      'Add bill',
    ),
    archivedBills.length
      ? h(
          'details',
          { class: 'archived' },
          h('summary', { class: 'muted' }, `Archived bills (${String(archivedBills.length)})`),
          h(
            'div',
            { class: 'list' },
            archivedBills.map((b, i) => billRow(b, i, archivedBills)),
          ),
        )
      : null,
  );

  const addArea = h('div', { class: 'stack' });

  const showAddButton = () => {
    replace(
      addArea,
      h(
        'button',
        { type: 'button', class: 'btn btn-secondary btn-block', onclick: showAddForm },
        'Add person',
      ),
    );
  };

  const showAddForm = () => {
    const error = errorLine();
    const name = h('input', { class: 'input', name: 'name', autocomplete: 'off', maxlength: 80 });
    let partyId: string | null = null;
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Add');
    replace(
      addArea,
      h(
        'form',
        {
          class: 'card stack',
          novalidate: true,
          onsubmit: (event) => {
            event.preventDefault();
            error.clear();
            if (!name.value.trim()) {
              error.show('Enter a name.');
              return;
            }
            if (view.mode === 'households' && !partyId) {
              error.show('Pick their household.');
              return;
            }
            void busy(submit, 'Adding…', async () => {
              try {
                await upsertPerson(null, name.value.trim(), partyId);
                await ctx.refresh();
              } catch (e) {
                error.show(messageOf(e));
              }
            });
          },
        },
        field('Name', name),
        view.mode === 'households'
          ? fieldGroup(
              'Household',
              segmented(
                'Household',
                view.activeParties.map((p) => ({ value: p.id, label: p.name })),
                null,
                (value) => {
                  partyId = value;
                },
              ),
            )
          : null,
        h(
          'p',
          { class: 'field-hint' },
          'They create their own PIN the first time they pick their name.',
        ),
        error.el,
        submit,
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: showAddButton }, 'Cancel'),
      ),
    );
    name.focus();
  };

  if (isAdmin) showAddButton();

  return h(
    'main',
    { class: 'screen with-tabbar' },
    h('header', { class: 'topbar' }, h('h1', {}, 'Settings')),
    h(
      'section',
      { class: 'stack' },
      h('h2', { class: 'section-title' }, 'This phone'),
      h(
        'div',
        { class: 'list' },
        h(
          'button',
          { type: 'button', class: 'list-item chevron', onclick: ctx.switchPerson },
          h('span', {}, 'You are'),
          h(
            'span',
            { class: 'muted' },
            `${view.me?.name ?? 'Unknown'}, ${view.partyName(view.myPartyId)}`,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'list-item',
            onclick: () => {
              if (
                confirm(
                  'Sign this phone out of the group? You will need the group code and PIN to join again.',
                )
              ) {
                ctx.leave();
              }
            },
          },
          h('span', { style: 'color: var(--danger)' }, 'Sign out of this group'),
        ),
      ),
    ),
    groupSection,
    billsSection,
    h(
      'section',
      { class: 'stack' },
      h('h2', { class: 'section-title' }, 'People'),
      ...peopleLists,
      isAdmin ? addArea : h('p', { class: 'muted' }, 'Only an admin can add or change people.'),
      archivedPeople.length
        ? h(
            'details',
            { class: 'archived' },
            h('summary', { class: 'muted' }, `Removed people (${String(archivedPeople.length)})`),
            h(
              'div',
              { class: 'list' },
              archivedPeople.map((p) =>
                h(
                  'div',
                  { class: 'list-item' },
                  h('span', {}, p.name),
                  h('span', { class: 'muted' }, view.partyName(p.party_id)),
                ),
              ),
            ),
          )
        : null,
    ),
    devicesSection(ctx),
    exportSection(ctx),
    h('p', { class: 'muted', style: 'text-align: center' }, `${APP_NAME} ${APP_VERSION}`),
  );
}

/** Phones in the group. Anyone can revoke another phone; this phone signs out instead. */
function devicesSection(ctx: AppContext): HTMLElement {
  const list = h('div', { class: 'list' }, h('p', { class: 'list-item muted' }, 'Loading phones…'));
  const error = errorLine();

  const row = (d: Device) => {
    const who = d.person_id ? ctx.view.personName(d.person_id) : 'No one picked yet';
    const revoke = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost',
        'data-write': true,
        'aria-label': `Revoke ${d.label ?? who}`,
      },
      'Revoke',
    );
    revoke.addEventListener('click', () => {
      if (
        !confirm(
          `Revoke ${d.label ?? 'this phone'}? It is signed out and needs the group code and PIN to join again.`,
        )
      )
        return;
      void busy(revoke, '…', async () => {
        try {
          await revokeDevice(d.id);
          await load();
        } catch (e) {
          error.show(messageOf(e));
        }
      });
    });
    return h(
      'div',
      { class: 'list-item device-row' },
      h(
        'div',
        { class: 'entry-main' },
        h('span', { class: 'entry-title' }, d.label ?? 'Unnamed phone'),
        h(
          'span',
          { class: 'entry-meta muted' },
          `${who} · ${d.is_me ? 'This phone' : `Last seen ${formatDateTime(d.last_seen_at)}`}`,
        ),
      ),
      d.is_me ? null : revoke,
    );
  };

  const load = async () => {
    const devices = (await listDevices())
      .filter((d) => !d.revoked)
      .sort((a, b) => Number(b.is_me) - Number(a.is_me));
    replace(list, ...devices.map(row));
  };
  load().catch((e: unknown) => {
    replace(list, h('p', { class: 'list-item error' }, messageOf(e)));
  });

  return h(
    'section',
    { class: 'stack' },
    h('h2', { class: 'section-title' }, 'Phones'),
    list,
    error.el,
    h('p', { class: 'field-hint' }, "Revoke a phone that's lost or no longer used."),
  );
}

/** The CSV backup of every entry. */
function exportSection(ctx: AppContext): HTMLElement {
  const error = errorLine();
  const button = h(
    'button',
    { type: 'button', class: 'btn btn-secondary btn-block' },
    'Export all entries (CSV)',
  );
  button.addEventListener('click', () => {
    void busy(button, 'Preparing…', async () => {
      try {
        const entries = await exportEntries();
        downloadCsv(`evenly-${today()}.csv`, toCsv(ctx.view, entries));
      } catch (e) {
        error.show(messageOf(e));
      }
    });
  });
  return h(
    'section',
    { class: 'stack' },
    h('h2', { class: 'section-title' }, 'Backup'),
    button,
    error.el,
    h(
      'p',
      { class: 'field-hint' },
      'Every entry, deleted ones too. Export once a month and keep the file somewhere safe.',
    ),
  );
}
