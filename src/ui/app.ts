/**
 * App shell: boots the phone (join, pick person, or straight in), routes between
 * tabs with the URL hash (#/home, #/history, #/settings), and owns the summary.
 */
import { ApiError } from '../api/errors';
import { getSummary } from '../api/rpc';
import { clearToken, getToken } from '../api/token';
import type { Summary } from '../api/types';
import { h, replace } from './dom';
import { messageOf } from './errors';
import { icon, type IconName } from './icons';
import { historyScreen } from './screens/history';
import { homeScreen } from './screens/home';
import { joinScreen } from './screens/join';
import { settingsScreen } from './screens/settings';
import { whoScreen } from './screens/who';
import { GroupView } from './state';

export type Tab = 'home' | 'history' | 'settings';

/** What every tab screen gets. */
export interface AppContext {
  view: GroupView;
  /** Re-fetches the summary and re-renders the current tab. */
  refresh: () => Promise<void>;
  /** Signs this phone out of the group (back to the join screen). */
  leave: () => void;
  /** Goes back to "Who are you?" to switch person. */
  switchPerson: () => void;
}

const TABS: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'home', label: 'Home', icon: 'home' },
  { tab: 'history', label: 'History', icon: 'history' },
  { tab: 'settings', label: 'Settings', icon: 'settings' },
];

export function currentTab(hash: string): Tab {
  const name = hash.replace(/^#\/?/, '');
  return name === 'history' || name === 'settings' ? name : 'home';
}

export function startApp(root: HTMLElement): void {
  let summary: Summary | null = null;

  const show = (...children: Node[]) => {
    replace(root, ...children);
    window.scrollTo(0, 0);
  };

  const loading = () => {
    show(h('main', { class: 'screen screen-center' }, h('p', { class: 'loading' }, 'Loading…')));
  };

  const failed = (error: unknown) => {
    show(
      h(
        'main',
        { class: 'screen screen-center' },
        h('p', { class: 'error', role: 'alert' }, messageOf(error)),
        h(
          'button',
          { class: 'btn btn-primary btn-block', onclick: () => void boot() },
          'Try again',
        ),
      ),
    );
  };

  const leave = () => {
    clearToken();
    summary = null;
    void boot();
  };

  const context = (): AppContext => ({
    view: new GroupView(summary as Summary),
    refresh: async () => {
      summary = await getSummary();
      renderTab();
    },
    leave,
    switchPerson: () => {
      if (summary) show(whoScreen(summary, () => void boot()));
    },
  });

  const tabbar = (active: Tab) =>
    h(
      'nav',
      { class: 'tabbar', 'aria-label': 'Main' },
      h(
        'div',
        { class: 'tabbar-inner' },
        TABS.map((t) =>
          h(
            'a',
            { class: 'tab', href: `#/${t.tab}`, 'aria-current': t.tab === active ? 'page' : null },
            icon(t.icon),
            h('span', {}, t.label),
          ),
        ),
      ),
    );

  const renderTab = () => {
    if (!summary) return;
    const tab = currentTab(location.hash);
    const ctx = context();
    const screen =
      tab === 'history'
        ? historyScreen()
        : tab === 'settings'
          ? settingsScreen(ctx)
          : homeScreen(ctx);
    show(screen, tabbar(tab));
  };

  const boot = async () => {
    if (!getToken()) {
      show(joinScreen(() => void boot()));
      return;
    }
    loading();
    try {
      summary = await getSummary();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'device') {
        clearToken();
        show(joinScreen(() => void boot()));
        return;
      }
      failed(e);
      return;
    }
    if (!new GroupView(summary).hasPerson) {
      show(whoScreen(summary, () => void boot()));
      return;
    }
    renderTab();
  };

  window.addEventListener('hashchange', renderTab);
  void boot();
}
