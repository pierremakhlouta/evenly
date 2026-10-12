/**
 * The device token, stored once per phone. localStorage can throw (private mode,
 * blocked storage), so every access is guarded and failure means "not joined".
 */

const KEY = 'evenly.device-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Storage blocked: the phone will have to join again next time.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
