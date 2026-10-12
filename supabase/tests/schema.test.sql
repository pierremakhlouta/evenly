-- Schema lockdown and integrity rules.
begin;
select plan(24);

-- RLS is on for every public table, with no policies at all.
select is(
  (select count(*)::int from pg_tables where schemaname = 'public' and not rowsecurity),
  0, 'every public table has RLS enabled');
select is(
  (select count(*)::int from pg_policies where schemaname in ('public', 'private')),
  0, 'no RLS policies exist');

-- API roles have no table privileges anywhere.
select is(
  (select count(*)::int from information_schema.role_table_grants
    where grantee in ('anon', 'authenticated') and table_schema in ('public', 'private')),
  0, 'anon and authenticated have no table grants');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon cannot use the private schema');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated cannot use the private schema');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and has_function_privilege('anon', p.oid, 'execute')),
  0, 'anon cannot execute any private function');

-- Fixtures: two groups with two households each.
insert into public.groups (id, name, mode) values
  ('00000000-0000-0000-0000-00000000000a', 'Group A', 'households'),
  ('00000000-0000-0000-0000-00000000000b', 'Group B', 'households');
insert into public.parties (id, group_id, name, kind, sort_order) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'A1', 'household', 1),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'A2', 'household', 2),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'B1', 'household', 1);
insert into public.people (id, group_id, name, party_id) values
  ('00000000-0000-0000-0000-000000000a11', '00000000-0000-0000-0000-00000000000a', 'Alex', '00000000-0000-0000-0000-0000000000a1');

-- Anon cannot read or write tables directly.
set local role anon;
select throws_ok('select * from public.entries', '42501', null, 'anon cannot read entries');
select throws_ok('select * from public.groups', '42501', null, 'anon cannot read groups');
select throws_ok($$insert into public.groups (name, mode) values ('x', 'people')$$, '42501', null, 'anon cannot insert groups');
select throws_ok('select * from private.group_secrets', '42501', null, 'anon cannot read group secrets');
reset role;
set local role authenticated;
select throws_ok('select * from public.entry_shares', '42501', null, 'authenticated cannot read shares');
reset role;

-- Cross-group references are impossible.
select throws_ok(
  $$insert into public.people (group_id, name, party_id)
    values ('00000000-0000-0000-0000-00000000000b', 'Sam', '00000000-0000-0000-0000-0000000000a1')$$,
  '23503', null, 'a person cannot belong to a party in another group');
select throws_ok(
  $$insert into public.entries (group_id, kind, description, total_cents, paid_by_party_id, split_type)
    values ('00000000-0000-0000-0000-00000000000b', 'expense', 'x', 100, '00000000-0000-0000-0000-0000000000a1', 'half')$$,
  '23503', null, 'an entry cannot be paid by a party in another group');

-- Entry rules.
select throws_ok(
  $$insert into public.entries (group_id, kind, description, total_cents, paid_by_party_id, split_type)
    values ('00000000-0000-0000-0000-00000000000a', 'expense', '  ', 100, '00000000-0000-0000-0000-0000000000a1', 'half')$$,
  '23514', null, 'expenses need a description');
select throws_ok(
  $$insert into public.entries (group_id, kind, description, total_cents, paid_by_party_id, split_type)
    values ('00000000-0000-0000-0000-00000000000a', 'expense', 'x', 0, '00000000-0000-0000-0000-0000000000a1', 'half')$$,
  '23514', null, 'total must be above 0');
select throws_ok(
  $$insert into public.entries (group_id, kind, total_cents, paid_by_party_id, split_type)
    values ('00000000-0000-0000-0000-00000000000a', 'payment', 100, '00000000-0000-0000-0000-0000000000a1', 'half')$$,
  '23514', null, 'payments have no split type');

-- Shares must add up to the total (deferred check, forced here).
insert into public.entries (id, group_id, kind, description, total_cents, paid_by_party_id, split_type)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000a', 'expense', 'Hydro', 10000,
          '00000000-0000-0000-0000-0000000000a1', 'third');
insert into public.entry_shares (group_id, entry_id, party_id, share_cents) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 6667),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2', 3333);
select lives_ok('set constraints all immediate', 'shares that add up are accepted');
set constraints all deferred;

update public.entry_shares set share_cents = 3000
  where entry_id = '00000000-0000-0000-0000-0000000000e1' and party_id = '00000000-0000-0000-0000-0000000000a2';
select throws_ok('set constraints all immediate', '23514', 'shares_mismatch', 'shares that do not add up are rejected');
set constraints all deferred;
update public.entry_shares set share_cents = 3333
  where entry_id = '00000000-0000-0000-0000-0000000000e1' and party_id = '00000000-0000-0000-0000-0000000000a2';

update public.entries set total_cents = 10001 where id = '00000000-0000-0000-0000-0000000000e1';
select throws_ok('set constraints all immediate', '23514', 'shares_mismatch', 'changing the total without the shares is rejected');
set constraints all deferred;
update public.entries set total_cents = 10000 where id = '00000000-0000-0000-0000-0000000000e1';

select throws_ok(
  $$insert into public.entry_shares (group_id, entry_id, party_id, share_cents)
    values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2', -1)$$,
  '23514', null, 'shares cannot be negative');

-- The change log is append only.
insert into public.entry_events (group_id, entry_id, action) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'create');
select throws_ok('update public.entry_events set note = $$x$$', '42501', 'append_only', 'change log rows cannot be edited');
select throws_ok('delete from public.entry_events', '42501', 'append_only', 'change log rows cannot be deleted');

-- A monthly bill can only be added once per month.
insert into public.recurring_bills (id, group_id, name, paid_by_party_id, split_type)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'Rent',
          '00000000-0000-0000-0000-0000000000a1', 'third');
insert into public.entries (group_id, kind, description, total_cents, paid_by_party_id, split_type, recurring_bill_id, bill_period)
  values ('00000000-0000-0000-0000-00000000000a', 'expense', 'Rent', 100, '00000000-0000-0000-0000-0000000000a1', 'all',
          '00000000-0000-0000-0000-0000000000c1', '2026-10-01');
insert into public.entry_shares (group_id, entry_id, party_id, share_cents)
  select group_id, id, '00000000-0000-0000-0000-0000000000a2', 100 from public.entries where bill_period = '2026-10-01';
select throws_ok(
  $$insert into public.entries (group_id, kind, description, total_cents, paid_by_party_id, split_type, recurring_bill_id, bill_period)
    values ('00000000-0000-0000-0000-00000000000a', 'expense', 'Rent', 100, '00000000-0000-0000-0000-0000000000a1', 'all',
            '00000000-0000-0000-0000-0000000000c1', '2026-10-01')$$,
  '23505', null, 'the same monthly bill cannot be added twice for one month');

select throws_ok(
  $$insert into public.recurring_bills (group_id, name, paid_by_party_id, split_type, auto_add)
    values ('00000000-0000-0000-0000-00000000000a', 'Wifi', '00000000-0000-0000-0000-0000000000a1', 'half', true)$$,
  '23514', null, 'an auto-added bill needs a default amount');

select * from finish();
rollback;
