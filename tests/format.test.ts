import { describe, expect, it } from 'vitest';
import { centsToInput, formatCents, parseAmountToCents } from '../src/money/format';

describe('formatCents', () => {
  it.each([
    [0, '$0.00'],
    [1, '$0.01'],
    [99, '$0.99'],
    [100, '$1.00'],
    [123456, '$1,234.56'],
    [100000000, '$1,000,000.00'],
    [-4000, '-$40.00'],
    [-5, '-$0.05'],
  ])('%i cents is %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it('formats amounts float division would get wrong', () => {
    // 1.005 * 100 style errors: these must come out exactly.
    expect(formatCents(100_5)).toBe('$10.05');
    expect(formatCents(8_123_456_789_01)).toBe('$8,123,456,789.01');
  });

  it('rejects non-integer cents', () => {
    expect(() => formatCents(1.5)).toThrow();
  });
});

describe('centsToInput', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [3500, '35.00'],
    [123456, '1234.56'],
  ])('%i cents is %s', (cents, text) => {
    expect(centsToInput(cents)).toBe(text);
  });
});

describe('parseAmountToCents', () => {
  it.each([
    ['12', 1200],
    ['12.3', 1230],
    ['12.34', 1234],
    ['0.01', 1],
    ['.5', 50],
    ['12.', 1200],
    [' 90 ', 9000],
    ['$35', 3500],
    ['$1,234.56', 123456],
    ['1,234', 123400],
    ['1,234,567.89', 123456789],
    ['12,5', 1250],
    ['12,50', 1250],
    ['1 234,56', 123456],
    ['0', 0],
    ['1.10', 110],
    ['4.35', 435],
    ['999999999999.99', 99999999999999],
  ])('%s is %i cents', (text, cents) => {
    expect(parseAmountToCents(text)).toBe(cents);
  });

  it.each([
    [''],
    ['   '],
    ['.'],
    ['$'],
    ['abc'],
    ['12.345'],
    ['-5'],
    ['1e3'],
    ['12..3'],
    ['1.2.3'],
    ['1000000000000'],
  ])('rejects %j', (text) => {
    expect(parseAmountToCents(text)).toBeNull();
  });

  it('round-trips with centsToInput', () => {
    for (const cents of [0, 1, 10, 99, 100, 435, 110, 123456, 100000000]) {
      expect(parseAmountToCents(centsToInput(cents))).toBe(cents);
    }
  });
});
