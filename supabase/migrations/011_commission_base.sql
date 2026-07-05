-- ============================================================
-- Maze Sales Tracker IA — Base de cálculo de comisiones por org
-- 'contador' (default, comportamiento histórico: % sobre el contador
-- manual de cash) | 'cobrado' (% sobre front + cuotas cobradas).
-- Idempotente.
-- ============================================================

alter table public.st_orgs add column if not exists commission_base text not null default 'contador';

do $$ begin
  alter table public.st_orgs add constraint st_orgs_commission_base_chk
    check (commission_base in ('contador','cobrado'));
exception when duplicate_object then null; end $$;
