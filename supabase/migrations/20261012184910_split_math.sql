-- Split math in SQL. Must give exactly the same results as src/money/split.ts;
-- shared/test-vectors.json is checked against both.
--
-- Inputs are numeric so non-integer values are rejected with the same error codes
-- as the TypeScript version, instead of failing on a cast. Every error is raised
-- with errcode 22023 and the error code as the message, for example 'invalid_total'.

create function private.split_error(p_code text, p_detail text) returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%', p_code using errcode = '22023', detail = p_detail;
end;
$$;

-- True when p is a whole number.
create function private.is_int(p numeric) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and p = trunc(p);
$$;

-- round_half_up(a / b) for a >= 0, b > 0, using integer division only.
create function private.round_half_up_div(a bigint, b bigint) returns bigint
language sql
immutable
set search_path = ''
as $$
  select (2 * a + b) / (2 * b);
$$;

-- Validates an entry total: a whole number of cents from 1 to 100,000,000.
create function private.check_total(p_total numeric) returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not private.is_int(p_total) or p_total <= 0 or p_total > 100000000 then
    perform private.split_error('invalid_total', 'Total must be between $0.01 and $1,000,000.00');
  end if;
  return p_total::bigint;
end;
$$;

-- ---------------------------------------------------------------------------
-- Household mode: returns the other household's share and the payer's share.
-- split_num holds the numerator, the basis points or the amount in cents,
-- depending on the split type.
-- ---------------------------------------------------------------------------

create function private.split_household(
  p_total numeric,
  p_split_type text,
  p_num numeric,
  p_den numeric
) returns table (other_cents integer, payer_cents integer)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_total bigint := private.check_total(p_total);
  v_other bigint;
begin
  case p_split_type
    when 'third' then
      v_other := private.round_half_up_div(v_total, 3);
    when 'half' then
      v_other := private.round_half_up_div(v_total, 2);
    when 'all' then
      v_other := v_total;
    when 'fraction' then
      if not private.is_int(p_num) or not private.is_int(p_den)
         or p_num <= 0 or p_den <= 0 or p_num > p_den then
        perform private.split_error('invalid_fraction', 'Fraction must satisfy 0 < num <= den');
      end if;
      v_other := private.round_half_up_div(v_total * p_num::bigint, p_den::bigint);
    when 'percent' then
      if not private.is_int(p_num) or p_num <= 0 or p_num > 10000 then
        perform private.split_error('invalid_percent', 'Percent must be above 0% and at most 100%');
      end if;
      v_other := private.round_half_up_div(v_total * p_num::bigint, 10000);
    when 'amount' then
      if not private.is_int(p_num) or p_num <= 0 or p_num > v_total then
        perform private.split_error('invalid_amount', 'Amount must be above 0 and at most the total');
      end if;
      v_other := p_num::bigint;
    else
      perform private.split_error('invalid_split_type', format('Unknown household split type %s', p_split_type));
  end case;

  return query select v_other::integer, (v_total - v_other)::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- People mode: p_parties is a jsonb array of {"id", "sort_order", "value"}.
-- Returns one row per party, ordered by sort_order then id (byte order).
-- ---------------------------------------------------------------------------

create function private.split_people(
  p_total numeric,
  p_split_type text,
  p_parties jsonb
) returns table (party_id text, share_cents integer)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_total bigint := private.check_total(p_total);
  v_ids text[];
  v_values numeric[];
  v_n integer;
  v_weights bigint[];
  v_weight_sum bigint;
  v_shares bigint[] := '{}';
  v_remainders bigint[] := '{}';
  v_leftover bigint;
  v_idx integer;
  v_error text;
  v_max numeric;
begin
  -- Parties: a non-empty array of objects with a string id and a whole-number sort order.
  if p_parties is null or jsonb_typeof(p_parties) <> 'array' or jsonb_array_length(p_parties) = 0 then
    perform private.split_error('invalid_parties', 'At least one party is required');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_parties) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e -> 'id') is distinct from 'string'
       or jsonb_typeof(e -> 'sort_order') is distinct from 'number'
       or not private.is_int((e ->> 'sort_order')::numeric)
  ) then
    perform private.split_error('invalid_parties', 'Each party needs an id and a whole-number sort order');
  end if;
  if (select count(distinct e ->> 'id') from jsonb_array_elements(p_parties) e)
     <> jsonb_array_length(p_parties) then
    perform private.split_error('invalid_parties', 'Each party can appear only once');
  end if;

  select
    array_agg(e ->> 'id' order by (e ->> 'sort_order')::numeric, (e ->> 'id') collate "C"),
    array_agg(case when jsonb_typeof(e -> 'value') = 'number' then (e ->> 'value')::numeric end
              order by (e ->> 'sort_order')::numeric, (e ->> 'id') collate "C")
  into v_ids, v_values
  from jsonb_array_elements(p_parties) e;
  v_n := array_length(v_ids, 1);

  -- Values: whole numbers in range, checked in sort order like the TypeScript version.
  if p_split_type in ('amounts', 'percent', 'weights') then
    v_error := case p_split_type
      when 'amounts' then 'invalid_amount'
      when 'percent' then 'invalid_percent'
      else 'invalid_weights' end;
    v_max := case p_split_type
      when 'amounts' then null
      when 'percent' then 10000
      else 1000 end;
    for i in 1 .. v_n loop
      if not private.is_int(v_values[i]) or v_values[i] < 0 or v_values[i] > coalesce(v_max, v_values[i]) then
        perform private.split_error(v_error, 'Each party needs a valid whole-number value');
      end if;
    end loop;
  end if;

  case p_split_type
    when 'equal' then
      v_weights := array_fill(1::bigint, array[v_n]);
    when 'amounts' then
      if (select sum(x) from unnest(v_values) x) <> v_total then
        perform private.split_error('invalid_amount', 'Amounts must add up to the total');
      end if;
      return query
        select t.id, t.val::integer from unnest(v_ids, v_values) with ordinality as t(id, val, n) order by t.n;
      return;
    when 'percent' then
      if (select sum(x) from unnest(v_values) x) <> 10000 then
        perform private.split_error('invalid_percent', 'Percentages must add up to 100%');
      end if;
      v_weights := v_values::bigint[];
    when 'weights' then
      if (select sum(x) from unnest(v_values) x) = 0 then
        perform private.split_error('invalid_weights', 'At least one weight must be above 0');
      end if;
      v_weights := v_values::bigint[];
    else
      perform private.split_error('invalid_split_type', format('Unknown people split type %s', p_split_type));
  end case;

  -- Largest remainder: floor every share, then leftover cents one each by largest
  -- remainder, ties by sort order.
  v_weight_sum := (select sum(w) from unnest(v_weights) w);
  for i in 1 .. v_n loop
    v_shares := v_shares || ((v_total * v_weights[i]) / v_weight_sum);
    v_remainders := v_remainders || ((v_total * v_weights[i]) % v_weight_sum);
  end loop;
  v_leftover := v_total - (select sum(s) from unnest(v_shares) s);

  for v_idx in
    select r.n from unnest(v_remainders) with ordinality as r(rem, n)
    order by r.rem desc, r.n
    limit v_leftover
  loop
    v_shares[v_idx] := v_shares[v_idx] + 1;
  end loop;

  return query
    select t.id, t.share::integer from unnest(v_ids, v_shares) with ordinality as t(id, share, n) order by t.n;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
