-- ============================================================
-- Maze Sales Tracker IA — Cuotas por cobrar (caja del back)
-- Una fila por cuota del plan de pagos de una venta.
-- "Vencida" NO se guarda: se deriva (due_date < hoy y status pendiente).
-- Idempotente: se puede correr varias veces sin romper.
-- ============================================================

create table if not exists public.st_cuotas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  sale_id uuid not null references public.st_sales(id) on delete cascade,
  numero int not null,
  monto numeric not null default 0,
  due_date date not null,
  status text not null default 'pendiente' check (status in ('pendiente','pagada')),
  paid_date date,
  paid_amount numeric,
  created_at timestamptz default now()
);
create index if not exists st_cuotas_org on public.st_cuotas(org_id);
create index if not exists st_cuotas_sale on public.st_cuotas(sale_id);
create index if not exists st_cuotas_org_status_due on public.st_cuotas(org_id, status, due_date);

-- RLS: toda la org las ve; solo el admin escribe (cobra/edita/borra)
alter table public.st_cuotas enable row level security;
drop policy if exists st_cuo_sel on public.st_cuotas;
create policy st_cuo_sel on public.st_cuotas for select using (org_id = public.st_my_org());
drop policy if exists st_cuo_ins on public.st_cuotas;
create policy st_cuo_ins on public.st_cuotas for insert with check (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_cuo_upd on public.st_cuotas;
create policy st_cuo_upd on public.st_cuotas for update using (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_cuo_del on public.st_cuotas;
create policy st_cuo_del on public.st_cuotas for delete using (org_id = public.st_my_org() and public.st_is_admin());
