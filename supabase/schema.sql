-- ==============================================================================
-- TallyFlow SaaS Cloud Accounting Solutions - Supabase SQL Schema
-- Covers:
-- 1. Daily Sales & Vouchers (F8 Sales, F9 Purchase, F6 Receipt, F5 Payment, F4 Contra, F7 Journal)
-- 2. Pure Material-Wise Inventory (No Models)
-- 3. Permanent Debtor UIDs (for closing due balances) & Creditors Directory
-- 4. Chart of Accounts Ledgers (Cash, Bank, Loans, Expenses, Incomes)
-- 5. Role-Based Access Control (Admin full access vs Owner read-only track)
-- 6. Automated stock and ledger balance synchronization triggers
-- ==============================================================================

-- 1. User Profiles & Roles
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  role text not null default 'owner' check (role in ('admin', 'owner', 'employee')),
  full_name text,
  created_at timestamptz default now()
);

-- 2. Pure Material-Wise Inventory Table (Stock Items)
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null,
  name text not null,
  category text default 'General',
  unit text default 'pcs',
  purchase_rate numeric not null default 0,
  sales_rate numeric not null default 0,
  current_qty numeric not null default 0,
  reorder_threshold numeric default 10,
  deleted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Ensure columns exist if the table was created in a previous version of the app
alter table public.materials add column if not exists category text default 'General';
alter table public.materials add column if not exists purchase_rate numeric not null default 0;
alter table public.materials add column if not exists sales_rate numeric not null default 0;
alter table public.materials add column if not exists updated_at timestamptz default now();
alter table public.materials add column if not exists deleted_at timestamptz;
alter table public.materials drop column if exists model;

-- Ensure role check allows admin, owner, employee
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'owner', 'employee'));
-- New profiles are read-only until an Admin explicitly promotes them.
alter table public.profiles alter column role set default 'owner';

-- 3. Chart of Accounts Ledgers (Cash, Bank Accounts, Loans, Expenses, Incomes)
create table if not exists public.ledgers (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  "group" text not null, -- 'Bank Accounts', 'Cash-in-hand', 'Loans (Liability)', 'Loans & Advances (Asset)', 'Indirect Expenses', 'Direct Expenses', etc.
  opening_balance numeric not null default 0,
  current_balance numeric not null default 0,
  is_system boolean default false,
  category text not null default 'asset',
  deleted_at timestamptz,
  created_at timestamptz default now()
);
alter table public.ledgers add column if not exists category text not null default 'asset';
alter table public.ledgers add column if not exists deleted_at timestamptz;
update public.ledgers set category = case
  when lower("group") like '%expense%' then 'expense'
  when lower("group") like '%income%' then 'income'
  when lower("group") like '%liabilit%' or lower("group") like '%creditor%' then 'liability'
  else category
end;

-- 4. Parties (Sundry Debtors with Permanent UID & Sundry Creditors)
create table if not exists public.parties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('debtor', 'creditor')),
  uid text unique, -- Permanent UID for debtors with closing dues (e.g. UID-CUST-1001)
  phone text,
  email text,
  address text,
  opening_balance numeric not null default 0,
  current_balance numeric not null default 0,
  deleted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.parties add column if not exists deleted_at timestamptz;

-- 5. Tally Vouchers (Sales F8, Purchase F9, Receipt F6, Payment F5, Contra F4, Journal F7)
create table if not exists public.vouchers (
  id uuid primary key default gen_random_uuid(),
  voucher_no text unique not null,
  voucher_type text not null check (voucher_type in ('sales', 'purchase', 'receipt', 'payment', 'contra', 'journal')),
  date date not null default current_date,
  party_id uuid references public.parties(id) on delete set null,
  party_name text not null default 'Cash',
  party_uid text, -- Circulating UID for permanent reference
  amount numeric not null default 0 check (amount >= 0),
  paid_amount numeric not null default 0,
  due_amount numeric not null default 0,
  payment_mode text default 'HDFC Bank',
  debit_ledger_id uuid references public.ledgers(id) on delete set null,
  credit_ledger_id uuid references public.ledgers(id) on delete set null,
  items jsonb default '[]'::jsonb, -- Array of [{ material_id, sku, name, qty, rate, cost_rate, amount }]
  narration text,
  reference_no text,
  deleted_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.vouchers add column if not exists deleted_at timestamptz;

-- Indexes for high-speed queries
create index if not exists idx_vouchers_date on public.vouchers(date desc);
create index if not exists idx_vouchers_type on public.vouchers(voucher_type);
create index if not exists idx_vouchers_party_uid on public.vouchers(party_uid);
create index if not exists idx_parties_uid on public.parties(uid);
create index if not exists idx_materials_sku on public.materials(sku);
create index if not exists idx_vouchers_created_by on public.vouchers(created_by);
create index if not exists idx_vouchers_credit_ledger_id on public.vouchers(credit_ledger_id);
create index if not exists idx_vouchers_debit_ledger_id on public.vouchers(debit_ledger_id);
create index if not exists idx_vouchers_party_id on public.vouchers(party_id);

-- ==============================================================================
-- Row-Level Security (RLS) and import staging
-- Admin: full control. Owner/employee: SELECT only.
-- ==============================================================================

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.materials enable row level security;
alter table public.ledgers enable row level security;
alter table public.parties enable row level security;
alter table public.vouchers enable row level security;

drop policy if exists "Profiles are readable by authenticated users" on public.profiles;
drop policy if exists "Admin manages all profiles" on public.profiles;
drop policy if exists "Authenticated users can read materials" on public.materials;
drop policy if exists "Authenticated users can read ledgers" on public.ledgers;
drop policy if exists "Authenticated users can read parties" on public.parties;
drop policy if exists "Authenticated users can read vouchers" on public.vouchers;
drop policy if exists "Admin can insert materials" on public.materials;
drop policy if exists "Admin can update materials" on public.materials;
drop policy if exists "Admin can delete materials" on public.materials;
drop policy if exists "Admin can insert ledgers" on public.ledgers;
drop policy if exists "Admin can update ledgers" on public.ledgers;
drop policy if exists "Admin can insert parties" on public.parties;
drop policy if exists "Admin can update parties" on public.parties;
drop policy if exists "Admin can delete parties" on public.parties;
drop policy if exists "Admin can insert vouchers" on public.vouchers;
drop policy if exists "Admin can update vouchers" on public.vouchers;
drop policy if exists "Admin can delete vouchers" on public.vouchers;
drop policy if exists "Profiles: user reads self or Admin reads all" on public.profiles;
drop policy if exists "Profiles: Admin manages profiles" on public.profiles;
drop policy if exists "Profiles: Admin inserts profiles" on public.profiles;
drop policy if exists "Profiles: Admin updates profiles" on public.profiles;
drop policy if exists "Profiles: Admin deletes profiles" on public.profiles;
drop policy if exists "Authenticated users read materials" on public.materials;
drop policy if exists "Admin inserts materials" on public.materials;
drop policy if exists "Admin updates materials" on public.materials;
drop policy if exists "Admin deletes materials" on public.materials;
drop policy if exists "Authenticated users read ledgers" on public.ledgers;
drop policy if exists "Admin inserts ledgers" on public.ledgers;
drop policy if exists "Admin updates ledgers" on public.ledgers;
drop policy if exists "Admin deletes ledgers" on public.ledgers;
drop policy if exists "Authenticated users read parties" on public.parties;
drop policy if exists "Admin inserts parties" on public.parties;
drop policy if exists "Admin updates parties" on public.parties;
drop policy if exists "Admin deletes parties" on public.parties;
drop policy if exists "Authenticated users read vouchers" on public.vouchers;
drop policy if exists "Admin inserts vouchers" on public.vouchers;
drop policy if exists "Admin updates vouchers" on public.vouchers;
drop policy if exists "Admin deletes vouchers" on public.vouchers;

create policy "Profiles: user reads self or Admin reads all" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select public.is_admin()));
create policy "Profiles: Admin inserts profiles" on public.profiles
  for insert to authenticated with check ((select public.is_admin()));
create policy "Profiles: Admin updates profiles" on public.profiles
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Profiles: Admin deletes profiles" on public.profiles
  for delete to authenticated using ((select public.is_admin()));

create policy "Authenticated users read materials" on public.materials
  for select to authenticated using ((select auth.uid()) is not null);
create policy "Admin inserts materials" on public.materials
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admin updates materials" on public.materials
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin deletes materials" on public.materials
  for delete to authenticated using ((select public.is_admin()));

create policy "Authenticated users read ledgers" on public.ledgers
  for select to authenticated using ((select auth.uid()) is not null);
create policy "Admin inserts ledgers" on public.ledgers
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admin updates ledgers" on public.ledgers
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin deletes ledgers" on public.ledgers
  for delete to authenticated using ((select public.is_admin()));

create policy "Authenticated users read parties" on public.parties
  for select to authenticated using ((select auth.uid()) is not null);
create policy "Admin inserts parties" on public.parties
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admin updates parties" on public.parties
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin deletes parties" on public.parties
  for delete to authenticated using ((select public.is_admin()));

create policy "Authenticated users read vouchers" on public.vouchers
  for select to authenticated using ((select auth.uid()) is not null);
create policy "Admin inserts vouchers" on public.vouchers
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admin updates vouchers" on public.vouchers
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin deletes vouchers" on public.vouchers
  for delete to authenticated using ((select public.is_admin()));

alter table public.vouchers add column if not exists source_system text;
alter table public.vouchers add column if not exists source_company text;
alter table public.vouchers add column if not exists source_voucher_guid text;
alter table public.vouchers add column if not exists source_hash text;
create unique index if not exists idx_vouchers_source_hash_unique on public.vouchers(source_hash) where source_hash is not null;
create unique index if not exists idx_vouchers_tally_guid_unique on public.vouchers(source_system, source_company, source_voucher_guid) where source_voucher_guid is not null;

create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(), filename text not null,
  source_format text not null check (source_format in ('xml','xlsx','xls','csv')),
  content_sha256 text, status text not null default 'ready' check (status in ('ready','committed','failed','cancelled')),
  counts jsonb not null default '{}'::jsonb, created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), committed_at timestamptz, error_summary text
);
create table if not exists public.import_rows (
  id uuid primary key default gen_random_uuid(), job_id uuid not null references public.import_jobs(id) on delete cascade,
  row_number integer not null, row_type text not null check (row_type in ('voucher','ledger','party','stock_item')),
  reference text, payload jsonb not null default '{}'::jsonb,
  validation_status text not null check (validation_status in ('valid','warning','error','duplicate')),
  validation_messages jsonb not null default '[]'::jsonb, selected_for_import boolean not null default true,
  created_at timestamptz not null default now(), unique (job_id, row_number)
);
create index if not exists idx_import_rows_job_status on public.import_rows(job_id, validation_status);
create index if not exists idx_import_jobs_created on public.import_jobs(created_at desc);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(), actor_id uuid references auth.users(id),
  action text not null, entity_table text not null, entity_id text,
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists idx_audit_logs_created on public.audit_logs(created_at desc);

alter table public.import_jobs enable row level security;
alter table public.import_rows enable row level security;
alter table public.audit_logs enable row level security;
drop policy if exists "Admin reads import jobs" on public.import_jobs;
drop policy if exists "Admin manages import jobs" on public.import_jobs;
drop policy if exists "Admin manages import rows" on public.import_rows;
drop policy if exists "Admin reads audit logs" on public.audit_logs;
create policy "Admin manages import jobs" on public.import_jobs for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin manages import rows" on public.import_rows for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin reads audit logs" on public.audit_logs for select to authenticated using ((select public.is_admin()));
create index if not exists idx_import_jobs_created_by on public.import_jobs(created_by);
create index if not exists idx_audit_logs_actor_id on public.audit_logs(actor_id);

create or replace function public.commit_tally_import(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_job public.import_jobs%rowtype;
  v_row record;
  v_payload jsonb;
  v_type text;
  v_name text;
  v_affected integer;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_party_id uuid;
begin
  if not public.is_admin() then raise exception 'Admin role required' using errcode = '42501'; end if;
  select * into v_job from public.import_jobs where id = p_job_id for update;
  if not found then raise exception 'Import job not found'; end if;
  if v_job.status <> 'ready' then raise exception 'Import job is not ready to commit'; end if;

  for v_row in select * from public.import_rows where job_id = p_job_id and selected_for_import and validation_status in ('valid','warning') order by row_number loop
    v_payload := v_row.payload;
    v_type := coalesce(v_payload->>'type','');
    v_name := coalesce(v_payload->>'name','');

    if v_row.row_type = 'ledger' then
      insert into public.ledgers(name, "group", opening_balance, current_balance, is_system)
      values (v_name, coalesce(v_payload->>'group','General'), coalesce(nullif(v_payload->>'opening_balance','')::numeric,0), coalesce(nullif(v_payload->>'opening_balance','')::numeric,0), false)
      on conflict (name) do nothing;
      get diagnostics v_affected = row_count;
      if v_affected > 0 then v_inserted := v_inserted + 1; else v_skipped := v_skipped + 1; end if;

    elsif v_row.row_type = 'party' then
      v_type := case when lower(coalesce(v_payload->>'type','debtor')) = 'creditor' then 'creditor' else 'debtor' end;
      select id into v_party_id from public.parties where lower(name) = lower(v_name) and type = v_type limit 1;
      if v_party_id is null then
        insert into public.parties(name,type,uid,phone,email,address,opening_balance,current_balance)
        values (v_name,v_type,nullif(v_payload->>'uid',''),nullif(v_payload->>'phone',''),nullif(v_payload->>'email',''),nullif(v_payload->>'address',''),coalesce(nullif(v_payload->>'opening_balance','')::numeric,0),coalesce(nullif(v_payload->>'opening_balance','')::numeric,0));
        v_inserted := v_inserted + 1;
      else
        v_skipped := v_skipped + 1;
      end if;
      v_party_id := null;

    elsif v_row.row_type = 'stock_item' then
      insert into public.materials(sku,name,category,unit,purchase_rate,sales_rate,current_qty,reorder_threshold)
      values (coalesce(nullif(v_payload->>'sku',''),'TALLY-' || left(md5(v_name),12)),v_name,coalesce(v_payload->>'category','General'),coalesce(v_payload->>'unit','pcs'),coalesce(nullif(v_payload->>'purchase_rate','')::numeric,0),coalesce(nullif(v_payload->>'sales_rate','')::numeric,0),coalesce(nullif(v_payload->>'opening_qty','')::numeric,0),10)
      on conflict (sku) do nothing;
      get diagnostics v_affected = row_count;
      if v_affected > 0 then v_inserted := v_inserted + 1; else v_skipped := v_skipped + 1; end if;

    elsif v_row.row_type = 'voucher' then
      if exists (select 1 from public.vouchers where source_hash = v_payload->>'source_hash'
        or (nullif(v_payload->>'source_voucher_guid','') is not null and source_system = 'tally'
          and source_company = coalesce(nullif(v_payload->>'source_company',''),'default') and source_voucher_guid = v_payload->>'source_voucher_guid')) then
        v_skipped := v_skipped + 1;
      else
        insert into public.vouchers(voucher_no,voucher_type,date,party_name,party_uid,amount,paid_amount,due_amount,payment_mode,items,narration,reference_no,source_system,source_company,source_voucher_guid,source_hash,created_by)
        values (v_payload->>'voucher_no',v_payload->>'voucher_type',(v_payload->>'date')::date,coalesce(nullif(v_payload->>'party_name',''),'Cash'),nullif(v_payload->>'party_uid',''),coalesce(nullif(v_payload->>'amount','')::numeric,0),coalesce(nullif(v_payload->>'paid_amount','')::numeric,0),coalesce(nullif(v_payload->>'due_amount','')::numeric,0),coalesce(nullif(v_payload->>'payment_mode',''),'Tally import'),coalesce(v_payload->'items','[]'::jsonb),nullif(v_payload->>'narration',''),nullif(v_payload->>'reference_no',''),'tally',coalesce(nullif(v_payload->>'source_company',''),'default'),nullif(v_payload->>'source_voucher_guid',''),nullif(v_payload->>'source_hash',''),auth.uid())
        on conflict (voucher_no) do nothing;
        get diagnostics v_affected = row_count;
        if v_affected > 0 then v_inserted := v_inserted + 1; else v_skipped := v_skipped + 1; end if;
      end if;
    end if;
  end loop;

  update public.import_jobs set status = 'committed', committed_at = now(),
    counts = coalesce(counts,'{}'::jsonb) || jsonb_build_object('inserted',v_inserted,'skipped',v_skipped,'problems',coalesce((counts->>'problems')::integer,0))
    where id = p_job_id;
  insert into public.audit_logs(actor_id,action,entity_table,entity_id,metadata)
    values (auth.uid(),'tally_import_committed','import_jobs',p_job_id::text,jsonb_build_object('inserted',v_inserted,'skipped',v_skipped,'filename',v_job.filename));
  return jsonb_build_object('status','committed','inserted',v_inserted,'skipped',v_skipped,'jobId',p_job_id);
end;
$$;
revoke all on function public.commit_tally_import(uuid) from public, anon;
grant execute on function public.commit_tally_import(uuid) to authenticated;

-- ==============================================================================
-- Initial Seed Data (Standard Chart of Accounts & Material Stock)
-- ==============================================================================

insert into public.ledgers (name, "group", opening_balance, current_balance, is_system)
values
  ('Cash in Hand', 'Cash-in-hand', 45000, 45000, true),
  ('HDFC Current Account 0422', 'Bank Accounts', 285000, 285000, true),
  ('State Bank of India (SBI)', 'Bank Accounts', 140000, 140000, true),
  ('HDFC Business Term Loan', 'Loans (Liability)', 200000, 200000, false),
  ('Staff Emergency Advances', 'Loans & Advances (Asset)', 15000, 15000, false),
  ('Sales Account', 'Sales Accounts', 0, 0, true),
  ('Purchase Account', 'Purchase Accounts', 0, 0, true),
  ('Shop Rent Expense', 'Indirect Expenses', 0, 0, false),
  ('Staff Salaries', 'Indirect Expenses', 0, 0, false),
  ('Electricity & Utilities', 'Indirect Expenses', 0, 0, false)
on conflict (name) do nothing;

insert into public.materials (sku, name, category, unit, purchase_rate, sales_rate, current_qty, reorder_threshold)
values
  ('MAT-CANVAS-01', 'Industrial Cotton Canvas 350 GSM', 'Fabrics & Textiles', 'meter', 140, 195, 450, 50),
  ('MAT-DENIM-02', 'Heavy Weight Denim Twill 14oz', 'Fabrics & Textiles', 'meter', 180, 260, 280, 40),
  ('MAT-BOLT-03', 'High Tensile Steel Bolts M12', 'Hardware & Fasteners', 'box', 380, 520, 65, 15),
  ('MAT-ZIP-04', 'YKK Brass Heavy Zipper 5# (24 inch)', 'Accessories & Trims', 'pcs', 18, 32, 850, 100),
  ('MAT-THRD-05', 'Polyester Bonded Thread 40/2', 'Accessories & Trims', 'spool', 65, 110, 140, 25)
on conflict (sku) do nothing;

insert into public.parties (name, type, uid, phone, email, address, opening_balance, current_balance)
values
  ('Apex Infotech Pvt Ltd', 'debtor', 'UID-CUST-1001', '+91 98450 11223', 'accounts@apexinfotech.in', 'Plot 44, Electronic City, Bangalore', 24500, 24500),
  ('Golden Star Garments', 'debtor', 'UID-CUST-1002', '+91 98211 44556', 'purchase@goldenstargarments.com', 'Industrial Area Phase 2, Ludhiana', 18200, 18200),
  ('Metro Steel & Hardware', 'creditor', null, '+91 98210 99887', 'sales@metrosteel.com', 'Loha Mandi, Delhi', 45000, 45000),
  ('Supreme Fabrics Mill', 'creditor', null, '+91 98765 43210', 'mill@supremefabrics.com', 'Ring Road Textile Market, Surat', 62000, 62000)
on conflict do nothing;
