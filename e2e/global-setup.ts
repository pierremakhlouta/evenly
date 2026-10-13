import { sql } from './db';

/** Clears PIN attempts so repeated runs never trip the lockout. */
export default function globalSetup(): void {
  sql('delete from private.pin_attempts;');
}
