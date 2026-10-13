-- Auto-added monthly bills. Made-up names and numbers only.
begin;
select plan(14);

delete from private.pin_attempts;
create temp table t (key text primary key, val text) on commit drop;
create function pg_temp.v(p_key text) returns text language sql as $$ select val from t where key = p_key $$;
create function pg_temp.bill_entries(p_bill text) returns integer language sql as $$
  select count(*)::integer from public.entries where recurring_bill_id = p_bill::uuid
$$;

insert into t values ('code', private.create_group('Test House', 'households', '4821'));
insert into t select 'group', group_id::text from private.group_secrets where code = private.normalize_code(pg_temp.v('code'));
insert into t select 'h1', id::text from public.parties where group_id = pg_temp.v('group')::uuid and sort_order = 1;
insert into t select 'h2', id::text from public.parties where group_id = pg_temp.v('group')::uuid and sort_order = 2;
insert into t values ('tok', public.register_device(pg_temp.v('code'), '4821') ->> 'token');
select public.add_self(pg_temp.v('tok'), 'Alex', pg_temp.v('h1')::uuid, '1111');

insert into t values ('rent', public.upsert_recurring_bill(pg_temp.v('tok'), null, 'Rent', pg_temp.v('h1')::uuid, 'third',
  p_default_total_cents => 240000, p_auto_add => true, p_day_of_month => 1) ->> 'id');
insert into t values ('wifi', public.upsert_recurring_bill(pg_temp.v('tok'), null, 'Wifi', pg_temp.v('h1')::uuid, 'half',
  p_default_total_cents => 8500, p_auto_add => true, p_day_of_month => 15) ->> 'id');
insert into t values ('hydro', public.upsert_recurring_bill(pg_temp.v('tok'), null, 'Hydro', pg_temp.v('h1')::uuid, 'third') ->> 'id');

-- Only this test's group: pause the seed groups' bills for the length of the test.
update public.recurring_bills set active = false where group_id <> pg_temp.v('group')::uuid;

select ok(exists (select 1 from cron.job where jobname = 'evenly-auto-add-bills' and command = 'select private.auto_add_bills()'),
  'the daily job is scheduled');
select ok(not has_function_privilege('anon', 'private.auto_add_bills(date)', 'execute'), 'the API cannot run the job');

-- October 10: rent (day 1) is due, wifi (day 15) is not, hydro is never automatic.
select is(private.auto_add_bills('2026-10-10'), 1, 'only the bills whose day has come are added');
select is(pg_temp.bill_entries(pg_temp.v('rent')), 1, 'rent was added');
select is(pg_temp.bill_entries(pg_temp.v('wifi')), 0, 'wifi waits for the 15th');
select is(pg_temp.bill_entries(pg_temp.v('hydro')), 0, 'a shortcut bill is never added automatically');

select is(
  (select jsonb_build_object('date', e.entry_date, 'period', e.bill_period, 'total', e.total_cents, 'by', e.created_by_person_id,
                             'shares', (select jsonb_object_agg(s.party_id, s.share_cents) from public.entry_shares s where s.entry_id = e.id))
     from public.entries e where e.recurring_bill_id = pg_temp.v('rent')::uuid),
  jsonb_build_object('date', '2026-10-01', 'period', '2026-10-01', 'total', 240000, 'by', null,
                     'shares', jsonb_build_object(pg_temp.v('h1'), 160000, pg_temp.v('h2'), 80000)),
  'the auto entry is dated on its day, split by the bill''s rule, and added by nobody');
select is((select array[ev.action, ev.note, coalesce(ev.by_person_id::text, 'automatic')] from public.entry_events ev
           join public.entries e on e.id = ev.entry_id where e.recurring_bill_id = pg_temp.v('rent')::uuid),
  array['create', 'Added automatically', 'automatic'], 'the change log says it was added automatically');

select is(private.auto_add_bills('2026-10-20'), 1, 'later in the month, wifi is added and rent is not repeated');
select is(private.auto_add_bills('2026-10-31'), 0, 'running again the same month adds nothing');

-- A deleted auto entry is never re-added for that month.
select public.delete_entry(pg_temp.v('tok'), (select id from public.entries where recurring_bill_id = pg_temp.v('rent')::uuid));
select is(private.auto_add_bills('2026-10-31'), 0, 'a deleted copy is not added again');

-- November adds both again; an archived bill stops.
select public.archive_recurring_bill(pg_temp.v('tok'), pg_temp.v('wifi')::uuid);
select is(private.auto_add_bills('2026-11-20'), 1, 'next month the active bill is added again, the archived one is not');
select is(pg_temp.bill_entries(pg_temp.v('wifi')), 1, 'the archived bill keeps its past entry');

-- People mode: an automatic bill split by shares.
insert into t values ('code_p', private.create_group('Flat', 'people', '5555'));
insert into t values ('tokp', public.register_device(pg_temp.v('code_p'), '5555') ->> 'token');
insert into t values ('dana', public.add_self(pg_temp.v('tokp'), 'Dana', null, '1111')::text);
insert into t values ('eli', public.upsert_person(pg_temp.v('tokp'), null, 'Eli')::text);
insert into t select 'pd', party_id::text from public.people where id = pg_temp.v('dana')::uuid;
insert into t select 'pe', party_id::text from public.people where id = pg_temp.v('eli')::uuid;
insert into t values ('flat_rent', public.upsert_recurring_bill(pg_temp.v('tokp'), null, 'Rent', pg_temp.v('pd')::uuid, 'weights',
  p_split_inputs => jsonb_build_array(jsonb_build_object('party_id', pg_temp.v('pd'), 'value', 2), jsonb_build_object('party_id', pg_temp.v('pe'), 'value', 1)),
  p_default_total_cents => 90000, p_auto_add => true, p_day_of_month => 1) ->> 'id');
select private.auto_add_bills('2026-12-02');
select is(
  (select jsonb_object_agg(s.party_id, s.share_cents) from public.entry_shares s
     join public.entries e on e.id = s.entry_id where e.recurring_bill_id = pg_temp.v('flat_rent')::uuid),
  jsonb_build_object(pg_temp.v('pd'), 60000, pg_temp.v('pe'), 30000),
  'a people-mode automatic bill is split by its saved shares');

select * from finish();
rollback;
