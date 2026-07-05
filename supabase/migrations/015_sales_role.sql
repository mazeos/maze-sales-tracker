-- ============================================================
-- Maze Sales Tracker IA — Rol comercial para admins
-- Un admin puede además operar como setter/triage/closer (dueño que también
-- vende). role = permisos (admin manda), sales_role = rol operativo opcional.
-- Idempotente.
-- ============================================================
alter table public.st_profiles add column if not exists sales_role text;
do $$ begin
  alter table public.st_profiles add constraint st_profiles_sales_role_chk
    check (sales_role is null or sales_role in ('setter','triage','closer'));
exception when duplicate_object then null; end $$;
