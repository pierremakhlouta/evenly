import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { describe, expect, it } from 'vitest';
import {
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  sendPush,
  toBase64Url,
  vapidAuthorization,
} from '../supabase/functions/_shared/webpush';

/** A browser's push keys, made with Node's own crypto (independent of the code under test). */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, p256dh: toBase64Url(ecdh.getPublicKey()), authText: toBase64Url(auth) };
}

describe('base64url', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect([...fromBase64Url(text)]).toEqual([...bytes]);
  });
});

describe('encryptPayload (RFC 8291)', () => {
  it('produces a message the reference implementation decrypts', async () => {
    const ua = browserKeys();
    const body = await encryptPayload(new TextEncoder().encode('Sam added Hydro · $134.12'), {
      p256dh: ua.p256dh,
      auth: ua.authText,
    });
    const plain = ece.decrypt(Buffer.from(body), {
      version: 'aes128gcm',
      privateKey: ua.ecdh,
      authSecret: ua.auth,
    });
    expect(plain.toString('utf8')).toBe('Sam added Hydro · $134.12');
  });

  it('writes the aes128gcm header: salt, record size 4096, and the 65-byte server key', async () => {
    const ua = browserKeys();
    const salt = new Uint8Array(16).fill(7);
    const body = await encryptPayload(
      new Uint8Array([1, 2, 3]),
      { p256dh: ua.p256dh, auth: ua.authText },
      { salt },
    );
    expect([...body.slice(0, 16)]).toEqual([...salt]);
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(4); // uncompressed point
    expect(body.length).toBe(16 + 4 + 1 + 65 + 3 + 1 + 16); // header + payload + delimiter + GCM tag
  });

  it('uses a fresh salt and server key every time', async () => {
    const ua = browserKeys();
    const target = { p256dh: ua.p256dh, auth: ua.authText };
    const a = await encryptPayload(new Uint8Array([1]), target);
    const b = await encryptPayload(new Uint8Array([1]), target);
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a JWT for the push service origin that verifies with the public key', async () => {
    const keys = { ...(await generateVapidKeys()), subject: 'mailto:test@example.com' };
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    const header = await vapidAuthorization('https://push.example.net/send/abc', keys, now);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match ?? [];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(c ?? '')))).toEqual({
      aud: 'https://push.example.net',
      exp: now / 1000 + 12 * 3600,
      sub: 'mailto:test@example.com',
    });

    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      fromBase64Url(s ?? ''),
      new TextEncoder().encode(`${h ?? ''}.${c ?? ''}`),
    );
    expect(valid).toBe(true);
  });
});

describe('sendPush', () => {
  it('posts the encrypted body with the push headers, and flags gone subscriptions', async () => {
    const ua = browserKeys();
    const vapid = { ...(await generateVapidKeys()), subject: 'mailto:test@example.com' };
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 410 }));
    }) as unknown as typeof fetch;

    const result = await sendPush(
      { endpoint: 'https://push.example.net/send/abc', p256dh: ua.p256dh, auth: ua.authText },
      { title: 'Test House', body: 'Hello' },
      vapid,
      fakeFetch,
    );
    expect(result).toEqual({
      endpoint: 'https://push.example.net/send/abc',
      status: 410,
      gone: true,
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe('86400');
    expect(headers.Authorization).toMatch(/^vapid t=/);
    const plain = ece.decrypt(Buffer.from(calls[0]?.init.body as Uint8Array), {
      version: 'aes128gcm',
      privateKey: ua.ecdh,
      authSecret: ua.auth,
    });
    expect(JSON.parse(plain.toString('utf8'))).toEqual({ title: 'Test House', body: 'Hello' });
  });
});
