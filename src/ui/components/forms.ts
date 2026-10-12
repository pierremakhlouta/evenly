import { h, type Child } from '../dom';

/** Labelled field: the label wraps the input so tapping the label focuses it. */
export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, label),
    input,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );
}

let groupIds = 0;

/**
 * Labelled group for button controls (toggles, chips). Not a <label>, because a
 * label forwards taps on its text to the first button inside it.
 */
export function fieldGroup(label: string, control: HTMLElement, hint?: string): HTMLElement {
  groupIds += 1;
  const id = `group-label-${String(groupIds)}`;
  return h(
    'div',
    { class: 'field', role: 'group', 'aria-labelledby': id },
    h('span', { class: 'field-label', id }, label),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );
}

/** An inline error line that announces itself to screen readers. */
export function errorLine(): {
  el: HTMLElement;
  show: (message: string) => void;
  clear: () => void;
} {
  const el = h('p', { class: 'error', role: 'alert', hidden: true });
  return {
    el,
    show(message) {
      el.textContent = message;
      el.hidden = false;
    },
    clear() {
      el.textContent = '';
      el.hidden = true;
    },
  };
}

/** Disables a button and shows a busy label while work runs. */
export async function busy<T>(
  button: HTMLButtonElement,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
}

/** A row of mutually exclusive choices (household toggle, split chips). */
export function segmented<T extends string>(
  name: string,
  options: { value: T; label: Child }[],
  selected: T | null,
  onChange: (value: T) => void,
): HTMLElement {
  const group = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name });
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg-option',
        role: 'radio',
        'aria-checked': String(o.value === selected),
        onclick: () => {
          for (const b of buttons) b.setAttribute('aria-checked', String(b === button(o.value)));
          onChange(o.value);
        },
        'data-value': o.value,
      },
      o.label,
    ),
  );
  const button = (value: T) => buttons[options.findIndex((o) => o.value === value)];
  group.append(...buttons);
  return group;
}
