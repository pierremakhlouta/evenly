-- People mode: settling everyone up at once. Made-up names and numbers only.
begin;
select plan(12);

delete from private.pin_attempts;
create temp table t (key text primary key, val text) on commit drop;
create function pg_temp.v(p_key text) returns text language sql as $$ select val from t where key = p_key $$;
create function pg_temp.party(p_person text) returns text language sql as $$
  select party_id::text from public.people where id = pg_temp.v(p_person)::uuid
$$;
create function pg_temp.expected(p_group text) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('from', s.from_party, 'to', s.to_party, 'cents', s.cents) order by s.n), '[]')
  from private.settle_payments(p_group::uuid) s
$$;

insert into t values ('code', private.create_group('Trip', 'people', '5555'));
insert into t select 'group', group_id::text from private.group_secrets where code = private.normalize_code(pg_temp.v('code'));
insert into t values ('tok', public.register_device(pg_temp.v('code'), '5555') ->> 'token');
insert into t values ('dana', public.add_self(pg_temp.v('tok'), 'Dana', null, '1111')::text);
insert into t values ('eli', public.upsert_person(pg_temp.v('tok'), null, 'Eli')::text);
insert into t values ('finn', public.upsert_person(pg_temp.v('tok'), null, 'Finn')::text);
insert into t values ('gus', public.upsert_person(pg_temp.v('tok'), null, 'Gus')::text);

-- Dana pays $120 for four; Eli pays $40 for Eli and Finn.
select public.add_entry(pg_temp.v('tok'), 'expense', 'Cabin', '2026-10-02', 12000, pg_temp.party('dana')::uuid, null, 'equal', null, null,
  jsonb_build_array(jsonb_build_object('party_id', pg_temp.party('dana')), jsonb_build_object('party_id', pg_temp.party('eli')),
                    jsonb_build_object('party_id', pg_temp.party('finn')), jsonb_build_object('party_id', pg_temp.party('gus'))));
select public.add_entry(pg_temp.v('tok'), 'expense', 'Snacks', '2026-10-03', 4000, pg_temp.party('eli')::uuid, null, 'equal', null, null,
  jsonb_build_array(jsonb_build_object('party_id', pg_temp.party('eli')), jsonb_build_object('party_id', pg_temp.party('finn'))));

-- Nets: Dana +9000, Eli -1000, Finn -5000, Gus -3000.
select is(pg_temp.expected(pg_temp.v('group')), jsonb_build_array(
    jsonb_build_object('from', pg_temp.party('finn'), 'to', pg_temp.party('dana'), 'cents', 5000),
    jsonb_build_object('from', pg_temp.party('gus'), 'to', pg_temp.party('dana'), 'cents', 3000),
    jsonb_build_object('from', pg_temp.party('eli'), 'to', pg_temp.party('dana'), 'cents', 1000)),
  'the fewest payments that settle everyone, largest debt first');

select throws_ok(format('select public.settle_up_all(%L, %L, %L)', pg_temp.v('tok'), '[]', '2026-10-31'),
  '22023', 'balance_changed', 'a stale list of payments is refused');
select throws_ok(
  format('select public.settle_up(%L, 1000, %L)', pg_temp.v('tok'), '2026-10-31'),
  '22023', 'not_supported', 'people mode uses settle_up_all');

insert into t values ('settled', public.settle_up_all(pg_temp.v('tok'), pg_temp.expected(pg_temp.v('group')), '2026-10-31', ' E-transfers ')::text);
select is(jsonb_array_length(pg_temp.v('settled')::jsonb), 3, 'one payment per suggestion');
select ok((select bool_and((e ->> 'settles')::boolean and e ->> 'kind' = 'payment' and e ->> 'description' = 'E-transfers')
           from jsonb_array_elements(pg_temp.v('settled')::jsonb) e), 'each is a settling payment with the note');
select is((select e ->> 'paid_by_person_id' from jsonb_array_elements(pg_temp.v('settled')::jsonb) e limit 1), pg_temp.v('finn'),
  'each payment records the person who paid');
select is((select count(*)::int from private.party_nets(pg_temp.v('group')::uuid) where net_cents <> 0), 0, 'everyone is settled');
select throws_ok(format('select public.settle_up_all(%L, %L, %L)', pg_temp.v('tok'), '[]', '2026-10-31'),
  '22023', 'already_settled', 'settling twice is refused');

-- The payments made together end one period.
insert into t values ('periods', public.list_periods(pg_temp.v('tok'))::text);
select is(jsonb_array_length(pg_temp.v('periods')::jsonb -> 'settled'), 1, 'one settled period, not three');
select is(jsonb_array_length(pg_temp.v('periods')::jsonb -> 'settled' -> 0 -> 'settlements'), 3, 'the period lists all three payments');
select is((pg_temp.v('periods')::jsonb -> 'settled' -> 0 ->> 'entry_count')::int, 5, 'it holds both expenses and the three payments');

-- Household groups keep using settle_up.
insert into t values ('code_h', private.create_group('House', 'households', '4821'));
insert into t values ('tok_h', public.register_device(pg_temp.v('code_h'), '4821') ->> 'token');
select public.add_self(pg_temp.v('tok_h'), 'Alex',
  (select p.id from public.parties p join private.group_secrets gs on gs.group_id = p.group_id
   where gs.code = private.normalize_code(pg_temp.v('code_h')) and p.sort_order = 1), '1111');
select throws_ok(format('select public.settle_up_all(%L, %L, %L)', pg_temp.v('tok_h'), '[]', '2026-10-31'),
  '22023', 'not_supported', 'household groups settle with settle_up');

select * from finish();
rollback;
