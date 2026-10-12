-- Groups, PINs, devices and the lockout. Uses made-up names and PINs only.
begin;
select plan(38);

delete from private.pin_attempts;

-- Owner-only functions are not callable from the API; join RPCs are.
select ok(not has_function_privilege('anon', 'private.create_group(text, text, text)', 'execute'), 'anon cannot create groups');
select ok(not has_function_privilege('anon', 'private.set_pin(text, text)', 'execute'), 'anon cannot change a PIN');
select ok(has_function_privilege('anon', 'public.register_device(text, text, text)', 'execute'), 'anon can register a device');
select ok(has_function_privilege('anon', 'public.ping()', 'execute'), 'anon can ping');
select ok(not has_function_privilege('authenticated', 'public.register_device(text, text, text)', 'execute'), 'authenticated cannot call RPCs');

-- Group creation
select throws_ok($$select private.create_group('Test House', 'households', '123')$$, '22023', 'invalid_pin_format', 'PIN shorter than 4 digits is rejected');
select throws_ok($$select private.create_group('Test House', 'households', 'abcd')$$, '22023', 'invalid_pin_format', 'non-digit PIN is rejected');
select throws_ok($$select private.create_group('Test House', 'teams', '1234')$$, '22023', 'invalid_mode', 'unknown mode is rejected');

create temp table t (key text primary key, val text) on commit drop;
grant all on t to anon;
insert into t values ('code_a', private.create_group('Test House', 'households', '4821'));
insert into t values ('code_b', private.create_group('Other House', 'households', '7730'));
insert into t values ('code_p', private.create_group('Trip', 'people', '5555'));
insert into t values ('group_a', (select group_id::text from private.group_secrets where code = private.normalize_code((select val from t where key = 'code_a'))));
insert into t values ('group_b', (select group_id::text from private.group_secrets where code = private.normalize_code((select val from t where key = 'code_b'))));
insert into t values ('group_p', (select group_id::text from private.group_secrets where code = private.normalize_code((select val from t where key = 'code_p'))));

select matches((select val from t where key = 'code_a'), '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$', 'group code looks like K7MQ-2XPA');
select isnt((select val from t where key = 'code_a'), (select val from t where key = 'code_b'), 'each group gets its own code');
select is((select array_agg(name order by sort_order) from public.parties where group_id = (select val from t where key = 'group_a')::uuid),
  array['Household 1', 'Household 2'], 'household group starts with two households');
select is((select count(*)::int from public.parties where group_id = (select val from t where key = 'group_p')::uuid), 0, 'people group starts with no parties');
select matches((select pin_hash from private.group_secrets where group_id = (select val from t where key = 'group_a')::uuid), '^\$2[ab]\$10\$', 'PIN is stored as a bcrypt hash');

-- Joining
set local role anon;
select is(public.register_device((select val from t where key = 'code_a'), '0000'), '{"error": "invalid_credentials"}'::jsonb, 'wrong PIN is refused');
select is(public.register_device('ZZZZ-ZZZZ', '4821'), '{"error": "invalid_credentials"}'::jsonb, 'unknown code gets the same answer');
insert into t values ('tok_a', public.register_device(lower(replace((select val from t where key = 'code_a'), '-', ' ')), '4821', '  Test phone  ') ->> 'token');
select matches((select val from t where key = 'tok_a'), '^[0-9a-f]{64}$', 'right PIN returns a 64-character token, code accepted in lowercase with spaces');
insert into t values ('tok_b', public.register_device((select val from t where key = 'code_b'), '7730') ->> 'token');
insert into t values ('tok_p', public.register_device((select val from t where key = 'code_p'), '5555') ->> 'token');
select is(public.ping(), 'ok', 'ping works for anon');
reset role;

select is((select count(*)::int from private.devices where token_hash = extensions.digest(decode((select val from t where key = 'tok_a'), 'hex'), 'sha256')),
  1, 'only the sha256 of the token is stored');
select is((select label from private.devices where token_hash = extensions.digest(decode((select val from t where key = 'tok_a'), 'hex'), 'sha256')),
  'Test phone', 'device label is trimmed');
select is((select group_id::text from private.require_device((select val from t where key = 'tok_a'))), (select val from t where key = 'group_a'),
  'token resolves to its group');
select throws_ok($$select * from private.require_device('nope')$$, '28000', 'invalid_device', 'malformed token is rejected');
select throws_ok(format('select * from private.require_device(%L)', repeat('ab', 32)), '28000', 'invalid_device', 'unknown token is rejected');
select throws_ok(format('select * from private.require_person(%L)', (select val from t where key = 'tok_a')), '22023', 'no_person', 'a device must pick a person before writing');

-- Picking a person
insert into t values ('hh_a1', (select id::text from public.parties where group_id = (select val from t where key = 'group_a')::uuid and sort_order = 1));
insert into t values ('hh_b1', (select id::text from public.parties where group_id = (select val from t where key = 'group_b')::uuid and sort_order = 1));
set local role anon;
select throws_ok(
  format('select public.add_self(%L, %L, %L, %L)', (select val from t where key = 'tok_a'), 'Alex',
         (select val from t where key = 'hh_b1'), '1111'),
  '22023', 'invalid_party', 'cannot join a household in another group');
select throws_ok(format('select public.add_self(%L, %L, null, %L)', (select val from t where key = 'tok_a'), 'Alex', '1111'),
  '22023', 'invalid_party', 'household mode needs a household');
select throws_ok(
  format('select public.add_self(%L, %L, %L, %L)', (select val from t where key = 'tok_a'), '   ',
         (select val from t where key = 'hh_a1'), '1111'),
  '22023', 'invalid_name', 'blank name is rejected');
reset role;
insert into t values ('alex', public.add_self((select val from t where key = 'tok_a'), ' Alex ',
  (select id from public.parties where group_id = (select val from t where key = 'group_a')::uuid and sort_order = 1), '1111')::text);
select is((select name from public.people where id = (select val from t where key = 'alex')::uuid), 'Alex', 'add_self creates the person');
select is((select person_id::text from private.require_person((select val from t where key = 'tok_a'))), (select val from t where key = 'alex'),
  'add_self sets the device person');

insert into t values ('sam', public.add_self((select val from t where key = 'tok_p'), 'Sam', null, '1111')::text);
select is((select pa.kind from public.people pe join public.parties pa on pa.id = pe.party_id where pe.id = (select val from t where key = 'sam')::uuid),
  'person', 'in people mode add_self creates a person party');

set local role anon;
select throws_ok(format('select public.set_device_person(%L, %L, %L)', (select val from t where key = 'tok_b'), (select val from t where key = 'alex'), '1111'),
  '22023', 'invalid_person', 'cannot pick a person from another group');
reset role;
update public.people set archived_at = now() where id = (select val from t where key = 'alex')::uuid;
select throws_ok(format('select public.set_device_person(%L, %L, %L)', (select val from t where key = 'tok_a'), (select val from t where key = 'alex'), '1111'),
  '22023', 'invalid_person', 'cannot pick an archived person');
select throws_ok(format('select * from private.require_person(%L)', (select val from t where key = 'tok_a')), '22023', 'no_person',
  'a device whose person was archived must pick again');
update public.people set archived_at = null where id = (select val from t where key = 'alex')::uuid;

-- Revoked devices
update private.devices set revoked_at = now() where token_hash = extensions.digest(decode((select val from t where key = 'tok_b'), 'hex'), 'sha256');
select throws_ok(format('select * from private.require_device(%L)', (select val from t where key = 'tok_b')), '28000', 'invalid_device', 'revoked device is rejected');

-- Changing the PIN keeps existing devices
select lives_ok(format('select private.set_pin(%L, %L)', (select val from t where key = 'code_a'), '9090'), 'owner can change the PIN');
select is(public.register_device((select val from t where key = 'code_a'), '4821'), '{"error": "invalid_credentials"}'::jsonb, 'old PIN stops working');
select lives_ok(format('select * from private.require_device(%L)', (select val from t where key = 'tok_a')), 'existing device still works after a PIN change');

-- Lockout: 10 failed attempts in 15 minutes blocks everyone, even with the right PIN.
delete from private.pin_attempts;
select public.register_device('ZZZZ-ZZZZ', '0000') from generate_series(1, 10);
select throws_ok(format('select public.register_device(%L, %L)', (select val from t where key = 'code_a'), '9090'),
  '28000', 'locked_out', 'the 11th attempt is locked out even with the right PIN');
update private.pin_attempts set at = at - interval '16 minutes';
select ok(public.register_device((select val from t where key = 'code_a'), '9090') ? 'token', 'works again once the window has passed');

select * from finish();
rollback;
