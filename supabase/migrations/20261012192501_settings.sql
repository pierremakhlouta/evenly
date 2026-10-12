-- Settings RPCs: recurring bills, group name, households, people, devices, CSV export.
-- Every write requires a phone that has picked a person; reads need any valid device.

-- ---------------------------------------------------------------------------
-- Fix: a person moved to the other household keeps being accepted as "who paid"
-- on entries they were already on, so those entries can still be edited.
-- ---------------------------------------------------------------------------

create or replace function private.check_payer_person(
  p_group_id uuid,
  p_party_id uuid,
  p_person_id uuid,
  p_existing_person_id uuid
) returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_person_id is null or p_person_id = p_existing_person_id then
    return;
  end if;
  if not exists (
    select 1 from public.people pe
    where pe.id = p_person_id and pe.group_id = p_group_id and pe.party_id = p_party_id
      and pe.archived_at is null
  ) then
    perform private.fail('invalid_person');
  end if;
end;
$$;

create function private.check_sort_order(p_sort_order integer) returns integer
language plpgsql
set search_path = ''
as $$
begin
  if p_sort_order is not null and p_sort_order not between 0 and 100000 then
    perform private.fail('invalid_sort_order');
  end if;
  return p_sort_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recurring bills
-- ---------------------------------------------------------------------------

create function private.bill_json(p_bill public.recurring_bills) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_bill.id,
    'name', p_bill.name,
    'paid_by_party_id', p_bill.paid_by_party_id,
    'split_type', p_bill.split_type,
    'split_num', p_bill.split_num,
    'split_den', p_bill.split_den,
    'split_inputs', p_bill.split_inputs,
    'default_total_cents', p_bill.default_total_cents,
    'auto_add', p_bill.auto_add,
    'day_of_month', p_bill.day_of_month,
    'active', p_bill.active,
    'sort_order', p_bill.sort_order
  );
$$;

-- All bills of the group, active first, in sort order.
create function public.list_recurring_bills(p_token text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_device(p_token);
  return coalesce((
    select jsonb_agg(private.bill_json(b) order by not b.active, b.sort_order, b.name, b.id)
    from public.recurring_bills b
    where b.group_id = v_device.group_id
  ), '[]'::jsonb);
end;
$$;

-- Creates (p_id null) or updates a bill. The split rule is validated with the same
-- code as entries, against the default amount, or the largest allowed total when
-- the amount is typed in each month.
create function public.upsert_recurring_bill(
  p_token text,
  p_id uuid,
  p_name text,
  p_paid_by_party_id uuid,
  p_split_type text,
  p_split_num integer default null,
  p_split_den integer default null,
  p_split_inputs jsonb default null,
  p_default_total_cents integer default null,
  p_auto_add boolean default false,
  p_day_of_month integer default 1,
  p_sort_order integer default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_name text := private.check_name(p_name);
  v_split record;
  v_bill public.recurring_bills;
begin
  select * into v_device from private.require_person(p_token);

  if p_default_total_cents is not null then
    perform private.check_total(p_default_total_cents);
  end if;
  if coalesce(p_auto_add, false) and p_default_total_cents is null then
    perform private.fail('invalid_bill', '22023', 'An automatic bill needs a default amount');
  end if;
  if p_day_of_month is null or p_day_of_month not between 1 and 28 then
    perform private.fail('invalid_day', '22023', 'Day of month must be 1 to 28');
  end if;

  select * into v_split from private.compute_shares(
    v_device.group_id, 'expense', coalesce(p_default_total_cents, 100000000), p_paid_by_party_id, null,
    p_split_type, p_split_num, p_split_den, p_split_inputs);

  if p_id is null then
    insert into public.recurring_bills (
      group_id, name, paid_by_party_id, split_type, split_num, split_den, split_inputs,
      default_total_cents, auto_add, day_of_month, sort_order)
    values (
      v_device.group_id, v_name, p_paid_by_party_id, v_split.split_type, v_split.split_num, v_split.split_den,
      v_split.split_inputs, p_default_total_cents, coalesce(p_auto_add, false), p_day_of_month,
      coalesce(private.check_sort_order(p_sort_order),
               (select coalesce(max(sort_order), 0) + 1 from public.recurring_bills where group_id = v_device.group_id)))
    returning * into v_bill;
  else
    update public.recurring_bills b
    set name = v_name,
        paid_by_party_id = p_paid_by_party_id,
        split_type = v_split.split_type,
        split_num = v_split.split_num,
        split_den = v_split.split_den,
        split_inputs = v_split.split_inputs,
        default_total_cents = p_default_total_cents,
        auto_add = coalesce(p_auto_add, false),
        day_of_month = p_day_of_month,
        sort_order = coalesce(private.check_sort_order(p_sort_order), b.sort_order),
        active = true,
        updated_at = now()
    where b.id = p_id and b.group_id = v_device.group_id
    returning * into v_bill;
    if v_bill.id is null then
      perform private.fail('not_found');
    end if;
  end if;

  return private.bill_json(v_bill);
end;
$$;

-- Hides a bill from Home and stops auto-adding it. Past entries are untouched.
create function public.archive_recurring_bill(p_token text, p_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_bill public.recurring_bills;
begin
  select * into v_device from private.require_person(p_token);
  update public.recurring_bills b
  set active = false, updated_at = now()
  where b.id = p_id and b.group_id = v_device.group_id
  returning * into v_bill;
  if v_bill.id is null then
    perform private.fail('not_found');
  end if;
  return private.bill_json(v_bill);
end;
$$;

-- ---------------------------------------------------------------------------
-- Group, households and people
-- ---------------------------------------------------------------------------

create function public.update_group(p_token text, p_name text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_person(p_token);
  update public.groups set name = private.check_name(p_name) where id = v_device.group_id;
end;
$$;

-- Renames or reorders an existing party. Households cannot be added or removed
-- (household mode always has exactly two); people-mode parties come and go with
-- their person (upsert_person, archive_person).
create function public.upsert_party(p_token text, p_id uuid, p_name text, p_sort_order integer default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_person(p_token);
  update public.parties p
  set name = private.check_name(p_name),
      sort_order = coalesce(private.check_sort_order(p_sort_order), p.sort_order)
  where p.id = p_id and p.group_id = v_device.group_id;
  if not found then
    perform private.fail('invalid_party');
  end if;
end;
$$;

-- Creates (p_id null) or updates a person.
-- Household mode: p_party_id is their household (moving households is allowed).
-- People mode: p_party_id must be null; the person's own party is created or renamed with them.
create function public.upsert_person(
  p_token text,
  p_id uuid,
  p_name text,
  p_party_id uuid default null,
  p_sort_order integer default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_mode text;
  v_name text := private.check_name(p_name);
  v_party_id uuid;
  v_person public.people;
begin
  select * into v_device from private.require_person(p_token);
  select g.mode into v_mode from public.groups g where g.id = v_device.group_id;
  perform private.check_sort_order(p_sort_order);

  if p_id is not null then
    select * into v_person from public.people pe where pe.id = p_id and pe.group_id = v_device.group_id;
    if v_person.id is null then
      perform private.fail('not_found');
    end if;
  end if;

  if v_mode = 'households' then
    select p.id into v_party_id from public.parties p
    where p.id = p_party_id and p.group_id = v_device.group_id and p.kind = 'household' and p.archived_at is null;
    if v_party_id is null then
      perform private.fail('invalid_party');
    end if;
  elsif p_party_id is not null and p_party_id is distinct from v_person.party_id then
    perform private.fail('invalid_party');
  elsif p_id is null then
    insert into public.parties (group_id, name, kind, sort_order)
    values (v_device.group_id, v_name, 'person',
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from public.parties where group_id = v_device.group_id)))
    returning id into v_party_id;
  else
    v_party_id := v_person.party_id;
    update public.parties p
    set name = v_name, sort_order = coalesce(p_sort_order, p.sort_order)
    where p.id = v_party_id;
  end if;

  if p_id is null then
    insert into public.people (group_id, name, party_id, sort_order)
    values (v_device.group_id, v_name, v_party_id,
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from public.people where group_id = v_device.group_id)))
    returning id into p_id;
  else
    update public.people pe
    set name = v_name, party_id = v_party_id, sort_order = coalesce(p_sort_order, pe.sort_order)
    where pe.id = p_id;
  end if;

  return p_id;
end;
$$;

-- Archives a person (and their party in people mode). They stay in history but
-- cannot be picked for new entries. A phone cannot archive its own person.
create function public.archive_person(p_token text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_mode text;
  v_party_id uuid;
begin
  select * into v_device from private.require_person(p_token);
  if p_id = v_device.person_id then
    perform private.fail('cannot_archive_self', '22023', 'Switch this phone to someone else first');
  end if;

  update public.people pe
  set archived_at = coalesce(pe.archived_at, now())
  where pe.id = p_id and pe.group_id = v_device.group_id
  returning pe.party_id into v_party_id;
  if v_party_id is null then
    perform private.fail('not_found');
  end if;

  select g.mode into v_mode from public.groups g where g.id = v_device.group_id;
  if v_mode = 'people' then
    update public.parties set archived_at = coalesce(archived_at, now()) where id = v_party_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

create function public.list_devices(p_token text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_device(p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'label', d.label, 'person_id', d.person_id, 'created_at', d.created_at,
      'last_seen_at', d.last_seen_at, 'revoked', d.revoked_at is not null, 'is_me', d.id = v_device.device_id)
      order by d.revoked_at is not null, d.last_seen_at desc)
    from private.devices d
    where d.group_id = v_device.group_id
  ), '[]'::jsonb);
end;
$$;

-- Revokes a phone in the same group. It must join again with the code and PIN.
create function public.revoke_device(p_token text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_person(p_token);
  update private.devices d
  set revoked_at = coalesce(d.revoked_at, now())
  where d.id = p_id and d.group_id = v_device.group_id;
  if not found then
    perform private.fail('not_found');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Export (the backup): every entry, including deleted ones, with shares.
-- Names come from get_summary.
-- ---------------------------------------------------------------------------

create function public.export_entries(p_token text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_device(p_token);
  return coalesce((
    select jsonb_agg(private.entry_json(e.id) order by e.entry_date, e.created_at, e.id)
    from public.entries e
    where e.group_id = v_device.group_id
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.list_recurring_bills(text) from public, authenticated;
revoke all on function public.upsert_recurring_bill(text, uuid, text, uuid, text, integer, integer, jsonb, integer, boolean, integer, integer) from public, authenticated;
revoke all on function public.archive_recurring_bill(text, uuid) from public, authenticated;
revoke all on function public.update_group(text, text) from public, authenticated;
revoke all on function public.upsert_party(text, uuid, text, integer) from public, authenticated;
revoke all on function public.upsert_person(text, uuid, text, uuid, integer) from public, authenticated;
revoke all on function public.archive_person(text, uuid) from public, authenticated;
revoke all on function public.list_devices(text) from public, authenticated;
revoke all on function public.revoke_device(text, uuid) from public, authenticated;
revoke all on function public.export_entries(text) from public, authenticated;

grant execute on function public.list_recurring_bills(text) to anon;
grant execute on function public.upsert_recurring_bill(text, uuid, text, uuid, text, integer, integer, jsonb, integer, boolean, integer, integer) to anon;
grant execute on function public.archive_recurring_bill(text, uuid) to anon;
grant execute on function public.update_group(text, text) to anon;
grant execute on function public.upsert_party(text, uuid, text, integer) to anon;
grant execute on function public.upsert_person(text, uuid, text, uuid, integer) to anon;
grant execute on function public.archive_person(text, uuid) to anon;
grant execute on function public.list_devices(text) to anon;
grant execute on function public.revoke_device(text, uuid) to anon;
grant execute on function public.export_entries(text) to anon;
