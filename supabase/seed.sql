-- Fake data for local development and screenshots. Runs on `supabase db reset`.
-- Every name and amount here is made up.
--
-- LOCAL SEED ONLY. These logins exist only in the local Docker database:
--   Household group "Maple Street"  code HHHH-2222  PIN 1234
--   People group    "Ski Trip"      code PPPP-3333  PIN 1234
--   Personal PINs are 1234 too (Alex and Casey are admins).
--
-- Data is created through the real RPCs (register_device, add_self, add_entry, ...)
-- so shares, balances and the change log come from the same code the app uses.
-- Entry dates are relative to today so the app always looks current.

do $$
declare
  v_code text;
  v_group uuid;
  v_h1 uuid;
  v_h2 uuid;
  v_tok_alex text;
  v_tok_sam text;
  v_alex uuid;
  v_jordan uuid;
  v_sam uuid;
  v_riley uuid;
  v_month date := date_trunc('month', private.today())::date;
  v_entry jsonb;
  v_tok_p text[];
  v_pp uuid[];
  v_name text;
begin
  -- -------------------------------------------------------------------------
  -- Household mode: Maple Street (two households)
  -- -------------------------------------------------------------------------
  v_code := private.create_group('Maple Street', 'households', '1234');
  update private.group_secrets set code = 'HHHH2222' where code = private.normalize_code(v_code)
  returning group_id into v_group;

  select id into v_h1 from public.parties where group_id = v_group and sort_order = 1;
  select id into v_h2 from public.parties where group_id = v_group and sort_order = 2;
  update public.parties set name = 'Main floor' where id = v_h1;
  update public.parties set name = 'Basement suite' where id = v_h2;

  v_tok_alex := public.register_device('HHHH-2222', '1234', 'Seed: Alex''s phone') ->> 'token';
  v_tok_sam := public.register_device('HHHH-2222', '1234', 'Seed: Sam''s phone') ->> 'token';
  -- Alex joins first and becomes admin, then adds everyone else. Every seeded
  -- personal PIN is 1234; Jordan and Riley have none yet, so picking them shows the
  -- "create your PIN" step.
  v_alex := public.add_self(v_tok_alex, 'Alex', v_h1, '1234');
  v_sam := public.upsert_person(v_tok_alex, null, 'Sam', v_h2);
  v_jordan := public.upsert_person(v_tok_alex, null, 'Jordan', v_h1);
  v_riley := public.upsert_person(v_tok_alex, null, 'Riley', v_h2);
  perform public.set_device_person(v_tok_sam, v_sam, '1234');

  perform public.upsert_recurring_bill(v_tok_alex, null, 'Rent', v_h1, 'third',
    p_default_total_cents => 240000, p_auto_add => true, p_day_of_month => 1);
  perform public.upsert_recurring_bill(v_tok_alex, null, 'Hydro', v_h1, 'third');
  perform public.upsert_recurring_bill(v_tok_alex, null, 'Gas', v_h1, 'third');
  perform public.upsert_recurring_bill(v_tok_alex, null, 'Water', v_h1, 'third');
  perform public.upsert_recurring_bill(v_tok_alex, null, 'Wifi', v_h1, 'half',
    p_default_total_cents => 8500);

  -- Two months ago
  perform public.add_entry(v_tok_alex, 'expense', 'Rent', (v_month - interval '2 months')::date, 240000, v_h1, v_alex, 'third');
  perform public.add_entry(v_tok_alex, 'expense', 'Hydro', (v_month - interval '2 months' + interval '11 days')::date, 13412, v_h1, v_alex, 'third');
  perform public.add_entry(v_tok_alex, 'expense', 'Wifi', (v_month - interval '2 months' + interval '14 days')::date, 8500, v_h1, v_jordan, 'half');
  perform public.add_entry(v_tok_sam, 'payment', 'E-transfer', (v_month - interval '2 months' + interval '20 days')::date, 90000, v_h2, v_sam);

  -- Last month
  perform public.add_entry(v_tok_alex, 'expense', 'Rent', (v_month - interval '1 month')::date, 240000, v_h1, v_alex, 'third');
  perform public.add_entry(v_tok_alex, 'expense', 'Gas', (v_month - interval '1 month' + interval '9 days')::date, 7877, v_h1, v_jordan, 'third');
  perform public.add_entry(v_tok_alex, 'expense', 'Water', (v_month - interval '1 month' + interval '12 days')::date, 5250, v_h1, v_alex, 'third');
  perform public.add_entry(v_tok_sam, 'expense', 'Pizza night', (v_month - interval '1 month' + interval '17 days')::date, 6240, v_h2, v_riley, 'half');
  perform public.add_entry(v_tok_alex, 'expense', 'Dinner out', (v_month - interval '1 month' + interval '23 days')::date, 9000, v_h1, v_alex, 'amount', 3500);
  perform public.add_entry(v_tok_sam, 'payment', 'E-transfer', (v_month - interval '1 month' + interval '25 days')::date, 85000, v_h2, v_sam);

  -- This month
  perform public.add_entry(v_tok_alex, 'expense', 'Rent', v_month, 240000, v_h1, v_alex, 'third');
  perform public.add_entry(v_tok_sam, 'expense', 'Groceries run', v_month + 2, 11873, v_h2, v_sam, 'percent', 4000);
  perform public.add_entry(v_tok_sam, 'expense', 'Concert tickets', v_month + 3, 18000, v_h2, v_riley, 'amount', 9000);

  -- An edited entry and a deleted one, so the change log and Deleted screen have content.
  v_entry := public.add_entry(v_tok_alex, 'expense', 'Hydro', v_month + 4, 12000, v_h1, v_alex, 'third');
  perform public.edit_entry(v_tok_sam, (v_entry ->> 'id')::uuid, 'Hydro', v_month + 4, 12644, v_h1, v_alex, 'third');
  v_entry := public.add_entry(v_tok_sam, 'expense', 'Duplicate pizza', v_month + 5, 6240, v_h2, v_riley, 'half');
  perform public.delete_entry(v_tok_sam, (v_entry ->> 'id')::uuid);

  -- -------------------------------------------------------------------------
  -- People mode: Ski Trip (four people, each their own party)
  -- -------------------------------------------------------------------------
  v_code := private.create_group('Ski Trip', 'people', '1234');
  update private.group_secrets set code = 'PPPP3333' where code = private.normalize_code(v_code);

  foreach v_name in array array['Casey', 'Morgan', 'Taylor', 'Quinn'] loop
    v_tok_p := v_tok_p || (public.register_device('PPPP-3333', '1234', 'Seed: ' || v_name || '''s phone') ->> 'token');
    if v_name = 'Casey' then
      perform public.add_self(v_tok_p[1], v_name, null, '1234');
    else
      perform public.set_device_person(v_tok_p[array_length(v_tok_p, 1)],
                                       public.upsert_person(v_tok_p[1], null, v_name), '1234');
    end if;
  end loop;
  select array_agg(pe.party_id order by pe.sort_order) into v_pp
  from public.people pe join private.group_secrets gs on gs.group_id = pe.group_id
  where gs.code = 'PPPP3333';

  perform public.add_entry(v_tok_p[1], 'expense', 'Cabin', v_month - 20, 120000, v_pp[1], null, 'equal', null, null,
    jsonb_build_array(jsonb_build_object('party_id', v_pp[1]), jsonb_build_object('party_id', v_pp[2]),
                      jsonb_build_object('party_id', v_pp[3]), jsonb_build_object('party_id', v_pp[4])));
  perform public.add_entry(v_tok_p[2], 'expense', 'Lift tickets', v_month - 19, 45600, v_pp[2], null, 'equal', null, null,
    jsonb_build_array(jsonb_build_object('party_id', v_pp[2]), jsonb_build_object('party_id', v_pp[3]),
                      jsonb_build_object('party_id', v_pp[4])));
  perform public.add_entry(v_tok_p[3], 'expense', 'Gas for the car', v_month - 19, 8350, v_pp[3], null, 'weights', null, null,
    jsonb_build_array(jsonb_build_object('party_id', v_pp[1], 'value', 2), jsonb_build_object('party_id', v_pp[2], 'value', 1),
                      jsonb_build_object('party_id', v_pp[3], 'value', 1), jsonb_build_object('party_id', v_pp[4], 'value', 1)));
  perform public.add_entry(v_tok_p[4], 'expense', 'Groceries', v_month - 18, 15411, v_pp[4], null, 'percent', null, null,
    jsonb_build_array(jsonb_build_object('party_id', v_pp[1], 'value', 2500), jsonb_build_object('party_id', v_pp[2], 'value', 2500),
                      jsonb_build_object('party_id', v_pp[3], 'value', 3000), jsonb_build_object('party_id', v_pp[4], 'value', 2000)));
  perform public.add_entry(v_tok_p[1], 'expense', 'Rental skis', v_month - 18, 9000, v_pp[1], null, 'amounts', null, null,
    jsonb_build_array(jsonb_build_object('party_id', v_pp[3], 'value', 4500), jsonb_build_object('party_id', v_pp[4], 'value', 4500)));
  perform public.add_entry(v_tok_p[3], 'payment', null, v_month - 10, 20000, v_pp[3], null, null, null, null, null, v_pp[1]);
end;
$$;
