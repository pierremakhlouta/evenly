import { addSelf, setDevicePerson } from '../../api/rpc';
import type { Person, Summary } from '../../api/types';
import { busy, errorLine, field, segmented } from '../components/forms';
import { h, replace } from '../dom';
import { messageOf } from '../errors';
import { GroupView } from '../state';

const PIN_RE = /^\d{4,12}$/;

function pinInput(name: string, autofocus = false): HTMLInputElement {
  return h('input', {
    class: 'input',
    name,
    type: 'password',
    inputmode: 'numeric',
    pattern: '[0-9]*',
    autocomplete: 'off',
    maxlength: 12,
    autofocus,
  });
}

/**
 * "Who are you?": pick yourself and enter your personal PIN (or create it the first
 * time). In a brand-new group, the first person adds themselves and becomes admin.
 */
export function whoScreen(summary: Summary, onDone: () => void): HTMLElement {
  const view = new GroupView(summary);
  const active = summary.people.filter((p) => !p.archived);
  const error = errorLine();
  const body = h('div', { class: 'stack' });
  const intro = h('p', { class: 'muted' });

  const showList = () => {
    error.clear();
    intro.textContent = `You're in ${summary.group.name}. Pick your name.`;
    const personButton = (p: Person) =>
      h(
        'button',
        {
          type: 'button',
          class: 'list-item chevron',
          onclick: () => {
            showPin(p);
          },
        },
        h('span', {}, p.name),
      );

    const sections =
      view.mode === 'households'
        ? view.activeParties.map((party) => {
            const people = view.peopleOf(party.id);
            return h(
              'section',
              { class: 'stack' },
              h('h2', { class: 'section-title' }, party.name),
              people.length
                ? h('div', { class: 'list' }, people.map(personButton))
                : h('p', { class: 'muted' }, 'Nobody yet.'),
            );
          })
        : [h('div', { class: 'list' }, active.map(personButton))];

    replace(
      body,
      ...sections,
      h('p', { class: 'muted' }, 'Not listed? Ask an admin to add you in Settings.'),
    );
  };

  /** Enter an existing PIN, or create one if this person has none yet. */
  const showPin = (person: Person) => {
    error.clear();
    const creating = !person.has_pin;
    intro.textContent = creating
      ? `Create a PIN for ${person.name}. You'll enter it whenever you pick yourself on a phone.`
      : `Enter ${person.name}'s PIN.`;
    const pin = pinInput('pin', true);
    const confirmPin = creating ? pinInput('confirm') : null;
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Continue');

    const form = h(
      'form',
      {
        class: 'stack',
        novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          error.clear();
          if (!PIN_RE.test(pin.value)) {
            error.show('PINs are 4 to 12 digits.');
            return;
          }
          if (confirmPin && confirmPin.value !== pin.value) {
            error.show("The two PINs don't match.");
            return;
          }
          void busy(submit, 'Checking…', async () => {
            try {
              await setDevicePerson(person.id, pin.value);
              onDone();
            } catch (e) {
              pin.value = '';
              if (confirmPin) confirmPin.value = '';
              error.show(messageOf(e));
            }
          });
        },
      },
      field(
        creating ? 'New PIN' : 'PIN',
        pin,
        creating ? '4 to 12 digits. Keep it to yourself.' : undefined,
      ),
      confirmPin ? field('Repeat the PIN', confirmPin) : null,
      error.el,
      submit,
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: showList }, 'Not me'),
    );
    replace(body, form);
    pin.focus();
  };

  /** Brand-new group: the first person adds themselves and becomes admin. */
  const showFirstPerson = () => {
    intro.textContent = `You're the first one in ${summary.group.name}, so you'll be its admin. You can add everyone else afterwards.`;
    const name = h('input', {
      class: 'input',
      name: 'name',
      autocomplete: 'given-name',
      maxlength: 80,
    });
    const pin = pinInput('pin');
    const confirmPin = pinInput('confirm');
    let partyId: string | null = null;
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Continue');

    const form = h(
      'form',
      {
        class: 'stack',
        novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          error.clear();
          if (!name.value.trim()) {
            error.show('Enter your name.');
            return;
          }
          if (view.mode === 'households' && !partyId) {
            error.show('Pick your household.');
            return;
          }
          if (!PIN_RE.test(pin.value)) {
            error.show('PINs are 4 to 12 digits.');
            return;
          }
          if (confirmPin.value !== pin.value) {
            error.show("The two PINs don't match.");
            return;
          }
          void busy(submit, 'Saving…', async () => {
            try {
              await addSelf(name.value.trim(), partyId, pin.value);
              onDone();
            } catch (e) {
              error.show(messageOf(e));
            }
          });
        },
      },
      field('Your name', name),
      view.mode === 'households'
        ? field(
            'Your household',
            segmented(
              'Your household',
              view.activeParties.map((p) => ({ value: p.id, label: p.name })),
              null,
              (value) => {
                partyId = value;
              },
            ),
            'You can rename the households later in Settings.',
          )
        : null,
      field('Your PIN', pin, '4 to 12 digits. Only you should know it.'),
      field('Repeat the PIN', confirmPin),
      error.el,
      submit,
    );
    replace(body, form);
  };

  if (active.length === 0) showFirstPerson();
  else showList();

  return h(
    'main',
    { class: 'screen' },
    h('div', { class: 'brand' }, h('h1', {}, 'Who are you?'), intro),
    body,
  );
}
