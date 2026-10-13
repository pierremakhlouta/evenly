/** Every failed call becomes an ApiError with a short code and a friendly message. */

export type ApiErrorKind =
  | 'device' // token missing, unknown or revoked: go back to the join screen
  | 'locked' // too many wrong PINs
  | 'input' // the database rejected a value
  | 'network' // offline or the server could not be reached
  | 'config' // the app was built without the Supabase URL or key
  | 'unknown';

const MESSAGES: Record<string, string> = {
  invalid_credentials: "That group code and PIN don't match.",
  locked_out: 'Too many wrong tries. Wait 15 minutes and try again.',
  invalid_device: 'This phone was signed out. Join the group again.',
  no_person: 'Pick who you are first.',
  invalid_pin: "That PIN isn't right.",
  invalid_pin_format: 'PINs are 4 to 12 digits.',
  join_closed: 'Ask an admin to add you to the group.',
  admin_only: 'Only an admin can do this.',
  last_admin: 'The group needs at least one admin. Make someone else admin first.',
  cannot_archive_self: "You can't remove yourself. Ask another admin.",
  invalid_name: 'Names need 1 to 80 characters.',
  invalid_description: 'Add a short description.',
  invalid_total: 'Enter an amount between $0.01 and $1,000,000.',
  invalid_amount: 'That share is more than the total.',
  invalid_fraction: 'The fraction must be between 0 and 1.',
  invalid_percent: 'The percentage must be above 0% and at most 100%.',
  invalid_date: 'That date looks wrong.',
  invalid_party: "That household isn't available.",
  invalid_person: "That person isn't available.",
  entry_deleted: 'This entry was deleted. Restore it first.',
  already_settled: "You're already settled up.",
  balance_changed: 'The balance just changed. Check the new amount and try again.',
  settlement_locked: "A settle-up can't be edited. Delete it and settle again instead.",
  not_found: 'That item no longer exists.',
  invalid_subscription:
    "This phone's notification setup looks wrong. Try turning notifications off and on.",
  network: "Can't reach the server. Check your connection and try again.",
  config: 'The app is missing its server settings.',
};

/** The friendly message for an error code (database or split math). */
export function messageFor(code: string): string {
  return MESSAGES[code] ?? 'Something went wrong. Please try again.';
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly kind: ApiErrorKind,
    readonly detail?: string,
  ) {
    super(messageFor(code));
    this.name = 'ApiError';
  }
}

interface PostgrestError {
  code?: string;
  message?: string;
  details?: string | null;
}

/** Turns a PostgREST error body into an ApiError. */
export function fromPostgrest(body: PostgrestError): ApiError {
  const code = body.message ?? 'unknown';
  const detail = body.details ?? undefined;
  if (code === 'locked_out') return new ApiError(code, 'locked', detail);
  if (body.code === '28000') return new ApiError(code, 'device', detail);
  if (body.code === '22023' || body.code === '23514' || body.code === '42501') {
    return new ApiError(code, 'input', detail);
  }
  return new ApiError(code, 'unknown', detail ?? body.message);
}
