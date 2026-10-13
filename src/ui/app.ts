/**
 * App shell: boots the phone (join, pick person, or straight in), routes between
 * tabs with the URL hash (#/home, #/history, #/settings), owns the shared data,
 * and keeps phones in sync.
 *
 * Sync (no Realtime on purpose, see DECISIONS.md): refetch when the app comes back
 * into view, every 30 seconds while visible, after every write, and on the refresh
 * button. A background refresh only re-renders when the data actually changed and
 * nobody is typing, so it never wipes a half-filled form.
 */
import { ApiError } from '../api/errors';
import { getSummary, listEntries, listRecurringBills } from '../api/rpc';
import { clearToken, getToken } from '../api/token';
import type { Entry, RecurringBill, Summary } from '../api/types';
import { h, replace } from './dom';
import { messageOf } from './errors';
import { icon, type IconName } from './icons';
import { openEntrySheet } from './screens/entry';
import { openExpenseSheet } from './screens/expense';
import { historyScreen } from './screens/history';
import { homeScreen } from './screens/home';
import { joinScreen } from './screens/join';
import { openPaymentSheet } from './screens/payment';
import { openPeopleExpenseSheet } from './screens/people-expense';
import { openPeoplePaymentSheet } from './screens/people-payment';
import { settingsScreen } from './screens/settings';
import { whoScreen } from './screens/who';
import { GroupView } from './state';

export type Tab = 'home' | 'history' | 'settings';

const POLL_MS = 30_000;
/** Home shows the open period; more than this many entries are in History. */
const RECENT_COUNT = 50;

/** What every tab screen gets. */
export interface AppContext {
  /** The app root, where sheets are mounted. */
  root: HTMLElement;
  view: GroupView;
  /** Entries added since the last settle-up (the open period), newest first, for Home. */
  recent: Entry[];
  /** Saved monthly bills, active first, in sort order. */
  bills: RecurringBill[];
  /** Re-fetches everything and re-renders the current tab. Call after every write. */
  refresh: () => Promise<void>;
  /** Signs this phone out of the group (back to the join screen). */
  leave: () => void;
  /** Goes back to "Who are you?" to switch person. */
  switchPerson: () => void;
  /** Opens an entry's details sheet. */
  openEntry: (entry: Entry) => void;
}

interface AppData {
  summary: Summary;
  recent: Entry[];
  bills: RecurringBill[];
}

const TABS: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'home', label: 'Home', icon: 'home' },
  { tab: 'history', label: 'History', icon: 'history' },
  { tab: 'settings', label: 'Settings', icon: 'settings' },
];

export function currentTab(hash: string): Tab {
  const name = hash.replace(/^#\/?/, '').split('/')[0];
  return name === 'history' || name === 'settings' ? name : 'home';
}

/** True while someone is typing or has a form open, so a background refresh must wait. */
function isEditing(root: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    root.querySelector('form') !== null ||
    (active instanceof HTMLElement &&
      root.contains(active) &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
  );
}

async function loadData(): Promise<AppData> {
  const summary = await getSummary();
  const [page, bills] = await Promise.all([
    listEntries({ limit: RECENT_COUNT, createdAfter: summary.last_settled_at }),
    listRecurringBills(),
  ]);
  return { summary, recent: page.entries, bills };
}

export function startApp(root: HTMLElement): void {
  let data: AppData | null = null;
  let renderedJson = '';
  let inFlight: Promise<void> | null = null;

  const offlineBanner = h(
    'div',
    { class: 'offline-banner', role: 'status', hidden: navigator.onLine },
    "You're offline. Changes are paused until you reconnect.",
  );
  const updateOnline = () => {
    offlineBanner.hidden = navigator.onLine;
    document.documentElement.classList.toggle('offline', !navigator.onLine);
  };

  const show = (children: Node[], keepScroll = false) => {
    const y = window.scrollY;
    replace(root, offlineBanner, ...children);
    window.scrollTo(0, keepScroll ? y : 0);
  };

  const loading = () => {
    show([h('main', { class: 'screen screen-center' }, h('p', { class: 'loading' }, 'Loading…'))]);
  };

  const failed = (error: unknown) => {
    show([
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
    ]);
  };

  const leave = () => {
    clearToken();
    data = null;
    renderedJson = '';
    void boot();
  };

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

  const context = (current: AppData): AppContext => ({
    root,
    view: new GroupView(current.summary),
    recent: current.recent,
    bills: current.bills,
    refresh: () => refresh(true),
    leave,
    switchPerson: () => {
      show([whoScreen(current.summary, () => void boot())]);
    },
    openEntry: (entry) => {
      const ctx = context(current);
      openEntrySheet(ctx, entry, (e) => {
        const people = ctx.view.mode === 'people';
        if (e.kind === 'expense') {
          if (people) openPeopleExpenseSheet(ctx, root, e);
          else openExpenseSheet(ctx, root, e);
        } else if (people) openPeoplePaymentSheet(ctx, root, e);
        else openPaymentSheet(ctx, root, e);
      });
    },
  });

  const renderTab = (keepScroll = false) => {
    if (!data) return;
    renderedJson = JSON.stringify(data);
    const tab = currentTab(location.hash);
    const ctx = context(data);
    const screen =
      tab === 'history'
        ? historyScreen(ctx)
        : tab === 'settings'
          ? settingsScreen(ctx)
          : homeScreen(ctx);
    show([screen, tabbar(tab)], keepScroll);
  };

  /**
   * Fetches fresh data. force = true (after a write or a tap on refresh) always
   * re-renders and reports errors; a background refresh re-renders only when the
   * data changed and nobody is editing, and ignores network errors.
   */
  const refresh = (force: boolean): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await loadData();
        data = next;
        if (!new GroupView(next.summary).hasPerson) {
          show([whoScreen(next.summary, () => void boot())]);
          return;
        }
        if (force || (JSON.stringify(next) !== renderedJson && !isEditing(root))) {
          renderTab(true);
        }
      } catch (e) {
        if (e instanceof ApiError && e.kind === 'device') {
          leave();
          return;
        }
        if (force) throw e;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const boot = async () => {
    if (!getToken()) {
      show([joinScreen(() => void boot())]);
      return;
    }
    loading();
    try {
      data = await loadData();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'device') {
        clearToken();
        show([joinScreen(() => void boot())]);
        return;
      }
      failed(e);
      return;
    }
    if (!new GroupView(data.summary).hasPerson) {
      show([whoScreen(data.summary, () => void boot())]);
      return;
    }
    renderTab();
  };

  const backgroundRefresh = () => {
    if (data && document.visibilityState === 'visible' && navigator.onLine) void refresh(false);
  };

  window.addEventListener('hashchange', () => {
    renderTab();
  });
  document.addEventListener('visibilitychange', backgroundRefresh);
  window.addEventListener('online', () => {
    updateOnline();
    backgroundRefresh();
  });
  window.addEventListener('offline', updateOnline);
  setInterval(backgroundRefresh, POLL_MS);

  updateOnline();
  void boot();
}
