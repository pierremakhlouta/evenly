-- Settings RPCs: bills, group, households, people, devices, export, plus the full
-- list of functions the API can call. Made-up names and numbers only.
begin;
select plan(32);

-- The API can call exactly these functions and nothing else.
select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')),
  array['add_entry', 'add_self', 'archive_person', 'archive_recurring_bill', 'delete_entry', 'edit_entry',
        'export_entries', 'get_entry', 'get_summary', 'list_devices', 'list_entries', 'list_recurring_bills',
        'ping', 'register_device', 'reset_person_pin', 'restore_entry', 'revoke_device', 'set_device_person', 'set_person_admin', 'update_group',
        'upsert_party', 'upsert_person', 'upsert_recurring_bill'],
  'anon can execute exactly the documented RPCs');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
      and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any(p.proconfig)))
      and p.proname <> 'ping'),
  0, 'every callable RPC is security definer with an empty search_path');

delete from private.pin_attempts;
create temp table t (key text primary key, val text) on commit drop;
create function pg_temp.v(p_key text) returns text language sql as $$ select val from t where key = p_key $$;

insert into t values ('code_a', private.create_group('Test House', 'households', '4821'));
insert into t select 'group_a', group_id::text from private.group_secrets where code = private.normalize_code(pg_temp.v('code_a'));
insert into t select 'h1', id::text from public.parties where group_id = pg_temp.v('group_a')::uuid and sort_order = 1;
insert into t select 'h2', id::text from public.parties where group_id = pg_temp.v('group_a')::uuid and sort_order = 2;
insert into t values ('tok1', public.register_device(pg_temp.v('code_a'), '4821', 'Phone one') ->> 'token');
insert into t values ('tok2', public.register_device(pg_temp.v('code_a'), '4821', 'Phone two') ->> 'token');
insert into t values ('alex', public.add_self(pg_temp.v('tok1'), 'Alex', pg_temp.v('h1')::uuid, '1111')::text);
insert into t values ('blair', public.upsert_person(pg_temp.v('tok1'), null, 'Blair', pg_temp.v('h2')::uuid)::text);
select public.set_device_person(pg_temp.v('tok2'), pg_temp.v('blair')::uuid, '2222');

insert into t values ('code_b', private.create_group('Other House', 'households', '7730'));
insert into t select 'hb1', p.id::text from public.parties p join private.group_secrets gs on gs.group_id = p.group_id
  where gs.code = private.normalize_code(pg_temp.v('code_b')) and p.sort_order = 1;
insert into t values ('tokb', public.register_device(pg_temp.v('code_b'), '7730') ->> 'token');
select public.add_self(pg_temp.v('tokb'), 'Casey', pg_temp.v('hb1')::uuid, '1111');

insert into t values ('code_p', private.create_group('Trip', 'people', '5555'));
insert into t values ('tokp', public.register_device(pg_temp.v('code_p'), '5555') ->> 'token');
insert into t values ('dana', public.add_self(pg_temp.v('tokp'), 'Dana', null, '1111')::text);

-- Recurring bills
insert into t values ('rent', public.upsert_recurring_bill(pg_temp.v('tok1'), null, 'Rent', pg_temp.v('h1')::uuid, 'third',
  p_default_total_cents => 150000, p_auto_add => true, p_day_of_month => 1)::text);
select is(pg_temp.v('rent')::jsonb ->> 'name', 'Rent', 'a bill can be created');
insert into t values ('hydro', public.upsert_recurring_bill(pg_temp.v('tok1'), null, 'Hydro', pg_temp.v('h1')::uuid, 'third')::text);
select ok((pg_temp.v('hydro')::jsonb ->> 'sort_order')::int > (pg_temp.v('rent')::jsonb ->> 'sort_order')::int, 'new bills go to the end');
select throws_ok(format('select public.upsert_recurring_bill(%L, null, %L, %L, %L, p_auto_add => true)', pg_temp.v('tok1'), 'Gas', pg_temp.v('h1'), 'half'),
  '22023', 'invalid_bill', 'an automatic bill needs a default amount');
select throws_ok(format('select public.upsert_recurring_bill(%L, null, %L, %L, %L, p_day_of_month => 31)', pg_temp.v('tok1'), 'Gas', pg_temp.v('h1'), 'half'),
  '22023', 'invalid_day', 'day of month must be 1 to 28');
select throws_ok(format('select public.upsert_recurring_bill(%L, null, %L, %L, %L, 0)', pg_temp.v('tok1'), 'Gas', pg_temp.v('h1'), 'percent'),
  '22023', 'invalid_percent', 'the split rule is validated');
select throws_ok(format('select public.upsert_recurring_bill(%L, null, %L, %L, %L, 9000, p_default_total_cents => 5000)', pg_temp.v('tok1'), 'Gas', pg_temp.v('h1'), 'amount'),
  '22023', 'invalid_amount', 'a fixed share cannot be more than the default amount');
select is(public.upsert_recurring_bill(pg_temp.v('tok2'), (pg_temp.v('hydro')::jsonb ->> 'id')::uuid, 'Hydro', pg_temp.v('h1')::uuid, 'percent', 4000) ->> 'split_num',
  '4000', 'a bill can be edited');
select is(public.archive_recurring_bill(pg_temp.v('tok1'), (pg_temp.v('hydro')::jsonb ->> 'id')::uuid) ->> 'active', 'false', 'a bill can be archived');
select is((select array_agg(b ->> 'name' order by ord) from jsonb_array_elements(public.list_recurring_bills(pg_temp.v('tok1'))) with ordinality as x(b, ord)),
  array['Rent', 'Hydro'], 'archived bills are listed after active ones');
select throws_ok(format('select public.archive_recurring_bill(%L, %L)', pg_temp.v('tokb'), pg_temp.v('rent')::jsonb ->> 'id'),
  '22023', 'not_found', 'another group cannot archive the bill');
select is(jsonb_array_length(public.list_recurring_bills(pg_temp.v('tokb'))), 0, 'another group sees none of the bills');
select throws_ok(format('select public.upsert_recurring_bill(%L, null, %L, %L, %L)', pg_temp.v('tokb'), 'Gas', pg_temp.v('h1'), 'half'),
  '22023', 'invalid_party', 'another group cannot create a bill paid by this household');

-- Group and households
select lives_ok(format('select public.update_group(%L, %L)', pg_temp.v('tok1'), 'Main House'), 'the group can be renamed');
select is(public.get_summary(pg_temp.v('tok2')) -> 'group' ->> 'name', 'Main House', 'the new group name is visible to every phone');
select lives_ok(format('select public.upsert_party(%L, %L, %L)', pg_temp.v('tok1'), pg_temp.v('h2'), 'Upstairs'), 'a household can be renamed');
select throws_ok(format('select public.upsert_party(%L, %L, %L)', pg_temp.v('tokb'), pg_temp.v('h2'), 'Hacked'),
  '22023', 'invalid_party', 'another group cannot rename the household');
select throws_ok(format('select public.update_group(%L, %L)', pg_temp.v('tok1'), ''), '22023', 'invalid_name', 'names cannot be blank');

-- People
insert into t values ('sam', public.upsert_person(pg_temp.v('tok1'), null, 'Sam', pg_temp.v('h2')::uuid)::text);
select is((select party_id::text from public.people where id = pg_temp.v('sam')::uuid), pg_temp.v('h2'), 'a person can be added to a household');
select lives_ok(format('select public.upsert_person(%L, %L, %L, %L)', pg_temp.v('tok1'), pg_temp.v('sam'), 'Samira', pg_temp.v('h1')),
  'a person can be renamed and moved to the other household');
select is((select name || '/' || party_id::text from public.people where id = pg_temp.v('sam')::uuid), 'Samira/' || pg_temp.v('h1'), 'the rename and move are saved');
select throws_ok(format('select public.upsert_person(%L, %L, %L, %L)', pg_temp.v('tokb'), pg_temp.v('sam'), 'X', pg_temp.v('hb1')),
  '22023', 'not_found', 'another group cannot edit the person');
select throws_ok(format('select public.archive_person(%L, %L)', pg_temp.v('tok1'), pg_temp.v('alex')),
  '22023', 'cannot_archive_self', 'a phone cannot archive its own person');
select lives_ok(format('select public.archive_person(%L, %L)', pg_temp.v('tok1'), pg_temp.v('sam')), 'a person can be archived');
select ok((select p ->> 'archived' from jsonb_array_elements(public.get_summary(pg_temp.v('tok1')) -> 'people') p where p ->> 'id' = pg_temp.v('sam'))::boolean,
  'archived people stay in the summary for history');

insert into t values ('eli', public.upsert_person(pg_temp.v('tokp'), null, 'Eli')::text);
select is((select pa.kind || '/' || pa.name from public.people pe join public.parties pa on pa.id = pe.party_id where pe.id = pg_temp.v('eli')::uuid),
  'person/Eli', 'in people mode a new person gets their own party');
select public.archive_person(pg_temp.v('tokp'), pg_temp.v('eli')::uuid);
select ok((select pa.archived_at is not null from public.people pe join public.parties pa on pa.id = pe.party_id where pe.id = pg_temp.v('eli')::uuid),
  'in people mode archiving a person archives their party');

-- Devices
select is((select array_agg((d ->> 'label') || ':' || (d ->> 'is_me') order by d ->> 'label') from jsonb_array_elements(public.list_devices(pg_temp.v('tok1'))) d),
  array['Phone one:true', 'Phone two:false'], 'devices list shows this group''s phones and which one is me');
select throws_ok(format('select public.revoke_device(%L, %L)', pg_temp.v('tokb'),
  (select d ->> 'id' from jsonb_array_elements(public.list_devices(pg_temp.v('tok1'))) d where d ->> 'label' = 'Phone two')),
  '22023', 'not_found', 'another group cannot revoke the phone');
select public.revoke_device(pg_temp.v('tok1'), (select (d ->> 'id')::uuid from jsonb_array_elements(public.list_devices(pg_temp.v('tok1'))) d where d ->> 'label' = 'Phone two'));
select throws_ok(format('select public.get_summary(%L)', pg_temp.v('tok2')), '28000', 'invalid_device', 'a revoked phone is locked out');

-- Export
select public.add_entry(pg_temp.v('tok1'), 'expense', 'Wifi', '2026-10-01', 9000, pg_temp.v('h1')::uuid, null, 'third');
select public.delete_entry(pg_temp.v('tok1'), (public.add_entry(pg_temp.v('tok1'), 'expense', 'Typo', '2026-10-02', 100, pg_temp.v('h1')::uuid, null, 'half') ->> 'id')::uuid);
select is((select array_agg((e ->> 'description') || ':' || (e ->> 'deleted_at' is not null)) from jsonb_array_elements(public.export_entries(pg_temp.v('tok1'))) e),
  array['Wifi:false', 'Typo:true'], 'export includes every entry, deleted ones too, oldest first');

select * from finish();
rollback;
