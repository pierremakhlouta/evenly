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

  const panel = h(
    'div',
    { class: 'sheet-panel', tabindex: -1 },
    h(
      'header',
      { class: 'sheet-header' },
      h('h2', { id: 'sheet-title' }, title),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel'),
    ),
    body,
  );
  dialog.append(panel);

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
  // showModal focuses the first button (Cancel), which Safari outlines; start on the
  // sheet itself instead. Forms that want a field focused do that right after.
  panel.focus({ preventScroll: true });
  return { close };
}
