-- People mode: debt simplification and settling everyone up at once.
--
-- private.simplify_nets must give exactly the same payments as
-- src/money/simplify.ts (shared/test-vectors.json checks both): repeatedly match the
-- largest creditor with the largest debtor, ties going to the party listed first.
--
-- settle_up_all records all the suggested payments in one transaction. They share a
-- creation time, so together they end one period; list_periods now groups settling
-- payments made together into a single period.

-- p_nets: [{"id": ..., "net_cents": ...}] in list order (sort order, then id).
-- Returns the payments in the order they were found.
create function private.simplify_nets(p_nets jsonb)
returns table (from_id text, to_id text, cents bigint, n integer)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
  v_cents bigint[];
  v_len integer;
  v_creditor integer;
  v_debtor integer;
  v_amount bigint;
  v_count integer := 0;
begin
  select array_agg(e ->> 'id' order by o), array_agg((e ->> 'net_cents')::bigint order by o)
  into v_ids, v_cents
  from jsonb_array_elements(p_nets) with ordinality as x(e, o);
  v_len := coalesce(array_length(v_ids, 1), 0);

  if v_len > 0 and (select sum(c) from unnest(v_cents) c) <> 0 then
    perform private.fail('nets_unbalanced', '22023', 'Net positions must add up to 0');
  end if;

  loop
    v_creditor := null;
    v_debtor := null;
    for i in 1 .. v_len loop
      if v_cents[i] > 0 and (v_creditor is null or v_cents[i] > v_cents[v_creditor]) then
        v_creditor := i;
      end if;
      if v_cents[i] < 0 and (v_debtor is null or v_cents[i] < v_cents[v_debtor]) then
        v_debtor := i;
      end if;
    end loop;
    exit when v_creditor is null or v_debtor is null;

    v_amount := least(v_cents[v_creditor], -v_cents[v_debtor]);
    v_count := v_count + 1;
    from_id := v_ids[v_debtor];
    to_id := v_ids[v_creditor];
    cents := v_amount;
    n := v_count;
    return next;
    v_cents[v_creditor] := v_cents[v_creditor] - v_amount;
    v_cents[v_debtor] := v_cents[v_debtor] + v_amount;
  end loop;
end;
$$;

-- The payments that would settle a group right now.
create function private.settle_payments(p_group_id uuid)
returns table (from_party uuid, to_party uuid, cents bigint, n integer)
language sql
stable
set search_path = ''
as $$
  select s.from_id::uuid, s.to_id::uuid, s.cents, s.n
  from private.simplify_nets((
    select jsonb_agg(jsonb_build_object('id', p.party_id, 'net_cents', p.net_cents))
    from private.party_nets(p_group_id) p
  )) s;
$$;

-- People mode: records every suggested payment at once, which settles everyone and
-- ends the period. p_expected is the list the phone showed,
-- [{"from": party, "to": party, "cents": n}, ...]; if the balances changed since,
-- this fails with balance_changed so nobody settles stale amounts.
create function public.settle_up_all(
  p_token text,
  p_expected jsonb,
  p_entry_date date,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_mode text;
  v_payments jsonb;
  v_note text;
  v_payment record;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  select * into v_device from private.require_person(p_token);
  select g.mode into v_mode from public.groups g where g.id = v_device.group_id for update;
  if v_mode <> 'people' then
    perform private.fail('not_supported', '22023', 'Household groups use settle_up');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('from', s.from_party, 'to', s.to_party, 'cents', s.cents) order by s.n), '[]')
  into v_payments
  from private.settle_payments(v_device.group_id) s;

  if jsonb_array_length(v_payments) = 0 then
    perform private.fail('already_settled', '22023', 'Everyone is already settled up');
  end if;
  if p_expected is distinct from v_payments then
    perform private.fail('balance_changed', '22023', 'The balances changed');
  end if;

  v_note := private.check_entry_fields('payment', p_note, p_entry_date);

  for v_payment in select * from private.settle_payments(v_device.group_id) order by n loop
    perform private.check_total(v_payment.cents);
    insert into public.entries (
      group_id, kind, description, entry_date, total_cents, paid_by_party_id, paid_by_person_id,
      settles, created_by_person_id)
    values (
      v_device.group_id, 'payment', v_note, p_entry_date, v_payment.cents, v_payment.from_party,
      (select pe.id from public.people pe where pe.party_id = v_payment.from_party and pe.archived_at is null limit 1),
      true, v_device.person_id)
    returning id into v_id;

    perform private.write_shares(v_device.group_id, v_id,
      jsonb_build_array(jsonb_build_object('party_id', v_payment.to_party, 'share_cents', v_payment.cents)));
    insert into public.entry_events (group_id, entry_id, action, by_person_id, after, note)
    values (v_device.group_id, v_id, 'create', v_device.person_id, private.entry_json(v_id), 'Settled the full balance');
    v_ids := v_ids || v_id;
  end loop;

  return (select jsonb_agg(private.entry_json(u.id) order by u.n) from unnest(v_ids) with ordinality as u(id, n));
end;
$$;

-- Periods: settling payments made together (same creation time) end one period.
-- 'settlements' lists them all; 'settlement' (the first) is kept for older phones.
create or replace function public.list_periods(p_token text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_last timestamptz;
begin
  select * into v_device from private.require_device(p_token);
  v_last := private.last_settled_at(v_device.group_id);

  return jsonb_build_object(
    'current', (
      select jsonb_build_object(
        'created_after', v_last,
        'entry_count', count(*),
        'first_date', min(e.entry_date),
        'last_date', max(e.entry_date))
      from public.entries e
      where e.group_id = v_device.group_id and e.deleted_at is null
        and (v_last is null or e.created_at > v_last)
    ),
    'settled', coalesce((
      select jsonb_agg(jsonb_build_object(
          'settlement', s.settlements -> 0,
          'settlements', s.settlements,
          'created_after', s.previous,
          'created_until', s.created_at,
          'entry_count', (select count(*) from public.entries e
                          where e.group_id = v_device.group_id and e.deleted_at is null
                            and (s.previous is null or e.created_at > s.previous) and e.created_at <= s.created_at),
          'first_date', (select min(e.entry_date) from public.entries e
                         where e.group_id = v_device.group_id and e.deleted_at is null
                           and (s.previous is null or e.created_at > s.previous) and e.created_at <= s.created_at),
          'last_date', (select max(e.entry_date) from public.entries e
                        where e.group_id = v_device.group_id and e.deleted_at is null
                          and (s.previous is null or e.created_at > s.previous) and e.created_at <= s.created_at))
        order by s.created_at desc)
      from (
        select g.created_at, g.settlements, lag(g.created_at) over (order by g.created_at) as previous
        from (
          select e.created_at, jsonb_agg(private.entry_json(e.id) order by e.id) as settlements
          from public.entries e
          where e.group_id = v_device.group_id and e.settles and e.deleted_at is null
          group by e.created_at
        ) g
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.settle_up_all(text, jsonb, date, text) from public, authenticated;
grant execute on function public.settle_up_all(text, jsonb, date, text) to anon;
