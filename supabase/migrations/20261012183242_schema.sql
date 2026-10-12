-- Evenly schema: groups, parties, people, entries, shares, change log, recurring bills,
-- and the private schema for secrets and devices.
--
-- Access model: the browser never touches tables. Every public table has RLS enabled
-- with no policies, and all privileges are revoked from anon and authenticated. The
-- only way in is the security definer RPC functions added in later migrations.
--
-- Cross-group integrity: every row that references another group-scoped row does so
-- through a composite (group_id, id) foreign key, so a row can never point at data in
-- another group, even if an RPC had a bug.

-- ---------------------------------------------------------------------------
-- Lock down defaults before creating anything
-- ---------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

create schema private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Groups, parties, people
-- ---------------------------------------------------------------------------

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  mode text not null check (mode in ('households', 'people')),
  created_at timestamptz not null default now()
);

create table public.parties (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('household', 'person')),
  sort_order integer not null default 0,
  archived_at timestamptz,
  unique (group_id, id)
);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  name text not null check (length(btrim(name)) between 1 and 80),
  party_id uuid not null,
  sort_order integer not null default 0,
  archived_at timestamptz,
  unique (group_id, id),
  foreign key (group_id, party_id) references public.parties (group_id, id)
);

create index people_party_idx on public.people (party_id);

-- ---------------------------------------------------------------------------
-- Recurring bills (defined before entries, which reference them)
-- ---------------------------------------------------------------------------

create table public.recurring_bills (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  name text not null check (length(btrim(name)) between 1 and 80),
  paid_by_party_id uuid not null,
  split_type text not null
    check (split_type in ('third', 'half', 'all', 'fraction', 'percent', 'amount',
                          'equal', 'amounts', 'weights')),
  split_num integer,
  split_den integer,
  split_inputs jsonb,
  default_total_cents integer check (default_total_cents between 1 and 100000000),
  auto_add boolean not null default false,
  day_of_month integer not null default 1 check (day_of_month between 1 and 28),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, id),
  foreign key (group_id, paid_by_party_id) references public.parties (group_id, id),
  -- An auto-added bill needs a fixed amount to add.
  check (not auto_add or default_total_cents is not null)
);

-- ---------------------------------------------------------------------------
-- Entries and shares
-- ---------------------------------------------------------------------------

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  kind text not null check (kind in ('expense', 'payment')),
  description text not null default '' check (length(description) <= 200),
  entry_date date not null default (now() at time zone 'America/Toronto')::date,
  total_cents integer not null check (total_cents between 1 and 100000000),
  paid_by_party_id uuid not null,
  paid_by_person_id uuid,
  split_type text
    check (split_type in ('third', 'half', 'all', 'fraction', 'percent', 'amount',
                          'equal', 'amounts', 'weights')),
  split_num integer,
  split_den integer,
  split_inputs jsonb,
  recurring_bill_id uuid,
  bill_period date check (bill_period = date_trunc('month', bill_period)::date),
  created_by_person_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by_person_id uuid,
  unique (group_id, id),
  -- A monthly bill can only ever be added once per month, even if that copy was deleted.
  unique (recurring_bill_id, bill_period),
  foreign key (group_id, paid_by_party_id) references public.parties (group_id, id),
  foreign key (group_id, paid_by_person_id) references public.people (group_id, id),
  foreign key (group_id, created_by_person_id) references public.people (group_id, id),
  foreign key (group_id, deleted_by_person_id) references public.people (group_id, id),
  foreign key (group_id, recurring_bill_id) references public.recurring_bills (group_id, id),
  check (kind = 'payment' or length(btrim(description)) > 0),
  check ((kind = 'expense') = (split_type is not null)),
  check ((recurring_bill_id is null) = (bill_period is null))
);

create index entries_group_date_idx on public.entries (group_id, entry_date desc, created_at desc);

create table public.entry_shares (
  group_id uuid not null,
  entry_id uuid not null,
  party_id uuid not null,
  share_cents integer not null check (share_cents >= 0),
  primary key (entry_id, party_id),
  foreign key (group_id, entry_id) references public.entries (group_id, id),
  foreign key (group_id, party_id) references public.parties (group_id, id)
);

create index entry_shares_party_idx on public.entry_shares (party_id);

-- Shares must add up exactly to the entry total. Checked at commit time so an RPC
-- can replace all of an entry's shares inside one transaction.
create function private.check_entry_shares() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entry_id uuid;
  v_total integer;
  v_sum bigint;
begin
  if tg_table_name = 'entries' then
    v_entry_id := new.id;
  elsif tg_op = 'DELETE' then
    v_entry_id := old.entry_id;
  else
    v_entry_id := new.entry_id;
  end if;

  select e.total_cents into v_total from public.entries e where e.id = v_entry_id;
  if v_total is null then
    return null; -- entry no longer exists
  end if;

  select coalesce(sum(s.share_cents), 0) into v_sum
  from public.entry_shares s where s.entry_id = v_entry_id;

  if v_sum <> v_total then
    raise exception 'shares_mismatch'
      using errcode = '23514',
            detail = format('Entry %s has shares of %s but a total of %s', v_entry_id, v_sum, v_total);
  end if;
  return null;
end;
$$;

create constraint trigger entry_shares_sum
  after insert or update or delete on public.entry_shares
  deferrable initially deferred
  for each row execute function private.check_entry_shares();

create constraint trigger entries_total_matches_shares
  after insert or update of total_cents on public.entries
  deferrable initially deferred
  for each row execute function private.check_entry_shares();

-- ---------------------------------------------------------------------------
-- Change log (append only)
-- ---------------------------------------------------------------------------

create table public.entry_events (
  id bigint generated always as identity primary key,
  group_id uuid not null,
  entry_id uuid not null,
  action text not null check (action in ('create', 'edit', 'delete', 'restore')),
  by_person_id uuid,
  at timestamptz not null default now(),
  before jsonb,
  after jsonb,
  note text,
  foreign key (group_id, entry_id) references public.entries (group_id, id),
  foreign key (group_id, by_person_id) references public.people (group_id, id)
);

create index entry_events_entry_idx on public.entry_events (entry_id, at);

create function private.reject_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'append_only' using errcode = '42501', detail = tg_table_name || ' is append only';
end;
$$;

create trigger entry_events_append_only
  before update or delete on public.entry_events
  for each row execute function private.reject_change();

-- ---------------------------------------------------------------------------
-- Private: secrets, devices, PIN attempts
-- ---------------------------------------------------------------------------

create table private.group_secrets (
  group_id uuid primary key references public.groups (id),
  -- 8 characters, stored without the dash, from an alphabet with no lookalikes.
  code text not null unique check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),
  pin_hash text not null
);

create table private.devices (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  token_hash bytea not null unique,
  person_id uuid,
  label text check (length(label) <= 60),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (group_id, person_id) references public.people (group_id, id)
);

create table private.pin_attempts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  ok boolean not null
);

create index pin_attempts_at_idx on private.pin_attempts (at);

-- ---------------------------------------------------------------------------
-- RLS on, no policies, no privileges for API roles
-- ---------------------------------------------------------------------------

alter table public.groups enable row level security;
alter table public.parties enable row level security;
alter table public.people enable row level security;
alter table public.recurring_bills enable row level security;
alter table public.entries enable row level security;
alter table public.entry_shares enable row level security;
alter table public.entry_events enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
