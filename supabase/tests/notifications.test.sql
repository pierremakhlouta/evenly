-- Push notifications: subscriptions, wording, recipients and the queued call.
-- Made-up names, numbers and endpoints only.
begin;
select plan(22);

delete from private.pin_attempts;
create temp table t (key text primary key, val text) on commit drop;
create function pg_temp.v(p_key text) returns text language sql as $$ select val from t where key = p_key $$;
create function pg_temp.last_event() returns bigint language sql as $$ select max(id) from public.entry_events $$;
create function pg_temp.body() returns text language sql as $$ select private.push_message(pg_temp.last_event()) ->> 'body' $$;
create function pg_temp.targets() returns text[] language sql as $$
  select coalesce(array_agg(endpoint order by endpoint), '{}') from private.push_targets(pg_temp.last_event())
$$;
-- A valid-looking subscription: 87-character key, 22-character auth secret.
create function pg_temp.sub(p_token text, p_name text) returns void language sql as $$
  select public.save_push_subscription(p_token, 'https://push.example.net/' || p_name, repeat('B', 87), repeat('a', 22))
$$;

insert into t values ('code', private.create_group('Test House', 'households', '4821'));
insert into t select 'group', group_id::text from private.group_secrets where code = private.normalize_code(pg_temp.v('code'));
insert into t select 'h1', id::text from public.parties where group_id = pg_temp.v('group')::uuid and sort_order = 1;
insert into t select 'h2', id::text from public.parties where group_id = pg_temp.v('group')::uuid and sort_order = 2;
update public.parties set name = 'Main floor' where id = pg_temp.v('h1')::uuid;
update public.parties set name = 'Basement' where id = pg_temp.v('h2')::uuid;
insert into t values ('alex_phone', public.register_device(pg_temp.v('code'), '4821') ->> 'token');
insert into t values ('alex_ipad', public.register_device(pg_temp.v('code'), '4821') ->> 'token');
insert into t values ('sam_phone', public.register_device(pg_temp.v('code'), '4821') ->> 'token');
insert into t values ('jo_phone', public.register_device(pg_temp.v('code'), '4821') ->> 'token');
insert into t values ('nobody_phone', public.register_device(pg_temp.v('code'), '4821') ->> 'token');
insert into t values ('alex', public.add_self(pg_temp.v('alex_phone'), 'Alex', pg_temp.v('h1')::uuid, '1111')::text);
select public.set_device_person(pg_temp.v('alex_ipad'), pg_temp.v('alex')::uuid, '1111');
insert into t values ('sam', public.upsert_person(pg_temp.v('alex_phone'), null, 'Sam', pg_temp.v('h2')::uuid)::text);
select public.set_device_person(pg_temp.v('sam_phone'), pg_temp.v('sam')::uuid, '2222');
insert into t values ('jo', public.upsert_person(pg_temp.v('alex_phone'), null, 'Jo', pg_temp.v('h1')::uuid)::text);
select public.set_device_person(pg_temp.v('jo_phone'), pg_temp.v('jo')::uuid, '3333');

-- Subscriptions
select throws_ok(format('select public.save_push_subscription(%L, %L, %L, %L)', pg_temp.v('alex_phone'), 'http://insecure.example', repeat('B', 87), repeat('a', 22)),
  '22023', 'invalid_subscription', 'only https push endpoints are accepted');
select throws_ok(format('select public.save_push_subscription(%L, %L, %L, %L)', pg_temp.v('alex_phone'), 'https://push.example.net/x', 'short', repeat('a', 22)),
  '22023', 'invalid_subscription', 'a malformed key is rejected');
select pg_temp.sub(pg_temp.v('alex_phone'), 'alex-phone');
select pg_temp.sub(pg_temp.v('alex_ipad'), 'alex-ipad');
select pg_temp.sub(pg_temp.v('sam_phone'), 'sam-phone');
select pg_temp.sub(pg_temp.v('jo_phone'), 'jo-phone');
select pg_temp.sub(pg_temp.v('nobody_phone'), 'nobody-phone');
select is((select count(*)::int from private.push_subscriptions s join private.devices d on d.id = s.device_id where d.group_id = pg_temp.v('group')::uuid),
  5, 'each phone saved its subscription');
select pg_temp.sub(pg_temp.v('jo_phone'), 'alex-ipad');
select is((select d.person_id::text from private.push_subscriptions s join private.devices d on d.id = s.device_id where s.endpoint = 'https://push.example.net/alex-ipad'),
  pg_temp.v('jo'), 'saving an endpoint again moves it to the phone that saved it');
select pg_temp.sub(pg_temp.v('alex_ipad'), 'alex-ipad');
select public.delete_push_subscription(pg_temp.v('sam_phone'), 'https://push.example.net/alex-phone');
select is((select count(*)::int from private.push_subscriptions where endpoint = 'https://push.example.net/alex-phone'), 1,
  'a phone cannot turn off another phone''s notifications');

-- Wording
select public.add_entry(pg_temp.v('alex_phone'), 'expense', 'Hydro', '2026-10-05', 13412, pg_temp.v('h1')::uuid, null, 'third');
insert into t values ('hydro', (select entry_id::text from public.entry_events where id = pg_temp.last_event()));
select is(pg_temp.body(), 'Alex added Hydro · $134.12', 'a new expense says who added what and the total');
select is(private.push_message(pg_temp.last_event()) ->> 'title', 'Test House', 'the title is the group name');
select is(private.push_message(pg_temp.last_event()) ->> 'tag', 'entry-' || pg_temp.v('hydro'), 'one tag per entry, so updates replace older ones');

-- Recipients: everyone except the person who did it (all their phones), only phones with a person.
select is(pg_temp.targets(), array['https://push.example.net/jo-phone', 'https://push.example.net/sam-phone'],
  'everyone else is notified, including the same household, but not Alex''s phone or iPad');
select ok(not ('https://push.example.net/nobody-phone' = any(pg_temp.targets())), 'a phone that never picked a person is not notified');

select public.edit_entry(pg_temp.v('sam_phone'), pg_temp.v('hydro')::uuid, 'Hydro', '2026-10-05', 12644, pg_temp.v('h1')::uuid, null, 'third');
select is(pg_temp.body(), 'Sam edited Hydro · now $126.44', 'an edit says the new total');
select is(pg_temp.targets(), array['https://push.example.net/alex-ipad', 'https://push.example.net/alex-phone', 'https://push.example.net/jo-phone'],
  'when Sam edits, Sam is the one left out');
select public.delete_entry(pg_temp.v('sam_phone'), pg_temp.v('hydro')::uuid);
select is(pg_temp.body(), 'Sam deleted Hydro · $126.44', 'a delete says what was deleted');
select public.restore_entry(pg_temp.v('alex_phone'), pg_temp.v('hydro')::uuid);
select is(pg_temp.body(), 'Alex restored Hydro · $126.44', 'a restore says what came back');

select public.add_entry(pg_temp.v('sam_phone'), 'payment', 'E-transfer', '2026-10-06', 2000, pg_temp.v('h2')::uuid);
select is(pg_temp.body(), 'Sam recorded a payment: Basement paid Main floor $20.00', 'a payment says who paid whom');
select public.settle_up(pg_temp.v('sam_phone'), 2215, '2026-10-31');
select is(pg_temp.body(), 'Sam settled up: Basement paid Main floor $22.15', 'a settle-up says so');

update public.recurring_bills set active = false where group_id <> pg_temp.v('group')::uuid;
select public.upsert_recurring_bill(pg_temp.v('alex_phone'), null, 'Rent', pg_temp.v('h1')::uuid, 'third',
  p_default_total_cents => 240000, p_auto_add => true, p_day_of_month => 1);
select private.auto_add_bills('2026-11-02');
select is(pg_temp.body(), 'Rent was added automatically · $2,400.00', 'an automatic bill says it was added automatically');
select is(cardinality(pg_temp.targets()), 4, 'an automatic bill notifies every phone with a person');

-- Revoked phones are never notified.
update private.devices set revoked_at = now() where token_hash = extensions.digest(decode(pg_temp.v('jo_phone'), 'hex'), 'sha256');
select ok(not ('https://push.example.net/jo-phone' = any(pg_temp.targets())), 'a revoked phone is not notified');

-- The queued call: nothing without a URL in Vault, one call with it.
select is((select count(*)::int from net.http_request_queue), 0, 'without a function URL nothing is sent');
select vault.create_secret('https://example.test/functions/v1/notify', 'evenly_notify_url');
select public.add_entry(pg_temp.v('alex_phone'), 'expense', 'Water', '2026-11-03', 5250, pg_temp.v('h1')::uuid, null, 'third');
select is((select count(*)::int from net.http_request_queue), 1, 'with the URL set, one call is queued per change');
select is(
  (select jsonb_build_object('url', q.url, 'event', convert_from(q.body, 'utf8')::jsonb ->> 'event_id',
                             'auth', q.headers ->> 'Authorization' like 'Bearer %')
     from net.http_request_queue q),
  jsonb_build_object('url', 'https://example.test/functions/v1/notify', 'event', pg_temp.last_event()::text, 'auth', true),
  'the call carries only the event id and the shared secret');

select * from finish();
rollback;
