-- Tally's own Profit & Loss per period. The dashboard shows these figures (cost of sales is
-- opening stock + purchases + direct expenses − closing stock, exactly as Tally computes it)
-- instead of rebuilding cost from item quantities.
create table if not exists public.tally_pnl_periods (
  company text not null,
  period_start date not null,
  period_end date not null,
  sales numeric not null default 0,
  direct_income numeric not null default 0,
  opening_stock numeric not null default 0,
  purchases numeric not null default 0,
  direct_expenses numeric not null default 0,
  closing_stock numeric not null default 0,
  cogs numeric not null default 0,
  gross_profit numeric not null default 0,
  indirect_expenses numeric not null default 0,
  indirect_income numeric not null default 0,
  net_profit numeric not null default 0,
  source text not null default 'connector' check (source in ('connector', 'excel')),
  fetched_at timestamptz not null default now(),
  primary key (company, period_start, period_end),
  check (period_start <= period_end)
);

alter table public.tally_pnl_periods enable row level security;
drop policy if exists "Authenticated users read tally pnl" on public.tally_pnl_periods;
drop policy if exists "Admin inserts tally pnl" on public.tally_pnl_periods;
drop policy if exists "Admin updates tally pnl" on public.tally_pnl_periods;
create policy "Authenticated users read tally pnl" on public.tally_pnl_periods
  for select to authenticated using ((select auth.uid()) is not null);
create policy "Admin inserts tally pnl" on public.tally_pnl_periods
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admin updates tally pnl" on public.tally_pnl_periods
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- New figures bump the change marker so open browsers refresh (same signal the voucher commit uses).
create or replace function public.touch_refresh_state_from_pnl()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.accounting_refresh_state set last_data_change_at = now(), updated_at = now() where id = 1;
  return null;
end $$;
revoke all on function public.touch_refresh_state_from_pnl() from public, anon, authenticated;
drop trigger if exists trg_tally_pnl_touch on public.tally_pnl_periods;
create trigger trg_tally_pnl_touch after insert or update on public.tally_pnl_periods
  for each statement execute function public.touch_refresh_state_from_pnl();
