import { h } from '../dom';

export interface Sheet {
  close: () => void;
}

/**
 * A bottom sheet built on the native <dialog> element, which gives focus handling,
 * Escape to close and an inert background for free. It is mounted inside the app
 * root so a background refresh sees the open form and waits.
 */
export function openSheet(root: HTMLElement, title: string, body: HTMLElement): Sheet {
  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'sheet-title' });
  const close = () => {
    dialog.close();
  };

  dialog.append(
    h(
      'div',
      { class: 'sheet-panel' },
      h(
        'header',
        { class: 'sheet-header' },
        h('h2', { id: 'sheet-title' }, title),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel'),
      ),
      body,
    ),
  );

  // Tapping the dimmed backdrop (the dialog itself, outside the panel) closes it.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    document.body.classList.remove('sheet-open');
  });

  root.append(dialog);
  document.body.classList.add('sheet-open');
  dialog.showModal();
  return { close };
}
