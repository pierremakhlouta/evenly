import { upsertPerson } from '../../api/rpc';
import type { Person } from '../../api/types';
import { APP_NAME, APP_VERSION } from '../../config';
import type { AppContext } from '../app';
import { busy, errorLine, field, segmented } from '../components/forms';
import { h, replace } from '../dom';
import { messageOf } from '../errors';

/**
 * Settings. For now: this phone, and the people list where admins can add people.
 * The rest (renaming, archiving, admins, bills, devices, export) comes in Phase 6.
 */
export function settingsScreen(ctx: AppContext): HTMLElement {
  const { view } = ctx;
  const isAdmin = view.me?.is_admin === true;

  const personRow = (p: Person) =>
    h(
      'div',
      { class: 'list-item' },
      h('span', {}, p.name),
      h(
        'span',
        { class: 'muted' },
        [p.is_admin ? 'Admin' : null, p.has_pin ? null : 'No PIN yet'].filter(Boolean).join(' · '),
      ),
    );

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
          ? field(
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
    h(
      'section',
      { class: 'stack' },
      h('h2', { class: 'section-title' }, 'People'),
      ...peopleLists,
      isAdmin ? addArea : h('p', { class: 'muted' }, 'Only an admin can add or change people.'),
    ),
    h('p', { class: 'muted', style: 'text-align: center' }, `${APP_NAME} ${APP_VERSION}`),
  );
}
