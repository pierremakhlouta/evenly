-- Settle-up periods. Made-up names and numbers only.
-- Inside one test transaction now() never changes, so creation times are spaced out
-- by hand with pg_temp.at() to model entries added on different days.
begin;
select plan(24);

delete from private.pin_attempts;
create temp table t (key text primary key, val text) on commit drop;
create function pg_temp.v(p_key text) returns text language sql as $$ select val from t where key = p_key $$;
create function pg_temp.at(p_entry jsonb, p_minutes integer) returns jsonb language sql as $$
  update public.entries set created_at = '2026-10-01 12:00+00'::timestamptz + make_interval(mins => p_minutes)
  where id = (p_entry ->> 'id')::uuid;
  select p_entry;
$$;
create function pg_temp.net(p_token text, p_party text) returns bigint language sql as $$
  select (n ->> 'net_cents')::bigint from jsonb_array_elements(public.get_summary(p_token) -> 'nets') n
  where n ->> 'party_id' = p_party
$$;

insert into t values ('code', private.create_group('Test House', 'households', '4821'));
insert into t select 'group', group_id::text from private.group_secrets where code = private.normalize_code(pg_temp.v('code'));
insert into t select 'h1', id::text from public.parties where group_id = pg_temp.v('group')::uuid and sort_order = 1;
insert into t select 'h2', id::text from public.parties where group_id = pg_temp.v('group')::uuid and sort_order = 2;
insert into t values ('tok1', public.register_device(pg_temp.v('code'), '4821') ->> 'token');
insert into t values ('tok2', public.register_device(pg_temp.v('code'), '4821') ->> 'token');
insert into t values ('alex', public.add_self(pg_temp.v('tok1'), 'Alex', pg_temp.v('h1')::uuid, '1111')::text);
insert into t values ('blair', public.upsert_person(pg_temp.v('tok1'), null, 'Blair', pg_temp.v('h2')::uuid)::text);
select public.set_device_person(pg_temp.v('tok2'), pg_temp.v('blair')::uuid, '2222');

-- Nothing to settle yet.
select throws_ok(format('select public.settle_up(%L, 0, %L)', pg_temp.v('tok1'), '2026-10-31'), '22023', 'already_settled', 'nothing to settle in a new group');

-- October: one bill, then the other household settles the full balance.
insert into t values ('e1', pg_temp.at(public.add_entry(pg_temp.v('tok1'), 'expense', 'Hydro', '2026-10-05', 9000, pg_temp.v('h1')::uuid, null, 'third'), 1)::text);
select throws_ok(format('select public.settle_up(%L, 2999, %L)', pg_temp.v('tok2'), '2026-10-31'), '22023', 'balance_changed', 'a stale amount is refused');
select throws_ok(format('select public.settle_up(%L, 3000, %L, null, %L)', pg_temp.v('tok2'), '2026-10-31', pg_temp.v('alex')),
  '22023', 'invalid_person', 'the person who paid must be in the household that owes');
insert into t values ('s1', pg_temp.at(public.settle_up(pg_temp.v('tok2'), 3000, '2026-10-31', ' e-transfer ', pg_temp.v('blair')::uuid), 10)::text);
select is(pg_temp.v('s1')::jsonb -> 'settles', 'true'::jsonb, 'the payment is marked as a settle-up');
select is(array[pg_temp.v('s1')::jsonb ->> 'kind', pg_temp.v('s1')::jsonb ->> 'paid_by_party_id', pg_temp.v('s1')::jsonb ->> 'description'],
  array['payment', pg_temp.v('h2'), 'e-transfer'], 'the household that owed pays, with the note trimmed');
select is(pg_temp.v('s1')::jsonb -> 'shares', jsonb_build_array(jsonb_build_object('party_id', pg_temp.v('h1'), 'share_cents', 3000)),
  'the other household receives the full balance');
select is(pg_temp.net(pg_temp.v('tok1'), pg_temp.v('h1')), 0::bigint, 'the balance is zero after settling');
select is((select note from public.entry_events where entry_id = (pg_temp.v('s1')::jsonb ->> 'id')::uuid), 'Settled the full balance', 'the change log says it settled up');
select throws_ok(format('select public.settle_up(%L, 0, %L)', pg_temp.v('tok1'), '2026-10-31'), '22023', 'already_settled', 'settling twice is refused');
select is((public.get_summary(pg_temp.v('tok1')) ->> 'last_settled_at')::timestamptz, '2026-10-01 12:10+00'::timestamptz, 'the summary knows when the group last settled');

-- November: a new bill, and a late October bill added after the settle-up.
insert into t values ('e2', pg_temp.at(public.add_entry(pg_temp.v('tok1'), 'expense', 'Gas', '2026-11-03', 6000, pg_temp.v('h1')::uuid, null, 'half'), 20)::text);
insert into t values ('e3', pg_temp.at(public.add_entry(pg_temp.v('tok2'), 'expense', 'Late water bill', '2026-10-28', 3000, pg_temp.v('h2')::uuid, null, 'third'), 30)::text);
insert into t values ('periods', public.list_periods(pg_temp.v('tok1'))::text);
select is((pg_temp.v('periods')::jsonb -> 'current' ->> 'entry_count')::int, 2, 'the open period has the two entries added since the settle-up');
select is(array[pg_temp.v('periods')::jsonb -> 'current' ->> 'first_date', pg_temp.v('periods')::jsonb -> 'current' ->> 'last_date'],
  array['2026-10-28', '2026-11-03'], 'a late bill added after a settle-up joins the new period');
select is(jsonb_array_length(pg_temp.v('periods')::jsonb -> 'settled'), 1, 'one settled period');
select is((pg_temp.v('periods')::jsonb -> 'settled' -> 0 ->> 'entry_count')::int, 2, 'the settled period holds the bill and the payment');
select is((select array_agg(e ->> 'description' order by (e ->> 'description') collate "C") from jsonb_array_elements(
    public.list_entries(pg_temp.v('tok1'), false, 50, null, (pg_temp.v('periods')::jsonb -> 'current' ->> 'created_after')::timestamptz) -> 'entries') e),
  array['Gas', 'Late water bill'], 'list_entries can show only the open period');
select is((select array_agg(e ->> 'description' order by (e ->> 'description') collate "C") from jsonb_array_elements(
    public.list_entries(pg_temp.v('tok1'), false, 50, null,
      (pg_temp.v('periods')::jsonb -> 'settled' -> 0 ->> 'created_after')::timestamptz,
      (pg_temp.v('periods')::jsonb -> 'settled' -> 0 ->> 'created_until')::timestamptz) -> 'entries') e),
  array['Hydro', 'e-transfer'], 'list_entries can show one settled period');

-- A settle-up cannot be edited; deleting it reopens the period.
select throws_ok(format('select public.edit_entry(%L, %L, %L, %L, 100, %L)', pg_temp.v('tok1'), pg_temp.v('s1')::jsonb ->> 'id', 'x', '2026-10-31', pg_temp.v('h2')),
  '22023', 'settlement_locked', 'a settle-up cannot be edited');
select public.delete_entry(pg_temp.v('tok1'), (pg_temp.v('s1')::jsonb ->> 'id')::uuid);
select is(jsonb_array_length(public.list_periods(pg_temp.v('tok1')) -> 'settled'), 0, 'deleting the settle-up removes its period');
select is((public.list_periods(pg_temp.v('tok1')) -> 'current' ->> 'entry_count')::int, 3, 'and its entries rejoin the open period');
select ok(public.get_summary(pg_temp.v('tok1')) -> 'last_settled_at' = 'null'::jsonb, 'with no settle-up left, there is no last settled time');
select public.restore_entry(pg_temp.v('tok1'), (pg_temp.v('s1')::jsonb ->> 'id')::uuid);
select is(jsonb_array_length(public.list_periods(pg_temp.v('tok1')) -> 'settled'), 1, 'restoring it closes the period again');

-- Rules
select throws_ok(
  format($$insert into public.entries (group_id, kind, description, total_cents, paid_by_party_id, split_type, settles)
           values (%L, 'expense', 'x', 100, %L, 'half', true)$$, pg_temp.v('group'), pg_temp.v('h1')),
  '23514', null, 'only payments can settle up');

insert into t values ('code_p', private.create_group('Trip', 'people', '5555'));
insert into t values ('tokp', public.register_device(pg_temp.v('code_p'), '5555') ->> 'token');
select public.add_self(pg_temp.v('tokp'), 'Dana', null, '1111');
select throws_ok(format('select public.settle_up(%L, 0, %L)', pg_temp.v('tokp'), '2026-10-31'), '22023', 'not_supported', 'people mode settles up later (Phase 8)');
select is(jsonb_array_length(public.list_periods(pg_temp.v('tokp')) -> 'settled'), 0, 'another group sees none of these periods');

select * from finish();
rollback;
