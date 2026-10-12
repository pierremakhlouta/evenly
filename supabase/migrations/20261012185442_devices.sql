-- Groups, PINs and devices.
--
-- Groups are created by the owner in the SQL editor with private.create_group, which
-- returns the group code. A phone joins with register_device(code, PIN) and gets a
-- random token; only its sha256 hash is stored. Every other RPC takes that token and
-- calls private.require_device, which returns the caller's group and person.
--
-- Error conventions: device and lockout problems use SQLSTATE 28000, bad input uses
-- 22023. The message is always a short code, for example 'invalid_device'.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function private.fail(p_code text, p_sqlstate text default '22023', p_detail text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%', p_code using errcode = p_sqlstate, detail = coalesce(p_detail, p_code);
end;
$$;

-- 'k7mq-2xpa ' -> 'K7MQ2XPA'
create function private.normalize_code(p_code text) returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- 'K7MQ2XPA' -> 'K7MQ-2XPA'
create function private.format_code(p_code text) returns text
language sql
immutable
set search_path = ''
as $$
  select substr(p_code, 1, 4) || '-' || substr(p_code, 5, 4);
$$;

-- A new random 8-character group code with no lookalike characters (0/O, 1/I/L).
-- Uses rejection sampling so every character is equally likely.
create function private.new_group_code() returns text
language plpgsql
set search_path = ''
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- 31 characters
  v_code text;
  v_bytes bytea;
  v_byte integer;
begin
  loop
    v_code := '';
    while length(v_code) < 8 loop
      v_bytes := extensions.gen_random_bytes(16);
      for i in 0 .. 15 loop
        v_byte := get_byte(v_bytes, i);
        if v_byte < 248 and length(v_code) < 8 then -- 248 = 31 * 8, avoids modulo bias
          v_code := v_code || substr(c_alphabet, (v_byte % 31) + 1, 1);
        end if;
      end loop;
    end loop;
    exit when not exists (select 1 from private.group_secrets where code = v_code);
  end loop;
  return v_code;
end;
$$;

create function private.check_pin_format(p_pin text) returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,12}$' then
    perform private.fail('invalid_pin_format', '22023', 'PIN must be 4 to 12 digits');
  end if;
end;
$$;

create function private.check_name(p_name text) returns text
language plpgsql
set search_path = ''
as $$
begin
  if p_name is null or length(btrim(p_name)) not between 1 and 80 then
    perform private.fail('invalid_name', '22023', 'Name must be 1 to 80 characters');
  end if;
  return btrim(p_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner-only functions (SQL editor). Not callable from the API.
-- ---------------------------------------------------------------------------

-- Creates a group and returns its code, like 'K7MQ-2XPA'. A household-mode group
-- starts with two households, renamable in Settings. People join from the app.
create function private.create_group(p_name text, p_mode text, p_pin text) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_group_id uuid;
  v_code text := private.new_group_code();
begin
  if p_mode is null or p_mode not in ('households', 'people') then
    perform private.fail('invalid_mode', '22023', 'Mode must be households or people');
  end if;
  perform private.check_pin_format(p_pin);

  insert into public.groups (name, mode)
  values (private.check_name(p_name), p_mode)
  returning id into v_group_id;

  insert into private.group_secrets (group_id, code, pin_hash)
  values (v_group_id, v_code, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)));

  if p_mode = 'households' then
    insert into public.parties (group_id, name, kind, sort_order) values
      (v_group_id, 'Household 1', 'household', 1),
      (v_group_id, 'Household 2', 'household', 2);
  end if;

  return private.format_code(v_code);
end;
$$;

-- Changes a group's PIN. Existing devices keep working; revoke them in Settings.
create function private.set_pin(p_group_code text, p_new_pin text) returns void
language plpgsql
set search_path = ''
as $$
begin
  perform private.check_pin_format(p_new_pin);
  update private.group_secrets
  set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10))
  where code = private.normalize_code(p_group_code);
  if not found then
    perform private.fail('not_found', '22023', 'No group with that code');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Device checks used by every RPC
-- ---------------------------------------------------------------------------

-- Returns the calling device's group and person (person may be null right after
-- joining). Raises invalid_device for unknown, malformed or revoked tokens.
create function private.require_device(
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
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    perform private.fail('invalid_device', '28000');
  end if;

  select d.id, d.group_id, d.person_id, p.party_id
  into device_id, group_id, person_id, party_id
  from private.devices d
  left join public.people p on p.id = d.person_id
  where d.token_hash = extensions.digest(decode(p_token, 'hex'), 'sha256')
    and d.revoked_at is null;

  if device_id is null then
    perform private.fail('invalid_device', '28000');
  end if;

  update private.devices d
  set last_seen_at = now()
  where d.id = device_id and d.last_seen_at < now() - interval '1 minute';
end;
$$;

-- Like require_device, but the device must have picked an active person.
create function private.require_person(
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
  from private.require_device(p_token) d;

  if person_id is null
     or exists (select 1 from public.people p where p.id = person_id and p.archived_at is not null) then
    perform private.fail('no_person', '22023', 'Pick who you are first');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

-- Joins a phone to a group. Returns {"token": "..."} on success or
-- {"error": "invalid_credentials"} for a wrong code or PIN (the same answer for
-- both, so codes cannot be probed). Failed attempts must be committed, which is
-- why a wrong PIN returns instead of raising. After 10 failed attempts in 15
-- minutes, every attempt raises locked_out until the window passes.
create function public.register_device(p_group_code text, p_pin text, p_label text default null)
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
      where not ok and at > now() - interval '15 minutes') >= 10 then
    perform private.fail('locked_out', '28000', 'Too many wrong attempts. Try again in 15 minutes.');
  end if;

  select gs.group_id, gs.pin_hash into v_group_id, v_hash
  from private.group_secrets gs
  where gs.code = private.normalize_code(p_group_code);

  if v_hash is null then
    -- Spend the same bcrypt time as a real check so timing does not reveal valid codes.
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

-- Keep-alive for the free Supabase plan. Reads nothing.
create function public.ping() returns text
language sql
security definer
set search_path = ''
as $$
  select 'ok'::text;
$$;

-- Sets which person this phone belongs to.
create function public.set_device_person(p_token text, p_person_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_device(p_token);

  if not exists (
    select 1 from public.people p
    where p.id = p_person_id and p.group_id = v_device.group_id and p.archived_at is null
  ) then
    perform private.fail('invalid_person');
  end if;

  update private.devices set person_id = p_person_id where id = v_device.device_id;
end;
$$;

-- "I'm not listed": adds a new person to the group and sets it as this phone's person.
-- Household mode: p_party_id is the household they belong to.
-- People mode: a new party is created for them and p_party_id must be null.
create function public.add_self(p_token text, p_name text, p_party_id uuid default null) returns uuid
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

  insert into public.people (group_id, name, party_id, sort_order)
  values (v_device.group_id, v_name, v_party_id,
          (select coalesce(max(sort_order), 0) + 1 from public.people where group_id = v_device.group_id))
  returning id into v_person_id;

  update private.devices set person_id = v_person_id where id = v_device.device_id;
  return v_person_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: only the public RPCs are callable from the API, and only by anon.
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.register_device(text, text, text) from public, authenticated;
revoke all on function public.ping() from public, authenticated;
revoke all on function public.set_device_person(text, uuid) from public, authenticated;
revoke all on function public.add_self(text, text, uuid) from public, authenticated;

grant execute on function public.register_device(text, text, text) to anon;
grant execute on function public.ping() to anon;
grant execute on function public.set_device_person(text, uuid) to anon;
grant execute on function public.add_self(text, text, uuid) to anon;
