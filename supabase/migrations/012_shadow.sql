-- ============================================================
-- Maze Sales Tracker IA — Auto-carga Fase A: modo sombra
-- st_shadow_metrics: valor auto calculado vs valor manual, por member/día/kpi.
--   La escribe SOLO el worker (service role). Nunca pisa st_entries en Fase A.
-- st_kpi_config: estado por KPI de la org (sombra|auto|off) + fila '_config'
--   con configuración general ({booking_domains: [...]}).
-- Idempotente.
-- ============================================================

create table if not exists public.st_shadow_metrics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  member_id uuid not null references public.st_profiles(id) on delete cascade,
  metric_date date not null,
  kpi text not null,
  auto_value numeric not null default 0,
  manual_value numeric,
  computed_at timestamptz default now(),
  unique (member_id, metric_date, kpi)
);
create index if not exists st_shadow_org_date on public.st_shadow_metrics(org_id, metric_date);
create index if not exists st_shadow_org_kpi on public.st_shadow_metrics(org_id, kpi, metric_date);

create table if not exists public.st_kpi_config (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  kpi text not null,
  status text not null default 'sombra' check (status in ('sombra','auto','off')),
  config jsonb not null default '{}'::jsonb,
  unique (org_id, kpi)
);

-- RLS: la sombra la ven todos los de la org, la escribe solo el service role.
alter table public.st_shadow_metrics enable row level security;
drop policy if exists st_shadow_sel on public.st_shadow_metrics;
create policy st_shadow_sel on public.st_shadow_metrics for select using (org_id = public.st_my_org());

-- st_kpi_config: ven todos; escribe el admin (switches y config de la org).
alter table public.st_kpi_config enable row level security;
drop policy if exists st_kcfg_sel on public.st_kpi_config;
create policy st_kcfg_sel on public.st_kpi_config for select using (org_id = public.st_my_org());
drop policy if exists st_kcfg_ins on public.st_kpi_config;
create policy st_kcfg_ins on public.st_kpi_config for insert with check (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_kcfg_upd on public.st_kpi_config;
create policy st_kcfg_upd on public.st_kpi_config for update using (org_id = public.st_my_org() and public.st_is_admin());
