-- Evaluate auth and admin helpers once per statement, not once per row.
-- Split broad ALL policies so they do not overlap their SELECT policies.
drop policy if exists "Profiles: Admin manages profiles" on public.profiles;
drop policy if exists "Profiles: user reads self or Admin reads all" on public.profiles;
drop policy if exists "Profiles: Admin inserts profiles" on public.profiles;
drop policy if exists "Profiles: Admin updates profiles" on public.profiles;
drop policy if exists "Profiles: Admin deletes profiles" on public.profiles;
create policy "Profiles: user reads self or Admin reads all" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select public.is_admin()));
create policy "Profiles: Admin inserts profiles" on public.profiles
  for insert to authenticated with check ((select public.is_admin()));
create policy "Profiles: Admin updates profiles" on public.profiles
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Profiles: Admin deletes profiles" on public.profiles
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "Authenticated users read materials" on public.materials;
create policy "Authenticated users read materials" on public.materials
  for select to authenticated using ((select auth.uid()) is not null);
drop policy if exists "Admin inserts materials" on public.materials;
create policy "Admin inserts materials" on public.materials
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "Admin updates materials" on public.materials;
create policy "Admin updates materials" on public.materials
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "Admin deletes materials" on public.materials;
create policy "Admin deletes materials" on public.materials
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "Authenticated users read ledgers" on public.ledgers;
create policy "Authenticated users read ledgers" on public.ledgers
  for select to authenticated using ((select auth.uid()) is not null);
drop policy if exists "Admin inserts ledgers" on public.ledgers;
create policy "Admin inserts ledgers" on public.ledgers
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "Admin updates ledgers" on public.ledgers;
create policy "Admin updates ledgers" on public.ledgers
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "Admin deletes ledgers" on public.ledgers;
create policy "Admin deletes ledgers" on public.ledgers
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "Authenticated users read parties" on public.parties;
create policy "Authenticated users read parties" on public.parties
  for select to authenticated using ((select auth.uid()) is not null);
drop policy if exists "Admin inserts parties" on public.parties;
create policy "Admin inserts parties" on public.parties
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "Admin updates parties" on public.parties;
create policy "Admin updates parties" on public.parties
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "Admin deletes parties" on public.parties;
create policy "Admin deletes parties" on public.parties
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "Authenticated users read vouchers" on public.vouchers;
create policy "Authenticated users read vouchers" on public.vouchers
  for select to authenticated using ((select auth.uid()) is not null);
drop policy if exists "Admin inserts vouchers" on public.vouchers;
create policy "Admin inserts vouchers" on public.vouchers
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "Admin updates vouchers" on public.vouchers;
create policy "Admin updates vouchers" on public.vouchers
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "Admin deletes vouchers" on public.vouchers;
create policy "Admin deletes vouchers" on public.vouchers
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "Authenticated users read app settings" on public.app_settings;
drop policy if exists "Admin manages app settings" on public.app_settings;
drop policy if exists "Admin inserts app settings" on public.app_settings;
drop policy if exists "Admin updates app settings" on public.app_settings;
drop policy if exists "Admin deletes app settings" on public.app_settings;
create policy "Authenticated users read app settings" on public.app_settings
  for select to authenticated using ((select auth.uid()) is not null);
create policy "Admin inserts app settings" on public.app_settings
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admin updates app settings" on public.app_settings
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin deletes app settings" on public.app_settings
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "Authenticated users read accounting refresh state" on public.accounting_refresh_state;
drop policy if exists "Admin updates accounting refresh state" on public.accounting_refresh_state;
drop policy if exists "Admin inserts accounting refresh state" on public.accounting_refresh_state;
drop policy if exists "Admin deletes accounting refresh state" on public.accounting_refresh_state;
create policy "Authenticated users read accounting refresh state" on public.accounting_refresh_state
  for select to authenticated using ((select auth.uid()) is not null);
create policy "Admin inserts accounting refresh state" on public.accounting_refresh_state
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admin updates accounting refresh state" on public.accounting_refresh_state
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Admin deletes accounting refresh state" on public.accounting_refresh_state
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "Admin reads import jobs" on public.import_jobs;
drop policy if exists "Admin manages import jobs" on public.import_jobs;
create policy "Admin manages import jobs" on public.import_jobs
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "Admin manages import rows" on public.import_rows;
create policy "Admin manages import rows" on public.import_rows
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "Admin reads audit logs" on public.audit_logs;
create policy "Admin reads audit logs" on public.audit_logs
  for select to authenticated using ((select public.is_admin()));

create index if not exists idx_accounting_refresh_state_last_import_job
  on public.accounting_refresh_state(last_successful_import_job);
create index if not exists idx_app_settings_updated_by on public.app_settings(updated_by);
create index if not exists idx_audit_logs_actor_id on public.audit_logs(actor_id);
create index if not exists idx_import_jobs_created_by on public.import_jobs(created_by);
create index if not exists idx_vouchers_created_by on public.vouchers(created_by);
create index if not exists idx_vouchers_credit_ledger_id on public.vouchers(credit_ledger_id);
create index if not exists idx_vouchers_debit_ledger_id on public.vouchers(debit_ledger_id);
create index if not exists idx_vouchers_party_id on public.vouchers(party_id);
