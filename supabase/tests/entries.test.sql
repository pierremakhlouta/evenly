-- Entry RPCs: shares, balances, edit/delete/restore with change log, validation,
-- pagination, people mode, and group isolation. Made-up names and numbers only.
begin;
select plan(49);

delete from private.pin_attempts;
create temp table t (key text primary key, val text) on commit drop;
grant select on t to anon;
create function pg_temp.v(p_key text) returns text language sql as $$ select val from t where key = p_key $$;
create function pg_temp.shares(p_entry jsonb) returns jsonb language sql as $$
  select jsonb_object_agg(s ->> 'party_id', (s ->> 'share_cents')::integer) from jsonb_array_elements(p_entry -> 'shares') s
$$;
create function pg_temp.net(p_token text, p_party text) returns bigint language sql as $$
  select (n ->> 'net_cents')::bigint from jsonb_array_elements(public.get_summary(p_token) -> 'nets') n
  where n ->> 'party_id' = p_party
$$;

-- Fixtures: household group A (two phones), household group B, people group P.
insert into t values ('code_a', private.create_group('Test House', 'households', '4821'));
insert into t select 'group_a', group_id::text from private.group_secrets where code = private.normalize_code(pg_temp.v('code_a'));
insert into t select 'h1', id::text from public.parties where group_id = pg_temp.v('group_a')::uuid and sort_order = 1;
insert into t select 'h2', id::text from public.parties where group_id = pg_temp.v('group_a')::uuid and sort_order = 2;
insert into t values ('tok1', public.register_device(pg_temp.v('code_a'), '4821') ->> 'token');
insert into t values ('tok2', public.register_device(pg_temp.v('code_a'), '4821') ->> 'token');
insert into t values ('tok_none', public.register_device(pg_temp.v('code_a'), '4821') ->> 'token');
insert into t values ('alex', public.add_self(pg_temp.v('tok1'), 'Alex', pg_temp.v('h1')::uuid)::text);
insert into t values ('blair', public.add_self(pg_temp.v('tok2'), 'Blair', pg_temp.v('h2')::uuid)::text);

insert into t values ('code_b', private.create_group('Other House', 'households', '7730'));
insert into t select 'hb1', id::text from public.parties p join private.group_secrets gs on gs.group_id = p.group_id
  where gs.code = private.normalize_code(pg_temp.v('code_b')) and p.sort_order = 1;
insert into t values ('tokb', public.register_device(pg_temp.v('code_b'), '7730') ->> 'token');
select public.add_self(pg_temp.v('tokb'), 'Casey', pg_temp.v('hb1')::uuid);

insert into t values ('code_p', private.create_group('Trip', 'people', '5555'));
insert into t values ('tokp1', public.register_device(pg_temp.v('code_p'), '5555') ->> 'token');
insert into t values ('tokp2', public.register_device(pg_temp.v('code_p'), '5555') ->> 'token');
insert into t values ('tokp3', public.register_device(pg_temp.v('code_p'), '5555') ->> 'token');
insert into t values ('pa_person', public.add_self(pg_temp.v('tokp1'), 'Dana')::text);
insert into t select 'pa', party_id::text from public.people where id = pg_temp.v('pa_person')::uuid;
insert into t values ('pb_person', public.add_self(pg_temp.v('tokp2'), 'Eli')::text);
insert into t select 'pb', party_id::text from public.people where id = pg_temp.v('pb_person')::uuid;
insert into t values ('pc_person', public.add_self(pg_temp.v('tokp3'), 'Finn')::text);
insert into t select 'pc', party_id::text from public.people where id = pg_temp.v('pc_person')::uuid;

-- Adding expenses and payments
insert into t values ('e1', public.add_entry(pg_temp.v('tok1'), 'expense', ' Hydro ', '2026-10-01', 10001,
  pg_temp.v('h1')::uuid, pg_temp.v('alex')::uuid, 'third')::text);
select is(pg_temp.shares(pg_temp.v('e1')::jsonb), jsonb_build_object(pg_temp.v('h1'), 6667, pg_temp.v('h2'), 3334),
  'a third of $100.01: the other household owes 3334, the payer keeps 6667');
select is(pg_temp.v('e1')::jsonb ->> 'created_by_person_id', pg_temp.v('alex'), 'the entry records who added it');
select is(pg_temp.v('e1')::jsonb ->> 'description', 'Hydro', 'the description is trimmed');
select is((select array_agg(action || ':' || by_person_id) from public.entry_events where entry_id = (pg_temp.v('e1')::jsonb ->> 'id')::uuid),
  array['create:' || pg_temp.v('alex')], 'adding logs a create event by that person');
select is(pg_temp.net(pg_temp.v('tok2'), pg_temp.v('h2')), -3334::bigint, 'the other household now owes 3334');
select is(public.get_summary(pg_temp.v('tok2')) -> 'me' ->> 'party_id', pg_temp.v('h2'), 'summary says which household this phone is');

insert into t values ('e2', public.add_entry(pg_temp.v('tok2'), 'expense', 'Dinner', '2026-10-05', 9000,
  pg_temp.v('h2')::uuid, null, 'amount', 4000)::text);
select is(pg_temp.shares(pg_temp.v('e2')::jsonb), jsonb_build_object(pg_temp.v('h1'), 4000, pg_temp.v('h2'), 5000),
  'dinner $90, they paid, my share $40');

insert into t values ('e3', public.add_entry(pg_temp.v('tok2'), 'payment', null, '2026-10-06', 1000, pg_temp.v('h2')::uuid)::text);
select is(pg_temp.shares(pg_temp.v('e3')::jsonb), jsonb_build_object(pg_temp.v('h1'), 1000),
  'a payment has one share for the other household, equal to the amount');
select ok(pg_temp.v('e3')::jsonb -> 'split_type' = 'null'::jsonb, 'a payment stores no split');
select is(pg_temp.net(pg_temp.v('tok1'), pg_temp.v('h1')), -1666::bigint, 'balance after a bill, a dinner and a payment');
select is((select sum((n ->> 'net_cents')::bigint) from jsonb_array_elements(public.get_summary(pg_temp.v('tok1')) -> 'nets') n),
  0::numeric, 'nets add up to zero');

-- Editing
insert into t values ('e1_edit', public.edit_entry(pg_temp.v('tok2'), (pg_temp.v('e1')::jsonb ->> 'id')::uuid, 'Hydro', '2026-10-01', 12000,
  pg_temp.v('h1')::uuid, pg_temp.v('alex')::uuid, 'half')::text);
select is(pg_temp.shares(pg_temp.v('e1_edit')::jsonb), jsonb_build_object(pg_temp.v('h1'), 6000, pg_temp.v('h2'), 6000),
  'editing recomputes the shares');
select is((select array[before ->> 'total_cents', after ->> 'total_cents', by_person_id::text] from public.entry_events
           where entry_id = (pg_temp.v('e1')::jsonb ->> 'id')::uuid and action = 'edit'),
  array['10001', '12000', pg_temp.v('blair')], 'the edit is logged with before, after and who');
select is(pg_temp.v('e1_edit')::jsonb ->> 'created_by_person_id', pg_temp.v('alex'), 'editing keeps the original creator');

-- Deleting and restoring
select ok(public.delete_entry(pg_temp.v('tok2'), (pg_temp.v('e1')::jsonb ->> 'id')::uuid) ->> 'deleted_at' is not null, 'deleting marks the entry deleted');
select is(pg_temp.net(pg_temp.v('tok1'), pg_temp.v('h1')), -5000::bigint, 'a deleted entry leaves the balance');
select ok(not (public.list_entries(pg_temp.v('tok1')) -> 'entries' @> jsonb_build_array(jsonb_build_object('id', pg_temp.v('e1')::jsonb -> 'id'))),
  'a deleted entry leaves the list');
select ok(public.list_entries(pg_temp.v('tok1'), true) -> 'entries' @> jsonb_build_array(jsonb_build_object('id', pg_temp.v('e1')::jsonb -> 'id')),
  'a deleted entry shows in the deleted list');
select throws_ok(format('select public.edit_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tok1'), pg_temp.v('e1')::jsonb ->> 'id',
  'x', '2026-10-01', pg_temp.v('h1'), 'half'), '22023', 'entry_deleted', 'a deleted entry cannot be edited');
select throws_ok(format('select public.delete_entry(%L, %L)', pg_temp.v('tok1'), pg_temp.v('e1')::jsonb ->> 'id'),
  '22023', 'entry_deleted', 'a deleted entry cannot be deleted again');
select ok(public.restore_entry(pg_temp.v('tok1'), (pg_temp.v('e1')::jsonb ->> 'id')::uuid) ->> 'deleted_at' is null, 'restoring brings it back');
select is(pg_temp.net(pg_temp.v('tok1'), pg_temp.v('h1')), 1000::bigint, 'a restored entry counts again');
select throws_ok(format('select public.restore_entry(%L, %L)', pg_temp.v('tok1'), pg_temp.v('e1')::jsonb ->> 'id'),
  '22023', 'entry_not_deleted', 'an active entry cannot be restored');
select is((select array_agg(e ->> 'action' order by ord) from jsonb_array_elements(public.get_entry(pg_temp.v('tok1'), (pg_temp.v('e1')::jsonb ->> 'id')::uuid) -> 'events') with ordinality as x(e, ord)),
  array['create', 'edit', 'delete', 'restore'], 'get_entry returns the full change log in order');

-- Validation
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tok1'), 'expense', '  ', '2026-10-01', pg_temp.v('h1'), 'half'),
  '22023', 'invalid_description', 'an expense needs a description');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 0, %L, null, %L)', pg_temp.v('tok1'), 'expense', 'x', '2026-10-01', pg_temp.v('h1'), 'half'),
  '22023', 'invalid_total', 'the total must be above zero');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tok1'), 'expense', 'x', '2026-10-01', pg_temp.v('h1'), 'equal'),
  '22023', 'invalid_split_type', 'household groups only take household split types');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L, 4, 3)', pg_temp.v('tok1'), 'expense', 'x', '2026-10-01', pg_temp.v('h1'), 'fraction'),
  '22023', 'invalid_fraction', 'fractions above 1 are rejected');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, %L, %L)', pg_temp.v('tok1'), 'expense', 'x', '2026-10-01', pg_temp.v('h1'), pg_temp.v('blair'), 'half'),
  '22023', 'invalid_person', 'the person who paid must be in the paying household');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tok1'), 'expense', 'x', '1999-12-31', pg_temp.v('h1'), 'half'),
  '22023', 'invalid_date', 'dates before 2000 are rejected');
select throws_ok(format('select public.add_entry(%L, %L, null, %L, 100, %L, null, null, null, null, null, %L)', pg_temp.v('tok1'), 'payment', '2026-10-01', pg_temp.v('h1'), pg_temp.v('h1')),
  '22023', 'invalid_party', 'a household cannot pay itself');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L)', pg_temp.v('tok1'), 'refund', 'x', '2026-10-01', pg_temp.v('h1')),
  '22023', 'invalid_kind', 'unknown entry kinds are rejected');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tok_none'), 'expense', 'x', '2026-10-01', pg_temp.v('h1'), 'half'),
  '22023', 'no_person', 'a phone must pick a person before adding');

-- Group isolation
select throws_ok(format('select public.get_entry(%L, %L)', pg_temp.v('tokb'), pg_temp.v('e1')::jsonb ->> 'id'),
  '22023', 'not_found', 'another group cannot read the entry');
select throws_ok(format('select public.edit_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tokb'), pg_temp.v('e1')::jsonb ->> 'id', 'x', '2026-10-01', pg_temp.v('hb1'), 'half'),
  '22023', 'not_found', 'another group cannot edit the entry');
select throws_ok(format('select public.delete_entry(%L, %L)', pg_temp.v('tokb'), pg_temp.v('e1')::jsonb ->> 'id'),
  '22023', 'not_found', 'another group cannot delete the entry');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tokb'), 'expense', 'x', '2026-10-01', pg_temp.v('h1'), 'half'),
  '22023', 'invalid_party', 'another group cannot add an entry paid by this group''s household');
select is(jsonb_array_length(public.list_entries(pg_temp.v('tokb')) -> 'entries'), 0, 'another group sees none of these entries');

-- Pagination: three active entries, newest entry date first.
select is((select array_agg(e ->> 'description' order by ord) from jsonb_array_elements(public.list_entries(pg_temp.v('tok1'), false, 2) -> 'entries') with ordinality as x(e, ord)),
  array['', 'Dinner'], 'first page has the two newest entries');
select is((select array_agg(e ->> 'description') from jsonb_array_elements(
  public.list_entries(pg_temp.v('tok1'), false, 2, public.list_entries(pg_temp.v('tok1'), false, 2) ->> 'next_before') -> 'entries') e),
  array['Hydro'], 'the next_before cursor returns the rest');
select throws_ok(format('select public.list_entries(%L, false, 10, %L)', pg_temp.v('tok1'), 'garbage'), '22023', 'invalid_cursor', 'a bad cursor is rejected');

-- People mode
select is(pg_temp.shares(public.add_entry(pg_temp.v('tokp1'), 'expense', 'Groceries', '2026-10-02', 10000, pg_temp.v('pa')::uuid, null, 'equal', null, null,
    jsonb_build_array(jsonb_build_object('party_id', pg_temp.v('pc')), jsonb_build_object('party_id', pg_temp.v('pa')), jsonb_build_object('party_id', pg_temp.v('pb'))))),
  jsonb_build_object(pg_temp.v('pa'), 3334, pg_temp.v('pb'), 3333, pg_temp.v('pc'), 3333), 'people mode equal split, leftover cent by sort order');
select throws_ok(format('select public.add_entry(%L, %L, null, %L, 100, %L)', pg_temp.v('tokp1'), 'payment', '2026-10-02', pg_temp.v('pa')),
  '22023', 'invalid_party', 'a people-mode payment needs a receiver');
select throws_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L, null, null, %L)', pg_temp.v('tokp1'), 'expense', 'x', '2026-10-02', pg_temp.v('pa'), 'equal',
  jsonb_build_array(jsonb_build_object('party_id', pg_temp.v('h1')))), '22023', 'invalid_parties', 'people from another group cannot be in a split');

-- Access
select ok(has_function_privilege('anon', 'public.add_entry(text, text, text, date, integer, uuid, uuid, text, integer, integer, jsonb, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.add_entry(text, text, text, date, integer, uuid, uuid, text, integer, integer, jsonb, uuid)', 'execute'),
  'only anon can call the entry RPCs');
update private.devices set revoked_at = now() where token_hash = extensions.digest(decode(pg_temp.v('tok2'), 'hex'), 'sha256');
select throws_ok(format('select public.list_entries(%L)', pg_temp.v('tok2')), '28000', 'invalid_device', 'a revoked phone can no longer read');

select lives_ok('set constraints all immediate', 'every entry''s shares add up to its total');

-- The deferred shares check runs as the caller at commit time; it must work for anon.
set constraints all deferred;
set local role anon;
select lives_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tok1'), 'expense', 'Water', '2026-10-03', pg_temp.v('h1'), 'half'),
  'anon can add an entry');
select lives_ok('set constraints all immediate', 'the commit-time shares check works when called as anon');
reset role;

select * from finish();
rollback;
