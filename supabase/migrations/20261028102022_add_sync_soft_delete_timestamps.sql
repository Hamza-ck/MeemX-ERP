alter table public.parties add column if not exists deleted_at timestamptz;
alter table public.ledgers add column if not exists deleted_at timestamptz;
alter table public.materials add column if not exists deleted_at timestamptz;
alter table public.vouchers add column if not exists deleted_at timestamptz;
