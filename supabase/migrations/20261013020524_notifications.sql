-- Push notifications.
--
-- Every new, edited, deleted or restored entry notifies everyone in the group except
-- the person who did it (on every phone that turned notifications on). A trigger on
-- the change log queues one HTTP call (pg_net, sent after commit) to the `notify`
-- Edge Function with only the event id and a shared secret; the function reads the
-- message and the targets from here and sends Web Push. Notifications never block a
-- write: if anything about them fails, the entry is still saved.
--
-- Setup lives in Vault, not in the repo: `evenly_notify_secret` is generated here,
-- and `evenly_notify_url` (the function's URL) is added by the owner in production.
-- Without the URL (local development, tests) nothing is sent.

create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'evenly_notify_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'evenly_notify_secret',
                                'Shared secret between the database and the notify Edge Function');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Subscriptions (one per phone that turned notifications on)
-- ---------------------------------------------------------------------------

create table private.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references private.devices (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  created_at timestamptz not null default now()
);

create index push_subscriptions_device_idx on private.push_subscriptions (device_id);
revoke all on all tables in schema private from public, anon, authenticated;

-- Saves this phone's push subscription (moving it here if another device had it).
create function public.save_push_subscription(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_device(p_token);
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{80,100}$'
     or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{16,32}$' then
    perform private.fail('invalid_subscription');
  end if;
  insert into private.push_subscriptions (device_id, endpoint, p256dh, auth)
  values (v_device.device_id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
  set device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

-- Turns notifications off for this phone.
create function public.delete_push_subscription(p_token text, p_endpoint text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select * into v_device from private.require_device(p_token);
  delete from private.push_subscriptions s where s.endpoint = p_endpoint and s.device_id = v_device.device_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- What to say, and to whom
-- ---------------------------------------------------------------------------

-- 13412 -> '$134.12' (exact: numeric division, display only).
create function private.money_text(p_cents bigint) returns text
language sql
immutable
set search_path = ''
as $$
  select '$' || to_char(p_cents / 100.0, 'FM999,999,990.00');
$$;

-- The notification for one change-log event: {title, body, tag, url}.
create function private.push_message(p_event_id bigint) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_event public.entry_events;
  v_entry public.entries;
  v_group text;
  v_who text;
  v_name text;
  v_total text;
  v_payer text;
  v_receiver text;
  v_body text;
begin
  select * into v_event from public.entry_events where id = p_event_id;
  select * into v_entry from public.entries where id = v_event.entry_id;
  select g.name into v_group from public.groups g where g.id = v_entry.group_id;
  select pe.name into v_who from public.people pe where pe.id = v_event.by_person_id;

  v_total := private.money_text(v_entry.total_cents);
  v_name := case
    when v_entry.kind = 'expense' then v_entry.description
    when v_entry.settles then 'a settle-up'
    else 'a payment' end;
  select p.name into v_payer from public.parties p where p.id = v_entry.paid_by_party_id;
  select p.name into v_receiver from public.entry_shares s join public.parties p on p.id = s.party_id
  where s.entry_id = v_entry.id limit 1;

  v_body := case v_event.action
    when 'create' then
      case
        when v_who is null then format('%s was added automatically · %s', v_entry.description, v_total)
        when v_entry.kind = 'expense' then format('%s added %s · %s', v_who, v_entry.description, v_total)
        when v_entry.settles then format('%s settled up: %s paid %s %s', v_who, v_payer, v_receiver, v_total)
        else format('%s recorded a payment: %s paid %s %s', v_who, v_payer, v_receiver, v_total)
      end
    when 'edit' then format('%s edited %s · now %s', coalesce(v_who, 'Someone'), v_name, v_total)
    when 'delete' then format('%s deleted %s · %s', coalesce(v_who, 'Someone'), v_name, v_total)
    when 'restore' then format('%s restored %s · %s', coalesce(v_who, 'Someone'), v_name, v_total)
  end;

  return jsonb_build_object('title', v_group, 'body', v_body, 'tag', 'entry-' || v_entry.id, 'url', './');
end;
$$;

-- Phones to notify: every active phone in the group with a picked person and
-- notifications on, except the phones of the person who made the change.
create function private.push_targets(p_event_id bigint)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql
stable
set search_path = ''
as $$
  select s.id, s.endpoint, s.p256dh, s.auth
  from public.entry_events ev
  join private.devices d on d.group_id = ev.group_id
  join private.push_subscriptions s on s.device_id = d.id
  where ev.id = p_event_id
    and d.revoked_at is null
    and d.person_id is not null
    and (ev.by_person_id is null or d.person_id <> ev.by_person_id);
$$;

-- ---------------------------------------------------------------------------
-- Queue the call to the Edge Function (sent by pg_net after commit)
-- ---------------------------------------------------------------------------

create function private.queue_push() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (select 1 from private.push_targets(new.id)) then
    return null;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'evenly_notify_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'evenly_notify_secret';
  if v_url is null or v_secret is null then
    return null; -- not configured (local development and tests)
  end if;

  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('event_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 10000
  );
  return null;
exception when others then
  -- A notification problem must never stop an entry from being saved.
  raise warning 'queue_push: %', sqlerrm;
  return null;
end;
$$;

create trigger entry_events_push
  after insert on public.entry_events
  for each row execute function private.queue_push();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.save_push_subscription(text, text, text, text) from public, authenticated;
revoke all on function public.delete_push_subscription(text, text) from public, authenticated;
grant execute on function public.save_push_subscription(text, text, text, text) to anon;
grant execute on function public.delete_push_subscription(text, text) to anon;
