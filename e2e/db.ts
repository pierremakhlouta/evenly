/**
 * Test data straight into the local database (never production): each test gets
 * its own fresh group, so tests can run in parallel and never touch the seed.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const CONTAINER = 'supabase_db_evenly';

export function sql(query: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    {
      input: query,
      encoding: 'utf8',
    },
  ).trim();
}

export const GROUP_PIN = '2468';
export const PERSONAL_PIN = '1357';

export interface TestGroup {
  code: string;
  h1: string;
  h2: string;
  /** Device token for Alex (Main floor, admin, has a PIN). */
  alexToken: string;
  alex: string;
  sam: string;
}

/** An empty household group: returns its code. */
export function emptyGroup(): string {
  return sql(
    `select private.create_group('E2E ${randomUUID().slice(0, 8)}', 'households', '${GROUP_PIN}');`,
  );
}

/**
 * A household group with Alex (Main floor, admin) on a phone, and Sam (Basement
 * suite) added by Alex but without a PIN yet.
 */
export function householdGroup(): TestGroup {
  const code = emptyGroup();
  const json = sql(`
    do $$
    declare
      v_code text := '${code}';
      v_group uuid := (select group_id from private.group_secrets where code = private.normalize_code(v_code));
      v_h1 uuid := (select id from public.parties where group_id = v_group and sort_order = 1);
      v_h2 uuid := (select id from public.parties where group_id = v_group and sort_order = 2);
      v_tok text := public.register_device(v_code, '${GROUP_PIN}', 'E2E phone') ->> 'token';
      v_alex uuid;
      v_sam uuid;
    begin
      update public.parties set name = 'Main floor' where id = v_h1;
      update public.parties set name = 'Basement suite' where id = v_h2;
      v_alex := public.add_self(v_tok, 'Alex', v_h1, '${PERSONAL_PIN}');
      v_sam := public.upsert_person(v_tok, null, 'Sam', v_h2);
      create temp table e2e_out as
        select jsonb_build_object('code', v_code, 'h1', v_h1, 'h2', v_h2, 'alexToken', v_tok,
                                  'alex', v_alex, 'sam', v_sam)::text as j;
    end $$;
    select j from e2e_out;`);
  return JSON.parse(json.split('\n').pop() ?? '{}') as TestGroup;
}

/** Adds an expense paid by Alex through the real RPC. */
export function addExpense(
  group: TestGroup,
  description: string,
  totalCents: number,
  splitType = 'third',
  splitNum: number | null = null,
): void {
  const num = splitNum === null ? 'null' : String(splitNum);
  sql(
    `select public.add_entry('${group.alexToken}', 'expense', '${description}', private.today(), ${String(totalCents)}, '${group.h1}', '${group.alex}', '${splitType}', ${num});`,
  );
}

/** Adds a payment from the basement suite to the main floor through the real RPC. */
export function addPayment(group: TestGroup, note: string, totalCents: number): void {
  sql(
    `select public.add_entry('${group.alexToken}', 'payment', '${note}', private.today(), ${String(totalCents)}, '${group.h2}');`,
  );
}

/** Saves a monthly bill paid by the main floor through the real RPC. */
export function addBill(
  group: TestGroup,
  name: string,
  splitType: string,
  defaultCents: number | null = null,
  auto = false,
): void {
  const amount = defaultCents === null ? 'null' : String(defaultCents);
  sql(
    `select public.upsert_recurring_bill('${group.alexToken}', null, '${name}', '${group.h1}', '${splitType}', p_default_total_cents => ${amount}, p_auto_add => ${String(auto)});`,
  );
}

/** Registers a second phone for Sam (who gets PIN 8642) and returns its token. */
export function samPhone(group: TestGroup, label = 'Kitchen iPad'): string {
  return sql(`
    select t from (select public.register_device('${group.code}', '${GROUP_PIN}', '${label}') ->> 'token' as t) x,
    lateral (select public.set_device_person(x.t, '${group.sam}', '8642')) y;`);
}

export interface PeopleGroup {
  code: string;
  danaToken: string;
  dana: string;
  eli: string;
  finn: string;
}

/** A people-mode group: Dana (admin, on a phone, party = person) plus Eli and Finn. */
export function peopleGroup(): PeopleGroup {
  const code = sql(
    `select private.create_group('E2E trip ${randomUUID().slice(0, 8)}', 'people', '${GROUP_PIN}');`,
  );
  const json = sql(`
    do $$
    declare
      v_tok text := public.register_device('${code}', '${GROUP_PIN}', 'E2E phone') ->> 'token';
      v_person uuid;
      v_dana uuid;
      v_eli uuid;
      v_finn uuid;
    begin
      -- Call each RPC once, then look up the party (a function in a WHERE clause runs per row).
      v_person := public.add_self(v_tok, 'Dana', null, '${PERSONAL_PIN}');
      select party_id into v_dana from public.people where id = v_person;
      v_person := public.upsert_person(v_tok, null, 'Eli');
      select party_id into v_eli from public.people where id = v_person;
      v_person := public.upsert_person(v_tok, null, 'Finn');
      select party_id into v_finn from public.people where id = v_person;
      create temp table e2e_out as
        select jsonb_build_object('code', '${code}', 'danaToken', v_tok, 'dana', v_dana, 'eli', v_eli, 'finn', v_finn)::text as j;
    end $$;
    select j from e2e_out;`);
  return JSON.parse(json.split('\n').pop() ?? '{}') as PeopleGroup;
}

/** Dana pays an expense split equally between everyone. */
export function addGroupExpense(group: PeopleGroup, description: string, totalCents: number): void {
  sql(`select public.add_entry('${group.danaToken}', 'expense', '${description}', private.today(), ${String(totalCents)}, '${group.dana}', null, 'equal', null, null,
    jsonb_build_array(jsonb_build_object('party_id', '${group.dana}'), jsonb_build_object('party_id', '${group.eli}'), jsonb_build_object('party_id', '${group.finn}')));`);
}
