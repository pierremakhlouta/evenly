/**
 * History: settle-up periods, newest first. The open period (since the last
 * settle-up) is at the top; tap any period to see its entries.
 *
 * The open period lives in the URL (#/history/open, #/history/<settled-until>), so a
 * background refresh or the browser's back button keeps you where you were.
 */
import { listEntries, listPeriods } from '../../api/rpc';
import type { Entry, PeriodInfo, Periods, SettledPeriod } from '../../api/types';
import { formatDay } from '../../dates';
import { formatCents } from '../../money/format';
import type { AppContext } from '../app';
import { h, replace } from '../dom';
import { messageOf } from '../errors';
import { icon } from '../icons';
import type { GroupView } from '../state';
import { entryRow } from '../components/entry-row';

const PAGE = 100;

/** 'Sep 1 to Sep 30', 'Sep 30', or '' when the period is empty. */
export function dateRange(period: PeriodInfo): string {
  if (!period.first_date || !period.last_date) return '';
  const first = formatDay(period.first_date);
  const last = formatDay(period.last_date);
  return first === last ? first : `${first} to ${last}`;
}

function countText(n: number): string {
  return n === 1 ? '1 entry' : `${String(n)} entries`;
}

export function settledText(view: GroupView, period: SettledPeriod): string {
  const all = period.settlements ?? [period.settlement];
  if (all.length > 1) {
    const total = all.reduce((sum, e) => sum + e.total_cents, 0);
    return `Settled ${formatCents(total)} in ${String(all.length)} payments on ${formatDay(period.settlement.entry_date)}`;
  }
  const s = period.settlement;
  const payer = s.paid_by_person_id
    ? view.personName(s.paid_by_person_id)
    : view.partyName(s.paid_by_party_id);
  return `${payer} settled ${formatCents(s.total_cents)} on ${formatDay(s.entry_date)}`;
}

/** The part of the hash after #/history/ ('' for the list). */
function selection(): string {
  return decodeURIComponent(location.hash.replace(/^#\/?history\/?/, ''));
}

export function historyScreen(ctx: AppContext): HTMLElement {
  const { view } = ctx;
  const body = h('div', { class: 'stack' }, h('p', { class: 'loading' }, 'Loading…'));
  const title = h('h1', {}, 'History');
  const back = h(
    'a',
    { class: 'icon-btn', href: '#/history', 'aria-label': 'All periods', hidden: true },
    icon('back'),
  );

  const showError = (e: unknown) => {
    replace(body, h('p', { class: 'error', role: 'alert' }, messageOf(e)));
  };

  const showList = (periods: Periods) => {
    const open = periods.current;
    const card = (href: string, heading: string, lines: string[]) =>
      h(
        'a',
        { class: 'list-item chevron period', href },
        h(
          'div',
          { class: 'entry-main' },
          h('span', { class: 'entry-title' }, heading),
          ...lines.map((l) => h('span', { class: 'entry-meta muted' }, l)),
        ),
      );

    replace(
      body,
      h(
        'section',
        { class: 'stack' },
        h('h2', { class: 'section-title' }, 'Open'),
        h(
          'div',
          { class: 'list' },
          card('#/history/open', open.last_date ? `Since the last settle-up` : 'Nothing yet', [
            [countText(open.entry_count), dateRange(open)].filter(Boolean).join(' · '),
          ]),
        ),
      ),
      periods.settled.length
        ? h(
            'section',
            { class: 'stack' },
            h('h2', { class: 'section-title' }, 'Settled'),
            h(
              'div',
              { class: 'list' },
              periods.settled.map((p) =>
                card(
                  `#/history/${encodeURIComponent(p.created_until)}`,
                  dateRange(p) || formatDay(p.settlement.entry_date),
                  [settledText(view, p), countText(p.entry_count)],
                ),
              ),
            ),
          )
        : h(
            'p',
            { class: 'empty' },
            'Settled months will show up here after your first settle-up.',
          ),
      h(
        'section',
        { class: 'stack' },
        h(
          'div',
          { class: 'list' },
          card('#/history/deleted', 'Deleted entries', ['Restore anything deleted by mistake']),
        ),
      ),
    );
  };

  const showPeriod = (
    heading: string,
    sub: string,
    bounds: { createdAfter?: string | null; createdUntil?: string | null; deleted?: boolean },
    emptyText = 'No entries in this period.',
  ) => {
    title.textContent = heading;
    back.hidden = false;
    const list = h('div', { class: 'list' });
    const more = h('button', { type: 'button', class: 'btn btn-ghost', hidden: true }, 'Load more');
    let before: string | null = null;

    const load = async () => {
      const page = await listEntries({ limit: PAGE, before, ...bounds });
      list.append(...page.entries.map((e: Entry) => entryRow(ctx, e)));
      before = page.next_before;
      more.hidden = before === null;
      if (!list.childElementCount) list.replaceWith(h('p', { class: 'empty' }, emptyText));
    };
    more.addEventListener('click', () => {
      load().catch(showError);
    });

    replace(body, h('p', { class: 'muted' }, sub), list, more);
    load().catch(showError);
  };

  listPeriods()
    .then((periods) => {
      const sel = selection();
      if (sel === 'deleted') {
        showPeriod(
          'Deleted',
          'Deleted entries leave the balance. Tap one to restore it.',
          { deleted: true },
          'Nothing has been deleted.',
        );
        return;
      }
      if (sel === 'open') {
        showPeriod(
          'Open period',
          [countText(periods.current.entry_count), dateRange(periods.current)]
            .filter(Boolean)
            .join(' · '),
          {
            createdAfter: periods.current.created_after,
          },
        );
        return;
      }
      const settled = sel ? periods.settled.find((p) => p.created_until === sel) : undefined;
      if (settled) {
        showPeriod(
          dateRange(settled) || 'Settled period',
          `${settledText(view, settled)} · ${countText(settled.entry_count)}`,
          {
            createdAfter: settled.created_after,
            createdUntil: settled.created_until,
          },
        );
        return;
      }
      showList(periods);
    })
    .catch(showError);

  return h(
    'main',
    { class: 'screen with-tabbar' },
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-title' }, back, title)),
    body,
  );
}
