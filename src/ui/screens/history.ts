import { h } from '../dom';

/** History. Built later in Phase 3. */
export function historyScreen(): HTMLElement {
  return h(
    'main',
    { class: 'screen with-tabbar' },
    h('header', { class: 'topbar' }, h('h1', {}, 'History')),
    h('p', { class: 'empty' }, 'History is coming soon.'),
  );
}
