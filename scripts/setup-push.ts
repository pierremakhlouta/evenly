/**
 * One-time production setup for notifications. Generates a VAPID key pair and
 * stores it directly where it belongs, so the private key is never printed:
 *   - VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT -> Supabase function secrets
 *   - VITE_VAPID_PUBLIC_KEY -> GitHub repository variable (public by design)
 * Run from the repo folder after `supabase link`: `npm run setup:push`
 * Running it again rotates the keys (every phone then turns notifications on again).
 */
import { execFileSync } from 'node:child_process';
import { generateVapidKeys } from '../supabase/functions/_shared/webpush.ts';

const SUBJECT = 'https://pierremakhlouta.github.io/evenly/';

const keys = await generateVapidKeys();
execFileSync(
  'supabase',
  [
    'secrets',
    'set',
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    `VAPID_SUBJECT=${SUBJECT}`,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);
execFileSync('gh', ['variable', 'set', 'VITE_VAPID_PUBLIC_KEY', '--body', keys.publicKey], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
console.log('Push keys saved: private key in Supabase secrets, public key in the GitHub variable.');
