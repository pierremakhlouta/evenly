-- Auto-added monthly bills.
--
-- A pg_cron job runs every day and adds each active auto_add bill whose day of the
-- month has been reached (Toronto time) and that has not been added for this month
-- yet. The unique (recurring_bill_id, bill_period) constraint makes it safe to run
-- any number of times, and a deleted copy is never re-added.
--
-- Bill buttons on Home are only shortcuts that pre-fill Add expense; they do not
-- link entries to the bill, so only auto-added entries carry recurring_bill_id.

create extension if not exists pg_cron with schema pg_catalog;

-- Adds every due auto bill for the month containing p_today. Returns how many were
-- added. A bill that cannot be added (for example, its household was archived) is
-- skipped with a warning so one bad bill never blocks the others.
create function private.auto_add_bills(p_today date default private.today()) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period date := date_trunc('month', p_today)::date;
  v_bill public.recurring_bills;
  v_split record;
  v_id uuid;
  v_added integer := 0;
begin
  for v_bill in
    select b.* from public.recurring_bills b
    where b.active and b.auto_add and b.default_total_cents is not null
      and b.day_of_month <= extract(day from p_today)
      and not exists (
        select 1 from public.entries e
        where e.recurring_bill_id = b.id and e.bill_period = v_period
      )
    order by b.group_id, b.sort_order
  loop
    v_id := null;
    begin
      select * into v_split from private.compute_shares(
        v_bill.group_id, 'expense', v_bill.default_total_cents, v_bill.paid_by_party_id, null,
        v_bill.split_type, v_bill.split_num, v_bill.split_den, v_bill.split_inputs);

      insert into public.entries (
        group_id, kind, description, entry_date, total_cents, paid_by_party_id,
        split_type, split_num, split_den, split_inputs, recurring_bill_id, bill_period)
      values (
        v_bill.group_id, 'expense', v_bill.name, v_period + (v_bill.day_of_month - 1), v_bill.default_total_cents,
        v_bill.paid_by_party_id, v_split.split_type, v_split.split_num, v_split.split_den, v_split.split_inputs,
        v_bill.id, v_period)
      on conflict (recurring_bill_id, bill_period) do nothing
      returning id into v_id;

      if v_id is not null then
        perform private.write_shares(v_bill.group_id, v_id, v_split.shares);
        insert into public.entry_events (group_id, entry_id, action, by_person_id, after, note)
        values (v_bill.group_id, v_id, 'create', null, private.entry_json(v_id), 'Added automatically');
        v_added := v_added + 1;
      end if;
    exception when others then
      raise warning 'auto_add_bills: skipped bill % (%): %', v_bill.id, v_bill.name, sqlerrm;
    end;
  end loop;

  return v_added;
end;
$$;

revoke all on function private.auto_add_bills(date) from public, anon, authenticated;

-- Every day at 11:05 UTC (6:05 or 7:05 a.m. in Toronto).
select cron.schedule('evenly-auto-add-bills', '5 11 * * *', 'select private.auto_add_bills()');
