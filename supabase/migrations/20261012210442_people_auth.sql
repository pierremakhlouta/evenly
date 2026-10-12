-- Personal PINs and admins.
--
-- * Every person has their own PIN (4 to 12 digits, bcrypt). A phone must enter it
--   to pick or switch to that person, so nobody can use the app as someone else.
--   The first phone to pick a person without a PIN creates it.
-- * The first person in a group becomes admin. Admins manage people (add, rename,
--   move, archive, reset a personal PIN, make admin) and rename the group and
--   households. The last admin can never be removed or archived.
-- * Only the first person of an empty group can add themselves; everyone else is
--   added by an admin.
-- * Wrong personal PINs are locked out per person: 10 failures in 15 minutes.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.people add column is_admin boolean not null default false;

create table private.person_secrets (
  person_id uuid primary key references public.people (id),
  pin_hash text not null
);

-- Null person_id: a group PIN attempt (register_device). Otherwise a personal PIN attempt.
alter table private.pin_attempts add column person_id uuid references public.people (id);
create index pin_attempts_person_idx on private.pin_attempts (person_id, at);

revoke all on all tables in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Like require_person, but the person must be an admin.
create function private.require_admin(
  p_token text,
  out device_id uuid,
  out group_id uuid,
  out person_id uuid,
  out party_id uuid
)
language plpgsql
set search_path = ''
as $$
begin
  select d.device_id, d.group_id, d.person_id, d.party_id
  into device_id, group_id, person_id, party_id
  from private.require_person(p_token) d;

  if not exists (select 1 from public.people p where p.id = person_id and p.is_admin) then
    perform private.fail('admin_only', '42501', 'Only an admin can do this');
  end if;
end;
$$;

-- Raises last_admin if p_person_id is the only active admin of its group.
create function private.check_not_last_admin(p_person_id uuid) returns void
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.people p where p.id = p_person_id and p.is_admin and p.archived_at is null)
     and not exists (
       select 1 from public.people other
       join public.people me on me.id = p_person_id
       where other.group_id = me.group_id and other.id <> me.id and other.is_admin and other.archived_at is null
     ) then
    perform private.fail('last_admin', '22023', 'A group needs at least one admin');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Joining: the group PIN lockout now only counts group PIN attempts
-- ---------------------------------------------------------------------------

create or replace function public.register_device(p_group_code text, p_pin text, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_id uuid;
  v_hash text;
  v_ok boolean;
  v_token bytea;
begin
  delete from private.pin_attempts where at < now() - interval '1 day';

  if (select count(*) from private.pin_attempts
      where person_id is null and not ok and at > now() - interval '15 minutes') >= 10 then
    perform private.fail('locked_out', '28000', 'Too many wrong attempts. Try again in 15 minutes.');
  end if;

  select gs.group_id, gs.pin_hash into v_group_id, v_hash
  from private.group_secrets gs
  where gs.code = private.normalize_code(p_group_code);

  if v_hash is null then
    perform extensions.crypt(coalesce(p_pin, ''), extensions.gen_salt('bf', 10));
    v_ok := false;
  else
    v_ok := p_pin is not null and extensions.crypt(p_pin, v_hash) = v_hash;
  end if;

  insert into private.pin_attempts (ok) values (v_ok);

  if not v_ok then
    return jsonb_build_object('error', 'invalid_credentials');
  end if;

  v_token := extensions.gen_random_bytes(32);
  insert into private.devices (group_id, token_hash, label)
  values (v_group_id, extensions.digest(v_token, 'sha256'), nullif(left(btrim(p_label), 60), ''));

  return jsonb_build_object('token', encode(v_token, 'hex'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Picking a person now needs their personal PIN
-- ---------------------------------------------------------------------------

drop function public.set_device_person(text, uuid);

-- Sets this phone's person. If the person has a PIN, p_pin must match it; if not,
-- p_pin becomes their new PIN. Returns {"ok": true} or {"error": "invalid_pin"}
-- (returned, not raised, so the failed attempt is kept for the lockout).
create function public.set_device_person(p_token text, p_person_id uuid, p_pin text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_hash text;
  v_ok boolean;
begin
  select * into v_device from private.require_device(p_token);

  if not exists (
    select 1 from public.people p
    where p.id = p_person_id and p.group_id = v_device.group_id and p.archived_at is null
  ) then
    perform private.fail('invalid_person');
  end if;

  if (select count(*) from private.pin_attempts
      where person_id = p_person_id and not ok and at > now() - interval '15 minutes') >= 10 then
    perform private.fail('locked_out', '28000', 'Too many wrong attempts. Try again in 15 minutes.');
  end if;

  select s.pin_hash into v_hash from private.person_secrets s where s.person_id = p_person_id;

  if v_hash is null then
    perform private.check_pin_format(p_pin);
    insert into private.person_secrets (person_id, pin_hash)
    values (p_person_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)));
  else
    v_ok := p_pin is not null and extensions.crypt(p_pin, v_hash) = v_hash;
    insert into private.pin_attempts (ok, person_id) values (v_ok, p_person_id);
    if not v_ok then
      return jsonb_build_object('error', 'invalid_pin');
    end if;
  end if;

  update private.devices set person_id = p_person_id where id = v_device.device_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- add_self: only the first person of an empty group, who becomes admin
-- ---------------------------------------------------------------------------

drop function public.add_self(text, text, uuid);

create function public.add_self(p_token text, p_name text, p_party_id uuid, p_pin text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_mode text;
  v_name text := private.check_name(p_name);
  v_party_id uuid;
  v_person_id uuid;
begin
  select * into v_device from private.require_device(p_token);
  perform private.check_pin_format(p_pin);

  -- Serialise concurrent first joins for this group.
  perform 1 from public.groups g where g.id = v_device.group_id for update;
  if exists (select 1 from public.people p where p.group_id = v_device.group_id and p.archived_at is null) then
    perform private.fail('join_closed', '42501', 'Ask an admin to add you');
  end if;

  select g.mode into v_mode from public.groups g where g.id = v_device.group_id;

  if v_mode = 'households' then
    select p.id into v_party_id
    from public.parties p
    where p.id = p_party_id and p.group_id = v_device.group_id
      and p.kind = 'household' and p.archived_at is null;
    if v_party_id is null then
      perform private.fail('invalid_party');
    end if;
  else
    if p_party_id is not null then
      perform private.fail('invalid_party');
    end if;
    insert into public.parties (group_id, name, kind, sort_order)
    values (v_device.group_id, v_name, 'person',
            (select coalesce(max(sort_order), 0) + 1 from public.parties where group_id = v_device.group_id))
    returning id into v_party_id;
  end if;

  insert into public.people (group_id, name, party_id, sort_order, is_admin)
  values (v_device.group_id, v_name, v_party_id,
          (select coalesce(max(sort_order), 0) + 1 from public.people where group_id = v_device.group_id),
          true)
  returning id into v_person_id;

  insert into private.person_secrets (person_id, pin_hash)
  values (v_person_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)));

  update private.devices set person_id = v_person_id where id = v_device.device_id;
  return v_person_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Summary: people now show whether they are admin and whether they have a PIN
-- ---------------------------------------------------------------------------

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
    'me', jsonb_build_object('device_id', v_device.device_id, 'person_id', v_device.person_id,
                             'party_id', v_device.party_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin-only: group, households and people
-- ---------------------------------------------------------------------------

create or replace function public.update_group(p_token text, p_name text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_admin(p_token);
  update public.groups set name = private.check_name(p_name) where id = v_device.group_id;
end;
$$;

create or replace function public.upsert_party(p_token text, p_id uuid, p_name text, p_sort_order integer default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_admin(p_token);
  update public.parties p
  set name = private.check_name(p_name),
      sort_order = coalesce(private.check_sort_order(p_sort_order), p.sort_order)
  where p.id = p_id and p.group_id = v_device.group_id;
  if not found then
    perform private.fail('invalid_party');
  end if;
end;
$$;

create or replace function public.upsert_person(
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
  select * into v_device from private.require_admin(p_token);
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

create or replace function public.archive_person(p_token text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_mode text;
  v_party_id uuid;
begin
  select * into v_device from private.require_admin(p_token);
  if p_id = v_device.person_id then
    perform private.fail('cannot_archive_self', '22023', 'Switch this phone to someone else first');
  end if;
  perform private.check_not_last_admin(p_id);

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

-- Makes a person admin or removes admin. The last admin cannot be removed.
create function public.set_person_admin(p_token text, p_person_id uuid, p_is_admin boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_admin(p_token);
  if not exists (
    select 1 from public.people p
    where p.id = p_person_id and p.group_id = v_device.group_id and p.archived_at is null
  ) then
    perform private.fail('not_found');
  end if;
  if not coalesce(p_is_admin, false) then
    perform private.check_not_last_admin(p_person_id);
  end if;
  update public.people set is_admin = coalesce(p_is_admin, false) where id = p_person_id;
end;
$$;

-- Clears a person's PIN (they create a new one on their next pick) and signs every
-- phone using that person out of it, so those phones must pick again.
create function public.reset_person_pin(p_token text, p_person_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_admin(p_token);
  if not exists (select 1 from public.people p where p.id = p_person_id and p.group_id = v_device.group_id) then
    perform private.fail('not_found');
  end if;
  delete from private.person_secrets where person_id = p_person_id;
  update private.devices set person_id = null where person_id = p_person_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.set_device_person(text, uuid, text) from public, authenticated;
revoke all on function public.add_self(text, text, uuid, text) from public, authenticated;
revoke all on function public.set_person_admin(text, uuid, boolean) from public, authenticated;
revoke all on function public.reset_person_pin(text, uuid) from public, authenticated;

grant execute on function public.set_device_person(text, uuid, text) to anon;
grant execute on function public.add_self(text, text, uuid, text) to anon;
grant execute on function public.set_person_admin(text, uuid, boolean) to anon;
grant execute on function public.reset_person_pin(text, uuid) to anon;
