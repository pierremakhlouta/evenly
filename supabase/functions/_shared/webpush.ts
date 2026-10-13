/**
 * Web Push with nothing but Web Crypto, so it runs the same in Supabase Edge
 * Functions (Deno) and in Vitest (Node):
 *   - VAPID authentication (RFC 8292): an ES256 JWT signed with the server key
 *   - payload encryption (RFC 8291) with the aes128gcm content coding (RFC 8188)
 * No third-party push service is involved; the browser's own push service
 * (Apple, Google or Mozilla) delivers the encrypted message.
 */

export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (65 bytes). */
  publicKey: string;
  /** P-256 private key scalar d, base64url (32 bytes). */
  privateKey: string;
  /** Contact for the push service, for example mailto:someone@example.com. */
  subject: string;
}

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8),
  );
}

/** A new VAPID key pair (run once, with `npm run vapid`). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: toBase64Url(raw), privateKey: jwk.d ?? '' };
}

/** The Authorization header value for one push service (RFC 8292). */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now = Date.now(),
): Promise<string> {
  const pub = fromBase64Url(keys.publicKey);
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: toBase64Url(pub.slice(1, 33)),
      y: toBase64Url(pub.slice(33, 65)),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  // Web Crypto ECDSA signatures are raw r || s, which is exactly the JWS format.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      encoder.encode(unsigned),
    ),
  );
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypts a payload for one browser (RFC 8291, aes128gcm). `salt` and
 * `serverKeys` are only passed in by tests; normally both are fresh and random.
 */
export async function encryptPayload(
  payload: Uint8Array,
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  options: { salt?: Uint8Array<ArrayBuffer>; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromBase64Url(target.p256dh);
  const authSecret = fromBase64Url(target.auth);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const server =
    options.serverKeys ??
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256),
  );

  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the payload followed by the 0x02 "last record" delimiter.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      concat(payload, new Uint8Array([2])),
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

export interface SendResult {
  endpoint: string;
  status: number;
  /** The browser unsubscribed (404 or 410): the subscription should be deleted. */
  gone: boolean;
}

/** Encrypts and sends one notification. */
export async function sendPush(
  target: PushTarget,
  message: unknown,
  vapid: VapidKeys,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const body = await encryptPayload(encoder.encode(JSON.stringify(message)), target);
  const response = await fetchImpl(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(24 * 60 * 60),
      Urgency: 'normal',
    },
    body,
  });
  return {
    endpoint: target.endpoint,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
  };
}
