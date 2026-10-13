/**
 * notify: sends the Web Push notifications for one change-log event.
 *
 * Called only by the database (private.queue_push, through pg_net) with
 * {"event_id": n} and the shared secret from Vault. It reads the message and the
 * phones to notify from the database, sends each push, and deletes subscriptions
 * the browser has dropped (404 or 410). Deployed with --no-verify-jwt because it
 * checks its own secret; nothing else can make it send anything.
 *
 * Secrets (Supabase function secrets, never in the repo): VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY, VAPID_SUBJECT. SUPABASE_DB_URL is provided by Supabase.
 */
import postgres from 'npm:postgres@3.4.9';
import { sendPush, type PushTarget } from '../_shared/webpush.ts';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL') ?? '', { prepare: false, max: 2 });

const vapid = {
  publicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
  privateKey: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
  subject: Deno.env.get('VAPID_SUBJECT') ?? '',
};

/** Compares two strings in constant time, so the secret can't be guessed by timing. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const [row] = await sql<{ secret: string }[]>`
    select decrypted_secret as secret from vault.decrypted_secrets where name = 'evenly_notify_secret'`;
  const given = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
  if (!row?.secret || !sameSecret(given, row.secret))
    return new Response('Unauthorized', { status: 401 });

  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) {
    return new Response('Push keys are not configured', { status: 500 });
  }

  const { event_id: eventId } = (await req.json()) as { event_id?: unknown };
  if (typeof eventId !== 'number' || !Number.isSafeInteger(eventId)) {
    return new Response('Bad request', { status: 400 });
  }

  const [{ message }] = await sql<
    { message: unknown }[]
  >`select private.push_message(${eventId}) as message`;
  const targets = await sql<(PushTarget & { id: string })[]>`
    select id, endpoint, p256dh, auth from private.push_targets(${eventId})`;

  const results = await Promise.allSettled(targets.map((t) => sendPush(t, message, vapid)));
  const gone = targets.filter((_, i) => {
    const r = results[i];
    return r?.status === 'fulfilled' && r.value.gone;
  });
  if (gone.length) {
    await sql`delete from private.push_subscriptions where id = any(${gone.map((t) => t.id)})`;
  }

  const sent = results.filter((r) => r.status === 'fulfilled' && r.value.status < 300).length;
  return Response.json({ sent, gone: gone.length, failed: targets.length - sent - gone.length });
});
