import { registerDevice } from '../../api/rpc';
import { setToken } from '../../api/token';
import { APP_NAME } from '../../config';
import { busy, errorLine, field } from '../components/forms';
import { h } from '../dom';
import { messageOf } from '../errors';

/** First open on a phone: group code and PIN. */
export function joinScreen(onJoined: () => void): HTMLElement {
  const code = h('input', {
    class: 'input input-code',
    name: 'code',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    maxlength: 12,
    placeholder: 'K7MQ-2XPA',
    required: true,
  });
  const pin = h('input', {
    class: 'input',
    name: 'pin',
    type: 'password',
    inputmode: 'numeric',
    autocomplete: 'off',
    pattern: '[0-9]*',
    maxlength: 12,
    required: true,
  });
  const label = h('input', {
    class: 'input',
    name: 'label',
    autocomplete: 'off',
    maxlength: 60,
    placeholder: 'e.g. Kitchen iPad',
  });
  const error = errorLine();
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Join');

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        error.clear();
        if (!code.value.trim() || !/^\d{4,12}$/.test(pin.value)) {
          error.show('Enter the group code and a PIN of 4 to 12 digits.');
          return;
        }
        void busy(submit, 'Joining…', async () => {
          try {
            setToken(await registerDevice(code.value, pin.value, label.value.trim()));
            onJoined();
          } catch (e) {
            pin.value = '';
            error.show(messageOf(e));
          }
        });
      },
    },
    field('Group code', code),
    field('PIN', pin),
    field('Name this phone', label, 'Optional. Helps you spot it later in Settings.'),
    error.el,
    submit,
  );

  return h(
    'main',
    { class: 'screen screen-center' },
    h(
      'div',
      { class: 'brand' },
      h('h1', {}, APP_NAME),
      h(
        'p',
        { class: 'muted' },
        'Enter the group code and PIN you were given. You only do this once on this phone.',
      ),
    ),
    form,
  );
}
