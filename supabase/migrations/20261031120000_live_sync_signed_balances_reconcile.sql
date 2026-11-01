-- ==============================================================================
-- Live Tally sync fixes
--  1. Credit/debit notes are real voucher types (sales/purchase returns).
--  2. Ledger balances are stored "natural-signed" (negative = overdrawn/advance).
--  3. commit_tally_import no longer moves the connector cursor (it used to do so
--     on every commit, including partial runs and manual Excel imports, which made
--     failed windows unrecoverable). It bumps last_data_change_at instead, which
--     browsers watch to refresh live.
--  4. Vouchers deleted/cancelled in Tally are tombstoned for the synced window.
--  5. Edited vouchers that were previously tombstoned are restored.
--  6. Owner/employee view settings live in the cloud (shared_view_settings) so a role or
--     permission change made by an admin reaches the other devices.
-- ==============================================================================

-- 1. Voucher types ------------------------------------------------------------
alter table public.vouchers drop constraint if exists vouchers_voucher_type_check;
alter table public.vouchers add constraint vouchers_voucher_type_check
  check (voucher_type in ('sales','purchase','receipt','payment','contra','journal','credit_note','debit_note'));

-- 2. Ledger primary group ------------------------------------------------------
alter table public.ledgers add column if not exists primary_group text;

-- 3. Refresh state --------------------------------------------------------------
alter table public.accounting_refresh_state
  add column if not exists last_data_change_at timestamptz not null default now();
-- The old cursor was advanced by partial commits and Excel imports, so it can be
-- too recent. Reset it: the next connector run re-pulls its catch-up window.
update public.accounting_refresh_state set last_successful_import_at = null, updated_at = now() where id = 1;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'accounting_refresh_state') then
    alter publication supabase_realtime add table public.accounting_refresh_state;
  end if;
end $$;

-- 6. Shared view settings -------------------------------------------------------
create table if not exists public.shared_view_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table public.shared_view_settings enable row level security;
drop policy if exists "Authenticated users read shared view settings" on public.shared_view_settings;
drop policy if exists "Admin inserts shared view settings" on public.shared_view_settings;
drop policy if exists "Admin updates shared view settings" on public.shared_view_settings;
drop policy if exists "Admin deletes shared view settings" on public.shared_view_settings;
create policy "Authenticated users read shared view settings" on public.shared_view_settings
  for select to authenticated using ((select auth.uid()) is not null);
create policy "Admin inserts shared view settings" on public.shared_view_settings
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admin updates shared view settings" on public.shared_view_settings
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin deletes shared view settings" on public.shared_view_settings
  for delete to authenticated using ((select public.is_admin()));
create index if not exists idx_shared_view_settings_updated_by on public.shared_view_settings(updated_by);

-- 3-5. Commit RPC ---------------------------------------------------------------
create or replace function public.commit_tally_import(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.import_jobs%rowtype;
  v_row record;
  v_payload jsonb;
  v_type text;
  v_name text;
  v_sku text;
  v_source_company text;
  v_source_guid text;
  v_source_hash text;
  v_existing_hash text;
  v_existing_deleted timestamptz;
  v_party_id uuid;
  v_ledger_id uuid;
  v_material_id uuid;
  v_voucher_id uuid;
  v_affected integer;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_deleted integer := 0;
  v_reconcile_note text := null;
  v_opening numeric;
  v_current numeric;
  v_win_from date;
  v_win_to date;
  v_win_company text;
  v_live integer;
  v_stale integer;
begin
  if not public.is_admin() then
    raise exception 'Admin role required' using errcode = '42501';
  end if;

  select * into v_job from public.import_jobs where id = p_job_id for update;
  if not found then raise exception 'Import job not found'; end if;
  if v_job.status <> 'ready' then raise exception 'Import job is not ready to commit'; end if;

  for v_row in
    select * from public.import_rows
    where job_id = p_job_id and selected_for_import and validation_status in ('valid', 'warning')
    order by row_number
  loop
    v_payload := v_row.payload;
    v_type := coalesce(v_payload->>'type', '');
    v_name := coalesce(v_payload->>'name', '');
    v_sku := coalesce(nullif(v_payload->>'sku', ''), 'TALLY-' || left(md5(v_name), 12));
    v_opening := coalesce(nullif(v_payload->>'opening_balance', '')::numeric, 0);
    -- Balances are natural-signed; do NOT abs() them (overdrafts / customer advances matter).
    v_current := coalesce(
      nullif(v_payload->>'closing_balance', '')::numeric,
      nullif(v_payload->>'current_balance', '')::numeric,
      v_opening
    );

    if v_row.row_type = 'ledger' then
      select id into v_ledger_id from public.ledgers where lower(name) = lower(v_name) limit 1 for update;
      if v_ledger_id is null then
        insert into public.ledgers(name, "group", primary_group, opening_balance, current_balance, is_system, category)
        values (v_name, coalesce(v_payload->>'group', 'General'), nullif(v_payload->>'primary_group', ''),
                v_opening, v_current, false, coalesce(nullif(v_payload->>'category', ''), 'asset'));
        v_inserted := v_inserted + 1;
      else
        update public.ledgers
        set "group" = coalesce(nullif(v_payload->>'group', ''), "group"),
            primary_group = coalesce(nullif(v_payload->>'primary_group', ''), primary_group),
            opening_balance = v_opening,
            current_balance = v_current,
            category = coalesce(nullif(v_payload->>'category', ''), category),
            deleted_at = null
        where id = v_ledger_id;
        v_updated := v_updated + 1;
      end if;
      v_ledger_id := null;

    elsif v_row.row_type = 'party' then
      v_type := case when lower(coalesce(v_payload->>'type', 'debtor')) = 'creditor' then 'creditor' else 'debtor' end;
      select id into v_party_id from public.parties
      where lower(name) = lower(v_name) and type = v_type order by created_at limit 1 for update;

      if v_party_id is null then
        insert into public.parties(name, type, uid, phone, email, address, opening_balance, current_balance)
        values (v_name, v_type, nullif(v_payload->>'uid', ''), nullif(v_payload->>'phone', ''),
                nullif(v_payload->>'email', ''), nullif(v_payload->>'address', ''), v_opening, v_current);
        v_inserted := v_inserted + 1;
      else
        update public.parties
        set phone = coalesce(nullif(v_payload->>'phone', ''), phone),
            email = coalesce(nullif(v_payload->>'email', ''), email),
            address = coalesce(nullif(v_payload->>'address', ''), address),
            opening_balance = v_opening,
            current_balance = v_current,
            deleted_at = null,
            updated_at = now()
        where id = v_party_id;
        v_updated := v_updated + 1;
      end if;
      v_party_id := null;

    elsif v_row.row_type = 'stock_item' then
      select id into v_material_id from public.materials
      where lower(sku) = lower(v_sku) or lower(name) = lower(v_name)
      order by case when lower(sku) = lower(v_sku) then 0 else 1 end
      limit 1 for update;

      if v_material_id is null then
        insert into public.materials(sku, name, category, unit, purchase_rate, sales_rate, current_qty, current_value, reorder_threshold)
        values (v_sku, v_name, coalesce(v_payload->>'category', 'General'), coalesce(v_payload->>'unit', 'pcs'),
                coalesce(nullif(v_payload->>'purchase_rate', '')::numeric, 0),
                coalesce(nullif(v_payload->>'sales_rate', '')::numeric, 0),
                coalesce(nullif(v_payload->>'current_qty', '')::numeric, 0),
                nullif(v_payload->>'current_value', '')::numeric, 10);
        v_inserted := v_inserted + 1;
      else
        update public.materials
        set sku = case when exists (select 1 from public.materials other
                                    where other.id <> v_material_id and lower(other.sku) = lower(v_sku))
                       then materials.sku else v_sku end,
            category = coalesce(nullif(v_payload->>'category', ''), category),
            unit = coalesce(nullif(v_payload->>'unit', ''), unit),
            purchase_rate = coalesce(nullif(v_payload->>'purchase_rate', '')::numeric, purchase_rate),
            sales_rate = coalesce(nullif(v_payload->>'sales_rate', '')::numeric, sales_rate),
            current_qty = coalesce(nullif(v_payload->>'current_qty', '')::numeric, current_qty),
            current_value = coalesce(nullif(v_payload->>'current_value', '')::numeric, current_value),
            deleted_at = null,
            updated_at = now()
        where id = v_material_id;
        v_updated := v_updated + 1;
      end if;
      v_material_id := null;

    elsif v_row.row_type = 'voucher' then
      v_source_company := coalesce(nullif(v_payload->>'source_company', ''), 'default');
      v_source_guid := nullif(v_payload->>'source_voucher_guid', '');
      v_source_hash := nullif(v_payload->>'source_hash', '');
      v_voucher_id := null; v_existing_hash := null; v_existing_deleted := null;

      if v_source_guid is not null then
        select id, source_hash, deleted_at into v_voucher_id, v_existing_hash, v_existing_deleted
        from public.vouchers
        where source_system = 'tally' and source_company = v_source_company and source_voucher_guid = v_source_guid
        limit 1 for update;
      else
        select id, source_hash, deleted_at into v_voucher_id, v_existing_hash, v_existing_deleted
        from public.vouchers
        where source_system = 'tally' and source_company = v_source_company and voucher_no = v_payload->>'voucher_no'
        limit 1 for update;
      end if;

      -- Unchanged AND still live → nothing to do. A tombstoned copy must be restored.
      if v_voucher_id is not null and v_existing_hash = v_source_hash and v_existing_deleted is null then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      begin
        if v_voucher_id is not null then
          update public.vouchers
          set voucher_no = v_payload->>'voucher_no',
              voucher_type = v_payload->>'voucher_type',
              date = (v_payload->>'date')::date,
              party_name = coalesce(nullif(v_payload->>'party_name', ''), 'Cash'),
              party_uid = nullif(v_payload->>'party_uid', ''),
              amount = coalesce(nullif(v_payload->>'amount', '')::numeric, 0),
              paid_amount = coalesce(nullif(v_payload->>'paid_amount', '')::numeric, 0),
              due_amount = coalesce(nullif(v_payload->>'due_amount', '')::numeric, 0),
              payment_mode = coalesce(nullif(v_payload->>'payment_mode', ''), 'Tally import'),
              items = coalesce(v_payload->'items', '[]'::jsonb),
              ledger_entries = coalesce(v_payload->'ledger_entries', '[]'::jsonb),
              narration = nullif(v_payload->>'narration', ''),
              reference_no = nullif(v_payload->>'reference_no', ''),
              source_system = 'tally', source_company = v_source_company,
              source_voucher_guid = v_source_guid, source_hash = v_source_hash,
              deleted_at = null, updated_at = now()
          where id = v_voucher_id;
          v_updated := v_updated + 1;
        else
          insert into public.vouchers(
            voucher_no, voucher_type, date, party_name, party_uid, amount, paid_amount, due_amount,
            payment_mode, items, ledger_entries, narration, reference_no,
            source_system, source_company, source_voucher_guid, source_hash, created_by)
          values (
            v_payload->>'voucher_no', v_payload->>'voucher_type', (v_payload->>'date')::date,
            coalesce(nullif(v_payload->>'party_name', ''), 'Cash'), nullif(v_payload->>'party_uid', ''),
            coalesce(nullif(v_payload->>'amount', '')::numeric, 0),
            coalesce(nullif(v_payload->>'paid_amount', '')::numeric, 0),
            coalesce(nullif(v_payload->>'due_amount', '')::numeric, 0),
            coalesce(nullif(v_payload->>'payment_mode', ''), 'Tally import'),
            coalesce(v_payload->'items', '[]'::jsonb), coalesce(v_payload->'ledger_entries', '[]'::jsonb),
            nullif(v_payload->>'narration', ''), nullif(v_payload->>'reference_no', ''),
            'tally', v_source_company, v_source_guid, v_source_hash, auth.uid())
          on conflict do nothing;   -- any unique key (voucher_no, guid, hash), not only voucher_no
          get diagnostics v_affected = row_count;
          if v_affected = 1 then v_inserted := v_inserted + 1; else v_skipped := v_skipped + 1; end if;
        end if;
      exception when unique_violation then
        -- Renumbered voucher collided with another row; leave it for the next run
        -- rather than failing the whole batch.
        v_skipped := v_skipped + 1;
      end;
      v_voucher_id := null;
    end if;
  end loop;

  -- Deletions: tombstone Tally vouchers inside the synced window that Tally no longer returns
  -- (deleted, cancelled, optional, or re-typed to a non-accounting voucher).
  if v_job.counts ? 'window' then
    v_win_from := (v_job.counts->'window'->>'from')::date;
    v_win_to := (v_job.counts->'window'->>'to')::date;
    v_win_company := v_job.counts->'window'->>'company';

    select count(*) into v_live from public.vouchers
    where source_system = 'tally' and source_company = v_win_company and deleted_at is null
      and date between v_win_from and v_win_to;

    select count(*) into v_stale from public.vouchers v
    where v.source_system = 'tally' and v.source_company = v_win_company and v.deleted_at is null
      and v.date between v_win_from and v_win_to
      and not exists (
        select 1 from public.import_rows r
        where r.job_id = p_job_id and r.row_type = 'voucher'
          and r.payload->>'source_voucher_guid' = v.source_voucher_guid);

    -- Safety valve: an empty/truncated export must never wipe a window.
    if v_stale > 0 and v_stale > greatest(5, v_live / 2) then
      v_reconcile_note := format('skipped: %s of %s vouchers would be removed', v_stale, v_live);
    else
      update public.vouchers v
      set deleted_at = now(), updated_at = now()
      where v.source_system = 'tally' and v.source_company = v_win_company and v.deleted_at is null
        and v.date between v_win_from and v_win_to
        and not exists (
          select 1 from public.import_rows r
          where r.job_id = p_job_id and r.row_type = 'voucher'
            and r.payload->>'source_voucher_guid' = v.source_voucher_guid);
      get diagnostics v_deleted = row_count;
    end if;
  end if;

  update public.import_jobs
  set status = 'committed', committed_at = now(),
      counts = coalesce(counts, '{}'::jsonb) || jsonb_build_object(
        'inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped, 'deleted', v_deleted,
        'problems', coalesce((counts->>'problems')::integer, 0))
  where id = p_job_id;

  -- Signal browsers to refresh. The connector cursor (last_successful_import_at) is
  -- owned by the connector and only advanced after a fully successful run.
  update public.accounting_refresh_state
  set last_data_change_at = now(), updated_at = now(), last_successful_import_job = p_job_id
  where id = 1;

  insert into public.audit_logs(actor_id, action, entity_table, entity_id, metadata)
  values (auth.uid(), 'tally_import_committed', 'import_jobs', p_job_id::text,
          jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped,
                             'deleted', v_deleted, 'reconcile', v_reconcile_note, 'filename', v_job.filename));

  return jsonb_build_object('status', 'committed', 'inserted', v_inserted, 'updated', v_updated,
                            'skipped', v_skipped, 'deleted', v_deleted, 'reconcileNote', v_reconcile_note,
                            'jobId', p_job_id);
end;
$$;

revoke all on function public.commit_tally_import(uuid) from public, anon;
grant execute on function public.commit_tally_import(uuid) to authenticated;
