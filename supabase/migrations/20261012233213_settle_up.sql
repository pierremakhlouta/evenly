-- Settle-up periods.
--
-- "Settle full balance" records a payment flagged settles = true. Each settling
-- payment ends a period. Periods follow creation time: a period holds the entries
-- created after the previous settle-up, up to and including its settling payment.
-- An entry added after a settle-up belongs to the new period even if it is dated
-- earlier, because that settle-up did not include it. Nothing is ever deleted, and
-- the balance is always computed from every active entry.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.entries add column settles boolean not null default false;
alter table public.entries add constraint entries_settles_is_payment check (not settles or kind = 'payment');
create index entries_group_created_idx on public.entries (group_id, created_at);

-- Snapshot now includes the settles flag.
create or replace function private.entry_json(p_entry_id uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', e.id,
    'kind', e.kind,
    'description', e.description,
    'entry_date', e.entry_date,
    'total_cents', e.total_cents,
    'paid_by_party_id', e.paid_by_party_id,
    'paid_by_person_id', e.paid_by_person_id,
    'split_type', e.split_type,
    'split_num', e.split_num,
    'split_den', e.split_den,
    'split_inputs', e.split_inputs,
    'recurring_bill_id', e.recurring_bill_id,
    'bill_period', e.bill_period,
    'settles', e.settles,
    'created_by_person_id', e.created_by_person_id,
    'created_at', e.created_at,
    'updated_at', e.updated_at,
    'deleted_at', e.deleted_at,
    'deleted_by_person_id', e.deleted_by_person_id,
    'shares', coalesce((
      select jsonb_agg(jsonb_build_object('party_id', s.party_id, 'share_cents', s.share_cents)
                       order by p.sort_order, p.id)
      from public.entry_shares s
      join public.parties p on p.id = s.party_id
      where s.entry_id = e.id
    ), '[]'::jsonb)
  )
  from public.entries e
  where e.id = p_entry_id;
$$;

-- Creation time of the latest active settle-up in a group, or null.
create function private.last_settled_at(p_group_id uuid) returns timestamptz
language sql
stable
set search_path = ''
as $$
  select max(e.created_at) from public.entries e
  where e.group_id = p_group_id and e.settles and e.deleted_at is null;
$$;

-- ---------------------------------------------------------------------------
-- settle_up: pay the whole household balance in one payment
-- ---------------------------------------------------------------------------

-- Household mode. The household that owes pays the other one the full balance.
-- p_expected_cents is the amount the phone showed; if the balance changed since,
-- this fails with balance_changed so nobody settles a stale amount.
create function public.settle_up(
  p_token text,
  p_expected_cents integer,
  p_entry_date date,
  p_note text default null,
  p_paid_by_person_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_mode text;
  v_debtor uuid;
  v_creditor uuid;
  v_amount bigint;
  v_note text;
  v_id uuid;
begin
  select * into v_device from private.require_person(p_token);
  select g.mode into v_mode from public.groups g where g.id = v_device.group_id for update;
  if v_mode <> 'households' then
    perform private.fail('not_supported', '22023', 'Settling up in people mode comes later');
  end if;

  select n.party_id, -n.net_cents into v_debtor, v_amount
  from private.party_nets(v_device.group_id) n where n.net_cents < 0;
  select n.party_id into v_creditor
  from private.party_nets(v_device.group_id) n where n.net_cents > 0;
  if v_debtor is null or v_creditor is null then
    perform private.fail('already_settled', '22023', 'Everyone is already settled up');
  end if;
  if p_expected_cents is distinct from v_amount then
    perform private.fail('balance_changed', '22023', format('The balance is now %s cents', v_amount));
  end if;

  v_note := private.check_entry_fields('payment', p_note, p_entry_date);
  perform private.check_total(v_amount);
  perform private.check_payer_person(v_device.group_id, v_debtor, p_paid_by_person_id, null);

  insert into public.entries (
    group_id, kind, description, entry_date, total_cents, paid_by_party_id, paid_by_person_id,
    settles, created_by_person_id)
  values (
    v_device.group_id, 'payment', v_note, p_entry_date, v_amount, v_debtor, p_paid_by_person_id,
    true, v_device.person_id)
  returning id into v_id;

  perform private.write_shares(v_device.group_id, v_id,
    jsonb_build_array(jsonb_build_object('party_id', v_creditor, 'share_cents', v_amount)));

  insert into public.entry_events (group_id, entry_id, action, by_person_id, after, note)
  values (v_device.group_id, v_id, 'create', v_device.person_id, private.entry_json(v_id), 'Settled the full balance');

  return private.entry_json(v_id);
end;
$$;

-- A settling payment cannot be edited (its amount is the balance it settled); it
-- can be deleted and restored, which reopens and closes its period.
create or replace function public.edit_entry(
  p_token text,
  p_id uuid,
  p_description text,
  p_entry_date date,
  p_total_cents integer,
  p_paid_by_party_id uuid,
  p_paid_by_person_id uuid default null,
  p_split_type text default null,
  p_split_num integer default null,
  p_split_den integer default null,
  p_split_inputs jsonb default null,
  p_to_party_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_entry public.entries;
  v_description text;
  v_split record;
  v_before jsonb;
  v_after jsonb;
begin
  select * into v_device from private.require_person(p_token);
  v_entry := private.lock_entry(v_device.group_id, p_id);
  if v_entry.deleted_at is not null then
    perform private.fail('entry_deleted', '22023', 'Restore the entry before editing it');
  end if;
  if v_entry.settles then
    perform private.fail('settlement_locked', '22023', 'Delete a settle-up instead of editing it');
  end if;

  v_description := private.check_entry_fields(v_entry.kind, p_description, p_entry_date);
  select * into v_split from private.compute_shares(
    v_device.group_id, v_entry.kind, p_total_cents, p_paid_by_party_id, p_to_party_id,
    p_split_type, p_split_num, p_split_den, p_split_inputs);
  perform private.check_payer_person(v_device.group_id, p_paid_by_party_id, p_paid_by_person_id,
                                     v_entry.paid_by_person_id);

  v_before := private.entry_json(p_id);

  update public.entries
  set description = v_description,
      entry_date = p_entry_date,
      total_cents = p_total_cents,
      paid_by_party_id = p_paid_by_party_id,
      paid_by_person_id = p_paid_by_person_id,
      split_type = v_split.split_type,
      split_num = v_split.split_num,
      split_den = v_split.split_den,
      split_inputs = v_split.split_inputs,
      updated_at = now()
  where id = p_id;

  perform private.write_shares(v_device.group_id, p_id, v_split.shares);
  v_after := private.entry_json(p_id);

  insert into public.entry_events (group_id, entry_id, action, by_person_id, before, after)
  values (v_device.group_id, p_id, 'edit', v_device.person_id, v_before, v_after);

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- Listing by period
-- ---------------------------------------------------------------------------

drop function public.list_entries(text, boolean, integer, text);

-- Same as before, plus optional period bounds on creation time:
-- p_created_after (exclusive) and p_created_until (inclusive).
create function public.list_entries(
  p_token text,
  p_deleted boolean default false,
  p_limit integer default 50,
  p_before text default null,
  p_created_after timestamptz default null,
  p_created_until timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_date date;
  v_created timestamptz;
  v_id uuid;
  v_ids uuid[];
  v_last public.entries;
begin
  select * into v_device from private.require_device(p_token);

  if p_limit is null or p_limit not between 1 and 200 then
    perform private.fail('invalid_limit');
  end if;
  if p_before is not null then
    if p_before !~ '^\d{4}-\d{2}-\d{2}\|[^|]+\|[0-9a-f-]{36}$' then
      perform private.fail('invalid_cursor');
    end if;
    v_date := split_part(p_before, '|', 1)::date;
    v_created := split_part(p_before, '|', 2)::timestamptz;
    v_id := split_part(p_before, '|', 3)::uuid;
  end if;

  select array_agg(x.id order by x.entry_date desc, x.created_at desc, x.id desc) into v_ids
  from (
    select e.id, e.entry_date, e.created_at
    from public.entries e
    where e.group_id = v_device.group_id
      and (e.deleted_at is not null) = coalesce(p_deleted, false)
      and (p_created_after is null or e.created_at > p_created_after)
      and (p_created_until is null or e.created_at <= p_created_until)
      and (p_before is null or (e.entry_date, e.created_at, e.id) < (v_date, v_created, v_id))
    order by e.entry_date desc, e.created_at desc, e.id desc
    limit p_limit + 1
  ) x;

  v_ids := coalesce(v_ids, '{}');
  if array_length(v_ids, 1) > p_limit then
    v_ids := v_ids[1:p_limit];
    select * into v_last from public.entries where id = v_ids[p_limit];
  end if;

  return jsonb_build_object(
    'entries', coalesce((select jsonb_agg(private.entry_json(u.id) order by u.n)
                         from unnest(v_ids) with ordinality as u(id, n)), '[]'::jsonb),
    'next_before', case when v_last.id is not null
                        then v_last.entry_date::text || '|' || v_last.created_at::text || '|' || v_last.id::text end
  );
end;
$$;

-- Every period of the group: the open one, then settled ones newest first. Each has
-- its creation-time bounds (to pass to list_entries), entry count and date range.
create function public.list_periods(p_token text) returns jsonb
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
          'settlement', private.entry_json(s.id),
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
        select e.id, e.created_at, lag(e.created_at) over (order by e.created_at) as previous
        from public.entries e
        where e.group_id = v_device.group_id and e.settles and e.deleted_at is null
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- Summary now includes when the group last settled up.
create or replace function public.get_summary(p_token text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_device(p_token);

  return jsonb_build_object(
    'group', (select jsonb_build_object('id', g.id, 'name', g.name, 'mode', g.mode)
              from public.groups g where g.id = v_device.group_id),
    'parties', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', p.id, 'name', p.name, 'kind', p.kind, 'sort_order', p.sort_order,
                  'archived', p.archived_at is not null) order by p.sort_order, p.id)
                from public.parties p where p.group_id = v_device.group_id), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', pe.id, 'name', pe.name, 'party_id', pe.party_id, 'sort_order', pe.sort_order,
                  'archived', pe.archived_at is not null, 'is_admin', pe.is_admin,
                  'has_pin', exists (select 1 from private.person_secrets s where s.person_id = pe.id))
                  order by pe.sort_order, pe.id)
                from public.people pe where pe.group_id = v_device.group_id), '[]'::jsonb),
    'nets', coalesce((select jsonb_agg(jsonb_build_object('party_id', n.party_id, 'net_cents', n.net_cents))
                from private.party_nets(v_device.group_id) n), '[]'::jsonb),
    'last_settled_at', private.last_settled_at(v_device.group_id),
    'me', jsonb_build_object('device_id', v_device.device_id, 'person_id', v_device.person_id,
                             'party_id', v_device.party_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.settle_up(text, integer, date, text, uuid) from public, authenticated;
revoke all on function public.list_entries(text, boolean, integer, text, timestamptz, timestamptz) from public, authenticated;
revoke all on function public.list_periods(text) from public, authenticated;

grant execute on function public.settle_up(text, integer, date, text, uuid) to anon;
grant execute on function public.list_entries(text, boolean, integer, text, timestamptz, timestamptz) to anon;
grant execute on function public.list_periods(text) to anon;
