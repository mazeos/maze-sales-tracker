-- ============================================================
-- Maze Sales Tracker IA — Backend (Fase 1: auth + roles + RLS)
-- Aislado con prefijo st_ en el schema public del Supabase del VPS.
-- NO toca ninguna tabla existente (maze-growth, GAB, n8n, etc.).
-- Idempotente: se puede correr varias veces sin romper.
-- ============================================================

-- ---------- Tablas ----------
create table if not exists public.st_orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tz text not null default 'America/Argentina/Buenos_Aires',
  team_mode text not null default 'full',
  created_at timestamptz default now()
);

create table if not exists public.st_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  name text not null,
  role text not null check (role in ('admin','setter','triage','closer')),
  commission numeric not null default 0,
  created_at timestamptz default now()
);
create index if not exists st_profiles_org on public.st_profiles(org_id);

create table if not exists public.st_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  member_id uuid not null references public.st_profiles(id) on delete cascade,
  entry_date date not null,
  metrics jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  unique (member_id, entry_date)
);
create index if not exists st_entries_org on public.st_entries(org_id);

create table if not exists public.st_goals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  period text not null default 'week',
  goals jsonb not null default '{}'::jsonb,
  unique (org_id, period)
);

create table if not exists public.st_sales (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  sale_date date not null default current_date,
  cliente text,
  programa text,
  metodo text,
  facturado numeric not null default 0,
  cash numeric not null default 0,
  cuotas int not null default 0,
  reserva numeric not null default 0,
  closer_id uuid references public.st_profiles(id),
  triage_id uuid references public.st_profiles(id),
  setter_id uuid references public.st_profiles(id),
  fuente text,
  created_by uuid references public.st_profiles(id),
  created_at timestamptz default now()
);
create index if not exists st_sales_org on public.st_sales(org_id);

-- ---------- Helpers (security definer: leen st_profiles sin recursión de RLS) ----------
create or replace function public.st_my_org() returns uuid
  language sql stable security definer set search_path = public as
  $$ select org_id from public.st_profiles where id = auth.uid() $$;

create or replace function public.st_is_admin() returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists(select 1 from public.st_profiles where id = auth.uid() and role = 'admin') $$;

-- ---------- RLS ----------
alter table public.st_orgs     enable row level security;
alter table public.st_profiles enable row level security;
alter table public.st_entries  enable row level security;
alter table public.st_goals    enable row level security;
alter table public.st_sales    enable row level security;

-- st_orgs: ves tu org; la edita solo el admin
drop policy if exists st_orgs_sel on public.st_orgs;
create policy st_orgs_sel on public.st_orgs for select using (id = public.st_my_org());
drop policy if exists st_orgs_upd on public.st_orgs;
create policy st_orgs_upd on public.st_orgs for update using (id = public.st_my_org() and public.st_is_admin());

-- st_profiles: todos ven al equipo; solo el admin agrega/edita/borra
drop policy if exists st_prof_sel on public.st_profiles;
create policy st_prof_sel on public.st_profiles for select using (org_id = public.st_my_org());
drop policy if exists st_prof_ins on public.st_profiles;
create policy st_prof_ins on public.st_profiles for insert with check (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_prof_upd on public.st_profiles;
create policy st_prof_upd on public.st_profiles for update using (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_prof_del on public.st_profiles;
create policy st_prof_del on public.st_profiles for delete using (org_id = public.st_my_org() and public.st_is_admin());

-- st_entries: todos VEN todo el equipo; cada uno EDITA solo lo suyo (o el admin)
drop policy if exists st_ent_sel on public.st_entries;
create policy st_ent_sel on public.st_entries for select using (org_id = public.st_my_org());
drop policy if exists st_ent_ins on public.st_entries;
create policy st_ent_ins on public.st_entries for insert with check (org_id = public.st_my_org() and (member_id = auth.uid() or public.st_is_admin()));
drop policy if exists st_ent_upd on public.st_entries;
create policy st_ent_upd on public.st_entries for update using (org_id = public.st_my_org() and (member_id = auth.uid() or public.st_is_admin()));
drop policy if exists st_ent_del on public.st_entries;
create policy st_ent_del on public.st_entries for delete using (org_id = public.st_my_org() and (member_id = auth.uid() or public.st_is_admin()));

-- st_goals: todos ven; solo admin edita
drop policy if exists st_goal_sel on public.st_goals;
create policy st_goal_sel on public.st_goals for select using (org_id = public.st_my_org());
drop policy if exists st_goal_ins on public.st_goals;
create policy st_goal_ins on public.st_goals for insert with check (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_goal_upd on public.st_goals;
create policy st_goal_upd on public.st_goals for update using (org_id = public.st_my_org() and public.st_is_admin());

-- st_sales: todos ven; edita el closer dueño de la venta, quien la creó, o el admin
drop policy if exists st_sale_sel on public.st_sales;
create policy st_sale_sel on public.st_sales for select using (org_id = public.st_my_org());
drop policy if exists st_sale_ins on public.st_sales;
create policy st_sale_ins on public.st_sales for insert with check (org_id = public.st_my_org() and (closer_id = auth.uid() or created_by = auth.uid() or public.st_is_admin()));
drop policy if exists st_sale_upd on public.st_sales;
create policy st_sale_upd on public.st_sales for update using (org_id = public.st_my_org() and (closer_id = auth.uid() or created_by = auth.uid() or public.st_is_admin()));
drop policy if exists st_sale_del on public.st_sales;
create policy st_sale_del on public.st_sales for delete using (org_id = public.st_my_org() and (closer_id = auth.uid() or created_by = auth.uid() or public.st_is_admin()));

-- ---------- Grants para PostgREST (rol authenticated; RLS sigue aplicando) ----------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.st_orgs, public.st_profiles, public.st_entries, public.st_goals, public.st_sales
  to authenticated;
grant execute on function public.st_my_org() to anon, authenticated;
grant execute on function public.st_is_admin() to anon, authenticated;
