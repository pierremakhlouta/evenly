/**
 * Turning notifications on and off on this phone. The browser asks for permission,
 * subscribes with the app's public VAPID key, and the subscription is stored in the
 * database so the notify Edge Function can reach this phone.
 */
import { deletePushSubscription, savePushSubscription } from './api/rpc';

export type PushState =
  | 'unconfigured' // the app was built without a VAPID public key
  | 'needs-install' // iPhone: only apps added to the Home Screen can get notifications
  | 'unsupported' // this browser can't do Web Push
  | 'blocked' // the person said no; only the phone's settings can undo it
  | 'off'
  | 'on';

const publicKey = (): string => import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/** base64url -> bytes, for applicationServerKey. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!publicKey()) return 'unconfigured';
  if (!('PushManager' in window) || !('Notification' in window)) {
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await registration();
  if (!reg) return 'unsupported';
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

/** Asks for permission (must run from a tap), subscribes and saves the subscription. */
export async function turnOn(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey()),
    }));
  const json = sub.toJSON();
  await savePushSubscription(sub.endpoint, json.keys?.p256dh ?? '', json.keys?.auth ?? '');
  return 'on';
}

export async function turnOff(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await deletePushSubscription(sub.endpoint);
    await sub.unsubscribe();
  }
  return 'off';
}
