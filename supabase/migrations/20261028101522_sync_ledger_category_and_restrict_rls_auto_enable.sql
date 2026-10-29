-- Preserve ledger categories through local/cloud sync, and remove public RPC
-- execution rights from the SECURITY DEFINER event-trigger helper.
alter table public.ledgers
  add column if not exists category text not null default 'asset';

update public.ledgers
set category = case
  when lower("group") like '%expense%' then 'expense'
  when lower("group") like '%income%' then 'income'
  when lower("group") like '%liabilit%' or lower("group") like '%creditor%' then 'liability'
  else category
end
where category = 'asset';

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
