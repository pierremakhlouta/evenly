-- Personal PINs, admins and joining rules. Made-up names and PINs only.
begin;
select plan(30);

delete from private.pin_attempts;
create temp table t (key text primary key, val text) on commit drop;
create function pg_temp.v(p_key text) returns text language sql as $$ select val from t where key = p_key $$;
create function pg_temp.person(p_token text, p_id text) returns jsonb language sql as $$
  select p from jsonb_array_elements(public.get_summary(p_token) -> 'people') p where p ->> 'id' = p_id
$$;

insert into t values ('code_a', private.create_group('Test House', 'households', '4821'));
insert into t select 'group_a', group_id::text from private.group_secrets where code = private.normalize_code(pg_temp.v('code_a'));
insert into t select 'h1', id::text from public.parties where group_id = pg_temp.v('group_a')::uuid and sort_order = 1;
insert into t select 'h2', id::text from public.parties where group_id = pg_temp.v('group_a')::uuid and sort_order = 2;
insert into t values ('tok1', public.register_device(pg_temp.v('code_a'), '4821') ->> 'token');
insert into t values ('tok2', public.register_device(pg_temp.v('code_a'), '4821') ->> 'token');
insert into t values ('tok3', public.register_device(pg_temp.v('code_a'), '4821') ->> 'token');

-- The first person of an empty group adds themselves and becomes admin.
select throws_ok(format('select public.add_self(%L, %L, %L, %L)', pg_temp.v('tok1'), 'Alex', pg_temp.v('h1'), '12'),
  '22023', 'invalid_pin_format', 'the first person needs a personal PIN of 4+ digits');
insert into t values ('alex', public.add_self(pg_temp.v('tok1'), 'Alex', pg_temp.v('h1')::uuid, '1111')::text);
select is(pg_temp.person(pg_temp.v('tok1'), pg_temp.v('alex')) -> 'is_admin', 'true'::jsonb, 'the first person is admin');
select is(pg_temp.person(pg_temp.v('tok1'), pg_temp.v('alex')) -> 'has_pin', 'true'::jsonb, 'the first person has a PIN');
select matches((select pin_hash from private.person_secrets where person_id = pg_temp.v('alex')::uuid), '^\$2[ab]\$10\$', 'personal PINs are bcrypt hashes');
select throws_ok(format('select public.add_self(%L, %L, %L, %L)', pg_temp.v('tok2'), 'Blair', pg_temp.v('h2'), '2222'),
  '42501', 'join_closed', 'nobody else can add themselves once the group has a person');

-- The admin adds people; their first phone creates their PIN.
insert into t values ('blair', public.upsert_person(pg_temp.v('tok1'), null, 'Blair', pg_temp.v('h2')::uuid)::text);
select is(pg_temp.person(pg_temp.v('tok1'), pg_temp.v('blair')) -> 'has_pin', 'false'::jsonb, 'a newly added person has no PIN yet');
select is(pg_temp.person(pg_temp.v('tok1'), pg_temp.v('blair')) -> 'is_admin', 'false'::jsonb, 'a newly added person is not admin');
select throws_ok(format('select public.upsert_person(%L, null, %L, %L)', pg_temp.v('tok2'), 'Sneaky', pg_temp.v('h2')),
  '22023', 'no_person', 'a phone without a person cannot add people');
select throws_ok(format('select public.set_device_person(%L, %L, %L)', pg_temp.v('tok2'), pg_temp.v('blair'), '12'),
  '22023', 'invalid_pin_format', 'a new personal PIN must be 4+ digits');
select is(public.set_device_person(pg_temp.v('tok2'), pg_temp.v('blair')::uuid, '2222'), '{"ok": true}'::jsonb, 'the first pick creates the PIN');

-- Nobody can pick someone else without their PIN.
select is(public.set_device_person(pg_temp.v('tok3'), pg_temp.v('alex')::uuid, '0000'), '{"error": "invalid_pin"}'::jsonb, 'a wrong personal PIN is refused');
select throws_ok(format('select * from private.require_person(%L)', pg_temp.v('tok3')), '22023', 'no_person', 'and the phone stays without a person');
select is(public.set_device_person(pg_temp.v('tok3'), pg_temp.v('alex')::uuid, '1111'), '{"ok": true}'::jsonb, 'the right PIN works on another phone');

-- Admin-only actions
select throws_ok(format('select public.upsert_person(%L, null, %L, %L)', pg_temp.v('tok2'), 'Sneaky', pg_temp.v('h2')), '42501', 'admin_only', 'non-admins cannot add people');
select throws_ok(format('select public.update_group(%L, %L)', pg_temp.v('tok2'), 'Renamed'), '42501', 'admin_only', 'non-admins cannot rename the group');
select throws_ok(format('select public.upsert_party(%L, %L, %L)', pg_temp.v('tok2'), pg_temp.v('h1'), 'Renamed'), '42501', 'admin_only', 'non-admins cannot rename households');
select throws_ok(format('select public.archive_person(%L, %L)', pg_temp.v('tok2'), pg_temp.v('alex')), '42501', 'admin_only', 'non-admins cannot archive people');
select throws_ok(format('select public.set_person_admin(%L, %L, true)', pg_temp.v('tok2'), pg_temp.v('blair')), '42501', 'admin_only', 'non-admins cannot make themselves admin');
select throws_ok(format('select public.reset_person_pin(%L, %L)', pg_temp.v('tok2'), pg_temp.v('alex')), '42501', 'admin_only', 'non-admins cannot reset a PIN');
select lives_ok(format('select public.add_entry(%L, %L, %L, %L, 100, %L, null, %L)', pg_temp.v('tok2'), 'expense', 'Snacks', '2026-10-01', pg_temp.v('h2'), 'half'),
  'everyone can still add entries');
select lives_ok(format('select public.upsert_recurring_bill(%L, null, %L, %L, %L)', pg_temp.v('tok2'), 'Wifi', pg_temp.v('h1'), 'half'),
  'everyone can still manage monthly bills');

-- There is always at least one admin.
select throws_ok(format('select public.set_person_admin(%L, %L, false)', pg_temp.v('tok1'), pg_temp.v('alex')), '22023', 'last_admin', 'the last admin cannot step down');
select public.set_person_admin(pg_temp.v('tok1'), pg_temp.v('blair')::uuid, true);
select lives_ok(format('select public.set_person_admin(%L, %L, false)', pg_temp.v('tok1'), pg_temp.v('alex')), 'an admin can step down once someone else is admin');
select throws_ok(format('select public.set_person_admin(%L, %L, false)', pg_temp.v('tok2'), pg_temp.v('blair')), '22023', 'last_admin', 'the new last admin cannot step down either');
select throws_ok(format('select public.upsert_person(%L, null, %L, %L)', pg_temp.v('tok1'), 'X', pg_temp.v('h1')), '42501', 'admin_only', 'a former admin loses admin rights');

-- Resetting a PIN signs that person out of every phone; the next pick creates a new PIN.
select public.reset_person_pin(pg_temp.v('tok2'), pg_temp.v('alex')::uuid);
select throws_ok(format('select * from private.require_person(%L)', pg_temp.v('tok1')), '22023', 'no_person', 'after a reset, phones using that person must pick again');
select is(public.set_device_person(pg_temp.v('tok1'), pg_temp.v('alex')::uuid, '3333'), '{"ok": true}'::jsonb, 'the next pick creates a new PIN');
select is(public.set_device_person(pg_temp.v('tok3'), pg_temp.v('alex')::uuid, '1111'), '{"error": "invalid_pin"}'::jsonb, 'the old PIN no longer works');

-- Personal PIN lockout is per person and does not affect joining.
delete from private.pin_attempts;
select public.set_device_person(pg_temp.v('tok3'), pg_temp.v('blair')::uuid, '0000') from generate_series(1, 10);
select throws_ok(format('select public.set_device_person(%L, %L, %L)', pg_temp.v('tok3'), pg_temp.v('blair'), '2222'),
  '28000', 'locked_out', '10 wrong PINs for a person lock that person out, even with the right PIN');
select ok(public.register_device(pg_temp.v('code_a'), '4821') ? 'token', 'joining the group still works while a person is locked out');

select * from finish();
rollback;
