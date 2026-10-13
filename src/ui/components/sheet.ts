import { h } from '../dom';

export interface Sheet {
  close: () => void;
}

/**
 * A bottom sheet built on the native <dialog> element, which gives focus handling,
 * Escape to close and an inert background for free. It is mounted inside the app
 * root so a background refresh sees the open form and waits.
 */
let sheetIds = 0;

export function openSheet(root: HTMLElement, title: string, body: HTMLElement): Sheet {
  sheetIds += 1;
  const titleId = `sheet-title-${String(sheetIds)}`;
  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': titleId });
  // Remove right away (the close event fires later), so a sheet opened next never
  // shares the page with this one.
  const close = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
    document.body.classList.remove('sheet-open');
  };

  const panel = h(
    'div',
    { class: 'sheet-panel', tabindex: -1 },
    h(
      'header',
      { class: 'sheet-header' },
      h('h2', { id: titleId, class: 'sheet-title' }, title),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel'),
    ),
    body,
  );
  dialog.append(panel);

  // Tapping the dimmed backdrop (the dialog itself, outside the panel) closes it.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  // Escape closes the dialog natively; clean up the same way.
  dialog.addEventListener('close', close);

  root.append(dialog);
  document.body.classList.add('sheet-open');
  dialog.showModal();
  // showModal focuses the first button (Cancel), which Safari outlines; start on the
  // sheet itself instead. Forms that want a field focused do that right after.
  panel.focus({ preventScroll: true });
  return { close };
}
