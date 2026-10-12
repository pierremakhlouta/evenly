-- Entry RPCs: summary with balances, list, get, add, edit, delete, restore.
--
-- The database computes share rows from the split rule (private.split_household and
-- private.split_people), so stored shares never depend on the front end's math.
-- Every change is written to entry_events with a before/after snapshot.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The shares-add-up check is a deferred trigger, so it runs at commit time as the
-- calling role (anon), outside the RPC's security definer context. It must run as
-- its owner to read the tables.
alter function private.check_entry_shares() security definer;

create function private.today() returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'America/Toronto')::date;
$$;

-- Full JSON snapshot of an entry with its shares (used by the API and the change log).
create function private.entry_json(p_entry_id uuid) returns jsonb
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

-- Net position of every party in a group from its active entries:
-- (total of entries the party paid) - (total of its shares). Nets sum to 0.
create function private.party_nets(p_group_id uuid)
returns table (party_id uuid, net_cents bigint)
language sql
stable
set search_path = ''
as $$
  select p.id,
         coalesce((select sum(e.total_cents) from public.entries e
                   where e.paid_by_party_id = p.id and e.deleted_at is null), 0)
       - coalesce((select sum(s.share_cents) from public.entry_shares s
                   join public.entries e on e.id = s.entry_id
                   where s.party_id = p.id and e.deleted_at is null), 0)
  from public.parties p
  where p.group_id = p_group_id
  order by p.sort_order, p.id;
$$;

-- Checks a party belongs to the group and is not archived.
create function private.check_party(p_group_id uuid, p_party_id uuid) returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_party_id is null or not exists (
    select 1 from public.parties p
    where p.id = p_party_id and p.group_id = p_group_id and p.archived_at is null
  ) then
    perform private.fail('invalid_party');
  end if;
end;
$$;

-- The other active household in a household-mode group.
create function private.other_household(p_group_id uuid, p_party_id uuid) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(p.id) into v_ids
  from public.parties p
  where p.group_id = p_group_id and p.kind = 'household' and p.archived_at is null and p.id <> p_party_id;
  if coalesce(array_length(v_ids, 1), 0) <> 1 then
    perform private.fail('invalid_party', '22023', 'A household group needs exactly two households');
  end if;
  return v_ids[1];
end;
$$;

-- Validated, normalised entry fields. Returns the trimmed description.
create function private.check_entry_fields(p_kind text, p_description text, p_entry_date date)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_description text := btrim(coalesce(p_description, ''));
begin
  if p_kind is null or p_kind not in ('expense', 'payment') then
    perform private.fail('invalid_kind');
  end if;
  if length(v_description) > 200 or (p_kind = 'expense' and v_description = '') then
    perform private.fail('invalid_description', '22023', 'Description is required for expenses (max 200 characters)');
  end if;
  if p_entry_date is null or p_entry_date < date '2000-01-01' or p_entry_date > private.today() + 366 then
    perform private.fail('invalid_date');
  end if;
  return v_description;
end;
$$;

-- Who in the paying party actually paid (optional). Must be in that party; an archived
-- person is only accepted if they were already on the entry being edited.
create function private.check_payer_person(
  p_group_id uuid,
  p_party_id uuid,
  p_person_id uuid,
  p_existing_person_id uuid
) returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_person_id is not null and not exists (
    select 1 from public.people pe
    where pe.id = p_person_id and pe.group_id = p_group_id and pe.party_id = p_party_id
      and (pe.archived_at is null or pe.id = p_existing_person_id)
  ) then
    perform private.fail('invalid_person');
  end if;
end;
$$;

-- Computes the share rows for an entry and the split columns to store with it.
-- Household mode: shares for the payer and the other household.
-- People mode: p_split_inputs is [{"party_id": uuid, "value": int?}, ...].
-- Payments: one share row for the receiving party equal to the total.
create function private.compute_shares(
  p_group_id uuid,
  p_kind text,
  p_total_cents integer,
  p_paid_by_party_id uuid,
  p_to_party_id uuid,
  p_split_type text,
  p_split_num integer,
  p_split_den integer,
  p_split_inputs jsonb,
  out shares jsonb,
  out split_type text,
  out split_num integer,
  out split_den integer,
  out split_inputs jsonb
)
language plpgsql
set search_path = ''
as $$
declare
  v_mode text;
  v_other uuid;
  v_to uuid;
  v_parties jsonb;
begin
  perform private.check_total(p_total_cents);
  perform private.check_party(p_group_id, p_paid_by_party_id);
  select g.mode into v_mode from public.groups g where g.id = p_group_id;

  if p_kind = 'payment' then
    v_to := coalesce(p_to_party_id,
                     case when v_mode = 'households' then private.other_household(p_group_id, p_paid_by_party_id) end);
    perform private.check_party(p_group_id, v_to);
    if v_to = p_paid_by_party_id then
      perform private.fail('invalid_party', '22023', 'A payment must go to another party');
    end if;
    shares := jsonb_build_array(jsonb_build_object('party_id', v_to, 'share_cents', p_total_cents));
    return;
  end if;

  if v_mode = 'households' then
    if p_split_type not in ('third', 'half', 'all', 'fraction', 'percent', 'amount') or p_split_type is null then
      perform private.fail('invalid_split_type');
    end if;
    v_other := private.other_household(p_group_id, p_paid_by_party_id);
    select jsonb_build_array(
             jsonb_build_object('party_id', p_paid_by_party_id, 'share_cents', h.payer_cents),
             jsonb_build_object('party_id', v_other, 'share_cents', h.other_cents))
    into shares
    from private.split_household(p_total_cents, p_split_type, p_split_num, p_split_den) h;

    split_type := p_split_type;
    split_num := case when p_split_type in ('fraction', 'percent', 'amount') then p_split_num end;
    split_den := case when p_split_type = 'fraction' then p_split_den end;
    return;
  end if;

  -- People mode
  if p_split_type not in ('equal', 'amounts', 'percent', 'weights') or p_split_type is null then
    perform private.fail('invalid_split_type');
  end if;
  if p_split_inputs is null or jsonb_typeof(p_split_inputs) <> 'array' or jsonb_array_length(p_split_inputs) = 0
     or exists (
       select 1 from jsonb_array_elements(p_split_inputs) i
       where jsonb_typeof(i) <> 'object'
          or jsonb_typeof(i -> 'party_id') is distinct from 'string'
          or (i ->> 'party_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or not exists (
            select 1 from public.parties p
            where p.id = (i ->> 'party_id')::uuid and p.group_id = p_group_id and p.archived_at is null)
     ) then
    perform private.fail('invalid_parties');
  end if;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', i ->> 'party_id', 'sort_order', p.sort_order, 'value', i -> 'value')))
  into v_parties
  from jsonb_array_elements(p_split_inputs) i
  join public.parties p on p.id = (i ->> 'party_id')::uuid;

  select jsonb_agg(jsonb_build_object('party_id', s.party_id::uuid, 'share_cents', s.share_cents))
  into shares
  from private.split_people(p_total_cents, p_split_type, v_parties) s;

  split_type := p_split_type;
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('party_id', i ->> 'party_id', 'value', i -> 'value')))
  into split_inputs
  from jsonb_array_elements(p_split_inputs) i;
end;
$$;

create function private.write_shares(p_group_id uuid, p_entry_id uuid, p_shares jsonb) returns void
language sql
set search_path = ''
as $$
  delete from public.entry_shares where entry_id = p_entry_id;
  insert into public.entry_shares (group_id, entry_id, party_id, share_cents)
  select p_group_id, p_entry_id, (s ->> 'party_id')::uuid, (s ->> 'share_cents')::integer
  from jsonb_array_elements(p_shares) s;
$$;

-- Loads an entry of the caller's group for update, or raises not_found.
create function private.lock_entry(p_group_id uuid, p_entry_id uuid) returns public.entries
language plpgsql
set search_path = ''
as $$
declare
  v_entry public.entries;
begin
  select * into v_entry from public.entries e
  where e.id = p_entry_id and e.group_id = p_group_id
  for update;
  if v_entry.id is null then
    perform private.fail('not_found');
  end if;
  return v_entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

-- Everything the home screen needs: group, parties, people (including archived, for
-- history), each party's net, and this device's person and party. Works before the
-- device has picked a person, so the join screen can list people.
create function public.get_summary(p_token text) returns jsonb
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
                  'archived', pe.archived_at is not null) order by pe.sort_order, pe.id)
                from public.people pe where pe.group_id = v_device.group_id), '[]'::jsonb),
    'nets', coalesce((select jsonb_agg(jsonb_build_object('party_id', n.party_id, 'net_cents', n.net_cents))
                from private.party_nets(v_device.group_id) n), '[]'::jsonb),
    'me', jsonb_build_object('device_id', v_device.device_id, 'person_id', v_device.person_id,
                             'party_id', v_device.party_id)
  );
end;
$$;

-- A page of entries, newest first (by entry date, then creation time).
-- p_deleted = false lists active entries, true lists deleted ones (the Deleted screen).
-- p_before is the next_before cursor from the previous page.
create function public.list_entries(
  p_token text,
  p_deleted boolean default false,
  p_limit integer default 50,
  p_before text default null
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

-- One entry with its shares and change log.
create function public.get_entry(p_token text, p_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_device(p_token);
  if not exists (select 1 from public.entries e where e.id = p_id and e.group_id = v_device.group_id) then
    perform private.fail('not_found');
  end if;

  return private.entry_json(p_id) || jsonb_build_object(
    'events', coalesce((select jsonb_agg(jsonb_build_object(
                 'action', ev.action, 'by_person_id', ev.by_person_id, 'at', ev.at,
                 'before', ev.before, 'after', ev.after, 'note', ev.note) order by ev.at, ev.id)
               from public.entry_events ev where ev.entry_id = p_id), '[]'::jsonb));
end;
$$;

create function public.add_entry(
  p_token text,
  p_kind text,
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
  v_description text;
  v_split record;
  v_id uuid;
begin
  select * into v_device from private.require_person(p_token);
  v_description := private.check_entry_fields(p_kind, p_description, p_entry_date);
  select * into v_split from private.compute_shares(
    v_device.group_id, p_kind, p_total_cents, p_paid_by_party_id, p_to_party_id,
    p_split_type, p_split_num, p_split_den, p_split_inputs);
  perform private.check_payer_person(v_device.group_id, p_paid_by_party_id, p_paid_by_person_id, null);

  insert into public.entries (
    group_id, kind, description, entry_date, total_cents, paid_by_party_id, paid_by_person_id,
    split_type, split_num, split_den, split_inputs, created_by_person_id)
  values (
    v_device.group_id, p_kind, v_description, p_entry_date, p_total_cents, p_paid_by_party_id,
    p_paid_by_person_id, v_split.split_type, v_split.split_num, v_split.split_den, v_split.split_inputs,
    v_device.person_id)
  returning id into v_id;

  perform private.write_shares(v_device.group_id, v_id, v_split.shares);

  insert into public.entry_events (group_id, entry_id, action, by_person_id, after)
  values (v_device.group_id, v_id, 'create', v_device.person_id, private.entry_json(v_id));

  return private.entry_json(v_id);
end;
$$;

-- Edits an active entry. The kind cannot change. Shares are recomputed.
create function public.edit_entry(
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

-- Soft delete: the entry leaves the balance and history but can be restored.
create function public.delete_entry(p_token text, p_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_entry public.entries;
  v_before jsonb;
begin
  select * into v_device from private.require_person(p_token);
  v_entry := private.lock_entry(v_device.group_id, p_id);
  if v_entry.deleted_at is not null then
    perform private.fail('entry_deleted');
  end if;

  v_before := private.entry_json(p_id);
  update public.entries
  set deleted_at = now(), deleted_by_person_id = v_device.person_id, updated_at = now()
  where id = p_id;

  insert into public.entry_events (group_id, entry_id, action, by_person_id, before, after)
  values (v_device.group_id, p_id, 'delete', v_device.person_id, v_before, private.entry_json(p_id));

  return private.entry_json(p_id);
end;
$$;

create function public.restore_entry(p_token text, p_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_entry public.entries;
  v_before jsonb;
begin
  select * into v_device from private.require_person(p_token);
  v_entry := private.lock_entry(v_device.group_id, p_id);
  if v_entry.deleted_at is null then
    perform private.fail('entry_not_deleted');
  end if;

  v_before := private.entry_json(p_id);
  update public.entries
  set deleted_at = null, deleted_by_person_id = null, updated_at = now()
  where id = p_id;

  insert into public.entry_events (group_id, entry_id, action, by_person_id, before, after)
  values (v_device.group_id, p_id, 'restore', v_device.person_id, v_before, private.entry_json(p_id));

  return private.entry_json(p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.get_summary(text) from public, authenticated;
revoke all on function public.list_entries(text, boolean, integer, text) from public, authenticated;
revoke all on function public.get_entry(text, uuid) from public, authenticated;
revoke all on function public.add_entry(text, text, text, date, integer, uuid, uuid, text, integer, integer, jsonb, uuid) from public, authenticated;
revoke all on function public.edit_entry(text, uuid, text, date, integer, uuid, uuid, text, integer, integer, jsonb, uuid) from public, authenticated;
revoke all on function public.delete_entry(text, uuid) from public, authenticated;
revoke all on function public.restore_entry(text, uuid) from public, authenticated;

grant execute on function public.get_summary(text) to anon;
grant execute on function public.list_entries(text, boolean, integer, text) to anon;
grant execute on function public.get_entry(text, uuid) to anon;
grant execute on function public.add_entry(text, text, text, date, integer, uuid, uuid, text, integer, integer, jsonb, uuid) to anon;
grant execute on function public.edit_entry(text, uuid, text, date, integer, uuid, uuid, text, integer, integer, jsonb, uuid) to anon;
grant execute on function public.delete_entry(text, uuid) to anon;
grant execute on function public.restore_entry(text, uuid) to anon;
