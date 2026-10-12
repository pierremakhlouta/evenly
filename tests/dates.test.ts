import { describe, expect, it } from 'vitest';
import { formatDay, formatMonth, today } from '../src/dates';

describe('today', () => {
  it('uses Toronto time, not UTC', () => {
    // 02:30 UTC on Oct 13 is still Oct 12 in Toronto (UTC-4 in October).
    expect(today(new Date('2026-10-13T02:30:00Z'))).toBe('2026-10-12');
    expect(today(new Date('2026-10-13T04:30:00Z'))).toBe('2026-10-13');
  });
});

describe('formatDay', () => {
  it('leaves out the year in the current year', () => {
    expect(formatDay('2026-10-01', '2026-10-12')).toBe('Oct 1');
  });

  it('shows the year for other years', () => {
    expect(formatDay('2025-12-31', '2026-01-02')).toBe('Dec 31, 2025');
  });

  it('never shifts the day across time zones', () => {
    expect(formatDay('2026-01-01', '2026-06-01')).toBe('Jan 1');
  });
});

describe('formatMonth', () => {
  it('names the month and year', () => {
    expect(formatMonth('2026-10-01')).toBe('October 2026');
  });
});
