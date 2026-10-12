/**
 * Typed wrappers for the database RPCs. The app never reads tables; every call is a
 * POST to /rest/v1/rpc/<name> with the publishable key, and every call except
 * register_device and ping sends this phone's device token.
 */
import { ApiError, fromPostgrest } from './errors';
import { getToken } from './token';
import type {
  Device,
  Entry,
  EntryInput,
  EntryPage,
  EntryKind,
  EntryWithEvents,
  RecurringBill,
  Summary,
} from './types';

const TIMEOUT_MS = 15_000;

export interface RpcConfig {
  url: string;
  key: string;
}

let config: RpcConfig | null = null;

export function configureRpc(next: RpcConfig | null): void {
  config = next;
}

export function rpcConfigFromEnv(): RpcConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url: url.replace(/\/+$/, ''), key } : null;
}

/** Drops undefined values so the database defaults apply. */
function clean(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
}

export async function rpc<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!config) throw new ApiError('config', 'config');

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(clean(params)),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('network', 'network');
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const body: unknown = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    if (body === null || typeof body !== 'object') {
      throw new ApiError(
        response.status >= 500 ? 'network' : 'unknown',
        response.status >= 500 ? 'network' : 'unknown',
      );
    }
    throw fromPostgrest(body);
  }
  return body as T;
}

/** Calls an RPC with this phone's token. Rejects with a device error if the phone has not joined. */
async function withToken<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError('invalid_device', 'device');
  return rpc<T>(name, { p_token: token, ...params });
}

function entryParams(input: EntryInput): Record<string, unknown> {
  return {
    p_description: input.description,
    p_entry_date: input.entry_date,
    p_total_cents: input.total_cents,
    p_paid_by_party_id: input.paid_by_party_id,
    p_paid_by_person_id: input.paid_by_person_id,
    p_split_type: input.split_type,
    p_split_num: input.split_num,
    p_split_den: input.split_den,
    p_split_inputs: input.split_inputs,
    p_to_party_id: input.to_party_id,
  };
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

/** Returns the new device token. Throws invalid_credentials or locked_out. */
export async function registerDevice(
  groupCode: string,
  pin: string,
  label?: string,
): Promise<string> {
  const result = await rpc<{ token?: string; error?: string }>('register_device', {
    p_group_code: groupCode,
    p_pin: pin,
    p_label: label || undefined,
  });
  if (!result.token) throw new ApiError(result.error ?? 'invalid_credentials', 'input');
  return result.token;
}

/**
 * Picks this phone's person. If they have a PIN it must match; if not, it becomes
 * their new PIN. Throws invalid_pin for a wrong PIN.
 */
export async function setDevicePerson(personId: string, pin: string): Promise<void> {
  const result = await withToken<{ ok?: boolean; error?: string }>('set_device_person', {
    p_person_id: personId,
    p_pin: pin,
  });
  if (!result.ok) throw new ApiError(result.error ?? 'invalid_pin', 'input');
}

/** Only for the first person of an empty group, who becomes admin. */
export const addSelf = (name: string, partyId: string | null, pin: string) =>
  withToken<string>('add_self', { p_name: name, p_party_id: partyId, p_pin: pin });

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export const getSummary = () => withToken<Summary>('get_summary');

export const listEntries = (
  opts: { deleted?: boolean; limit?: number; before?: string | null } = {},
) =>
  withToken<EntryPage>('list_entries', {
    p_deleted: opts.deleted,
    p_limit: opts.limit,
    p_before: opts.before ?? undefined,
  });

export const getEntry = (id: string) => withToken<EntryWithEvents>('get_entry', { p_id: id });

export const addEntry = (kind: EntryKind, input: EntryInput) =>
  withToken<Entry>('add_entry', { p_kind: kind, ...entryParams(input) });

export const editEntry = (id: string, input: EntryInput) =>
  withToken<Entry>('edit_entry', { p_id: id, ...entryParams(input) });

export const deleteEntry = (id: string) => withToken<Entry>('delete_entry', { p_id: id });

export const restoreEntry = (id: string) => withToken<Entry>('restore_entry', { p_id: id });

// ---------------------------------------------------------------------------
// Settings (used from Phase 5 on)
// ---------------------------------------------------------------------------

export const listRecurringBills = () => withToken<RecurringBill[]>('list_recurring_bills');

export const listDevices = () => withToken<Device[]>('list_devices');

export const revokeDevice = (id: string) => withToken<null>('revoke_device', { p_id: id });

export const updateGroup = (name: string) => withToken<null>('update_group', { p_name: name });

/** Admin only. Creates (id null) or updates a person. */
export const upsertPerson = (id: string | null, name: string, partyId: string | null) =>
  withToken<string>('upsert_person', { p_id: id, p_name: name, p_party_id: partyId });

export const exportEntries = () => withToken<Entry[]>('export_entries');
