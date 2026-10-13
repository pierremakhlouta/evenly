/**
 * Admin only: manage one person. Rename, move to the other household, make or
 * remove admin, reset their PIN, or remove them from the group (archive).
 */
import { archivePerson, resetPersonPin, setPersonAdmin, upsertPerson } from '../../api/rpc';
import type { Person } from '../../api/types';
import type { AppContext } from '../app';
import { busy, errorLine, field, fieldGroup, segmented } from '../components/forms';
import { openSheet } from '../components/sheet';
import { h } from '../dom';
import { messageOf } from '../errors';

export function openPersonSheet(ctx: AppContext, person: Person): void {
  const { view } = ctx;
  const isMe = person.id === view.me?.id;
  let partyId = person.party_id;
  const error = errorLine();

  const name = h('input', {
    class: 'input',
    name: 'name',
    autocomplete: 'off',
    maxlength: 80,
    value: person.name,
  });
  const save = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit', 'data-write': true },
    'Save changes',
  );

  const done = async () => {
    sheet.close();
    await ctx.refresh();
  };

  /** Runs an admin action from a button, with a confirmation first if given. */
  const action = (
    label: string,
    busyLabel: string,
    cls: string,
    question: string | null,
    run: () => Promise<unknown>,
  ) => {
    const button = h(
      'button',
      { type: 'button', class: `btn ${cls} btn-block`, 'data-write': true },
      label,
    );
    button.addEventListener('click', () => {
      if (question && !confirm(question)) return;
      void busy(button, busyLabel, async () => {
        try {
          await run();
          await done();
        } catch (e) {
          error.show(messageOf(e));
        }
      });
    });
    return button;
  };

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      oninput: () => {
        error.clear();
      },
      onsubmit: (event) => {
        event.preventDefault();
        error.clear();
        if (!name.value.trim()) {
          error.show('Enter a name.');
          return;
        }
        void busy(save, 'Saving…', async () => {
          try {
            await upsertPerson(
              person.id,
              name.value.trim(),
              view.mode === 'households' ? partyId : null,
            );
            await done();
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
            partyId,
            (value) => {
              partyId = value;
            },
          ),
          'Moving someone keeps their past entries as they were.',
        )
      : null,
    save,
  );

  const body = h(
    'div',
    { class: 'stack' },
    form,
    h('h3', { class: 'section-title' }, 'Access'),
    h(
      'p',
      { class: 'muted' },
      person.is_admin ? `${person.name} is an admin.` : `${person.name} is not an admin.`,
      ' ',
      person.has_pin
        ? 'They have a personal PIN.'
        : 'They create a PIN the first time they pick their name.',
    ),
    error.el,
    person.is_admin
      ? action('Remove admin', 'Saving…', 'btn-secondary', null, () =>
          setPersonAdmin(person.id, false),
        )
      : action('Make admin', 'Saving…', 'btn-secondary', null, () =>
          setPersonAdmin(person.id, true),
        ),
    person.has_pin
      ? action(
          'Reset PIN',
          'Resetting…',
          'btn-secondary',
          `Reset ${person.name}'s PIN? Any phone using ${person.name} is signed out of it, and the next time they pick their name they create a new PIN.`,
          () => resetPersonPin(person.id),
        )
      : null,
    isMe
      ? h('p', { class: 'field-hint' }, "You can't remove yourself. Another admin can.")
      : action(
          'Remove from group',
          'Removing…',
          'btn-danger',
          `Remove ${person.name}? Their past entries stay, but they can't be picked anymore.`,
          () => archivePerson(person.id),
        ),
  );

  const sheet = openSheet(ctx.root, person.name, body);
}
