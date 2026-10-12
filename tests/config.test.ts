import { describe, expect, it } from 'vitest';
import { APP_NAME, CURRENCY, LOCALE, TIME_ZONE } from '../src/config';

describe('config', () => {
  it('names the app Evenly', () => {
    expect(APP_NAME).toBe('Evenly');
  });

  it('uses Canadian dollars and Toronto time', () => {
    expect(CURRENCY).toBe('CAD');
    expect(LOCALE).toBe('en-CA');
    expect(TIME_ZONE).toBe('America/Toronto');
  });
});
