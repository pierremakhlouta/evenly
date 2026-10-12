/** Dates are calendar days (YYYY-MM-DD) in the group's time zone, America/Toronto. */
import { LOCALE, TIME_ZONE } from './config';

/** Today's date in the given time zone as YYYY-MM-DD. */
export function today(now: Date = new Date(), timeZone: string = TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A calendar day as a Date at UTC midnight, so formatting never shifts the day. */
function utcDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

/** 'Oct 12', or 'Oct 12, 2025' when not in the current year. */
export function formatDay(isoDate: string, todayIso: string = today()): string {
  const sameYear = isoDate.slice(0, 4) === todayIso.slice(0, 4);
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(utcDay(isoDate));
}

/** 'October 2026' for a month heading. */
export function formatMonth(isoDate: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(utcDay(isoDate));
}
