import { CURRENCY, LOCALE } from '../config';

const currency = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY });

/** Exact decimal string for integer cents: 123456 -> "1234.56", -5 -> "-0.05". */
function centsToDecimal(cents: number): `${number}` {
  if (!Number.isSafeInteger(cents)) throw new Error('Cents must be a whole number');
  const abs = Math.abs(cents);
  const dollars = String((abs - (abs % 100)) / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${dollars}.${rest}` as `${number}`;
}

/** 123456 -> "$1,234.56". Formats from an exact decimal string, never cents / 100. */
export function formatCents(cents: number): string {
  return currency.format(centsToDecimal(cents));
}

/** Value to pre-fill an amount input when editing: 123456 -> "1234.56". */
export function centsToInput(cents: number): string {
  return centsToDecimal(cents);
}

/** Longest dollar part accepted, so the result is always a safe integer. */
const MAX_DOLLAR_DIGITS = 12;

/**
 * Parses what someone typed into an amount field into integer cents, or null if
 * it is not a valid non-negative amount with at most 2 decimals.
 *
 * Accepts "12", "12.3", "12.34", ".5", "12.", "$1,234.56" and a decimal comma
 * ("12,50") as shown by French-language phone keypads. When there is no dot, a
 * comma followed by 1 or 2 digits at the end is the decimal mark; otherwise
 * commas are thousands separators.
 */
export function parseAmountToCents(input: string): number | null {
  let s = input.trim().replace(/^\$/, '').replace(/\s/g, '');
  if (!s.includes('.') && /,\d{1,2}$/.test(s)) {
    const i = s.lastIndexOf(',');
    s = `${s.slice(0, i)}.${s.slice(i + 1)}`;
  }
  s = s.replace(/,/g, '');

  const match = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!match) return null;
  const dollars = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (dollars === '' && fraction === '') return null;
  if (dollars.length > MAX_DOLLAR_DIGITS) return null;

  return Number(dollars || '0') * 100 + Number(fraction.padEnd(2, '0'));
}
