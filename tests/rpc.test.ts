import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors';
import { addEntry, configureRpc, getSummary, registerDevice, rpc } from '../src/api/rpc';

const store = new Map<string, string>();
const fetchMock = vi.fn<typeof fetch>();

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('Expected an ApiError');
}

beforeEach(() => {
  store.clear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  configureRpc({ url: 'https://example.test', key: 'sb_publishable_test' });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('rpc', () => {
  it('posts to the RPC endpoint with the publishable key and drops undefined params', async () => {
    reply(200, 'ok');
    await expect(rpc('ping', { a: 1, b: undefined })).resolves.toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://example.test/rest/v1/rpc/ping');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      apikey: 'sb_publishable_test',
      'Content-Type': 'application/json',
    });
    expect(init?.body).toBe('{"a":1}');
  });

  it('sends the stored device token', async () => {
    store.set('evenly.device-token', 'abc');
    reply(200, {});
    await getSummary();
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"p_token":"abc"}');
  });

  it('maps entry fields to RPC parameters', async () => {
    store.set('evenly.device-token', 'abc');
    reply(200, {});
    await addEntry('expense', {
      description: 'Dinner',
      entry_date: '2026-10-12',
      total_cents: 9000,
      paid_by_party_id: 'h1',
      split_type: 'amount',
      split_num: 3500,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        p_token: 'abc',
        p_kind: 'expense',
        p_description: 'Dinner',
        p_entry_date: '2026-10-12',
        p_total_cents: 9000,
        p_paid_by_party_id: 'h1',
        p_split_type: 'amount',
        p_split_num: 3500,
      }),
    );
  });

  it('fails with a device error when the phone has no token, without calling the server', async () => {
    const error = await caught(getSummary());
    expect(error.kind).toBe('device');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a revoked device to a device error', async () => {
    store.set('evenly.device-token', 'abc');
    reply(403, { code: '28000', message: 'invalid_device', details: 'invalid_device' });
    const error = await caught(getSummary());
    expect([error.kind, error.code]).toEqual(['device', 'invalid_device']);
  });

  it('maps the lockout to a locked error', async () => {
    reply(403, { code: '28000', message: 'locked_out', details: 'Too many wrong attempts.' });
    const error = await caught(registerDevice('K7MQ-2XPA', '1234'));
    expect([error.kind, error.message]).toEqual([
      'locked',
      'Too many wrong tries. Wait 15 minutes and try again.',
    ]);
  });

  it('turns a wrong PIN answer into invalid_credentials', async () => {
    reply(200, { error: 'invalid_credentials' });
    const error = await caught(registerDevice('K7MQ-2XPA', '0000'));
    expect(error.code).toBe('invalid_credentials');
  });

  it('returns the token for a right PIN', async () => {
    reply(200, { token: 'f'.repeat(64) });
    await expect(registerDevice('K7MQ-2XPA', '1234')).resolves.toBe('f'.repeat(64));
  });

  it('maps validation errors to input errors with a friendly message', async () => {
    store.set('evenly.device-token', 'abc');
    reply(400, { code: '22023', message: 'invalid_percent', details: 'Percent must be above 0%' });
    const error = await caught(getSummary());
    expect([error.kind, error.message]).toEqual([
      'input',
      'The percentage must be above 0% and at most 100%.',
    ]);
  });

  it('maps a failed fetch to a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await caught(rpc('ping'));
    expect(error.kind).toBe('network');
  });

  it('fails clearly when the app was built without server settings', async () => {
    configureRpc(null);
    const error = await caught(rpc('ping'));
    expect(error.kind).toBe('config');
  });
});
