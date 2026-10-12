import type { AppContext } from '../app';
import { h } from '../dom';

/** Home. The balance card and recent entries come in the next piece. */
export function homeScreen(ctx: AppContext): HTMLElement {
  const { view } = ctx;
  return h(
    'main',
    { class: 'screen with-tabbar' },
    h('header', { class: 'topbar' }, h('h1', {}, view.summary.group.name)),
    h(
      'section',
      { class: 'card stack' },
      h('p', {}, `Signed in as ${view.me?.name ?? 'Unknown'} (${view.partyName(view.myPartyId)}).`),
      h('p', { class: 'muted' }, 'The balance and entries come next.'),
    ),
  );
}
