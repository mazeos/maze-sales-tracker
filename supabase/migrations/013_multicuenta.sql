-- ============================================================
-- Maze Sales Tracker IA — Multi-cuenta (membresías)
-- Un login (auth.users) puede tener perfiles en VARIAS orgs.
-- Los perfiles históricos conservan su id (= login); las membresías
-- nuevas nacen con id propio. La "org activa" vive en st_user_state.
-- Idempotente.
-- ============================================================

-- 1. st_profiles: separar cuenta (user_id) de membresía (id)
alter table public.st_profiles add column if not exists user_id uuid;
update public.st_profiles set user_id = id where user_id is null;
alter table public.st_profiles alter column user_id set not null;
alter table public.st_profiles drop constraint if exists st_profiles_id_fkey;
alter table public.st_profiles alter column id set default gen_random_uuid();
do $$ begin
  alter table public.st_profiles add constraint st_profiles_user_org_uniq unique (user_id, org_id);
exception when duplicate_object then null; end $$;
create index if not exists st_profiles_user on public.st_profiles(user_id);

-- 2. Estado del usuario: qué perfil tiene activo
create table if not exists public.st_user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active_profile_id uuid references public.st_profiles(id) on delete set null,
  updated_at timestamptz default now()
);
alter table public.st_user_state enable row level security;
drop policy if exists st_ustate_sel on public.st_user_state;
create policy st_ustate_sel on public.st_user_state for select using (user_id = auth.uid());
drop policy if exists st_ustate_ins on public.st_user_state;
create policy st_ustate_ins on public.st_user_state for insert
  with check (user_id = auth.uid() and (active_profile_id is null or active_profile_id in (select id from public.st_profiles where user_id = auth.uid())));
drop policy if exists st_ustate_upd on public.st_user_state;
create policy st_ustate_upd on public.st_user_state for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and (active_profile_id is null or active_profile_id in (select id from public.st_profiles where user_id = auth.uid())));

-- 3. Helpers: perfil activo (estado válido, o el único/primer perfil activo)
create or replace function public.st_my_profile() returns uuid
  language sql stable security definer set search_path = public as
  $$ select coalesce(
       (select s.active_profile_id from public.st_user_state s
          join public.st_profiles p on p.id = s.active_profile_id and p.user_id = s.user_id
         where s.user_id = auth.uid() and p.active is not false),
       (select p.id from public.st_profiles p
         where p.user_id = auth.uid() and p.active is not false
         order by p.created_at limit 1)
     ) $$;

create or replace function public.st_my_org() returns uuid
  language sql stable security definer set search_path = public as
  $$ select org_id from public.st_profiles where id = public.st_my_profile() $$;

create or replace function public.st_is_admin() returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists(select 1 from public.st_profiles where id = public.st_my_profile() and role = 'admin') $$;

-- 4. Ownership: de auth.uid() (login) a st_my_profile() (membresía activa)
drop policy if exists st_ent_ins on public.st_entries;
create policy st_ent_ins on public.st_entries for insert with check (org_id = public.st_my_org() and (member_id = public.st_my_profile() or public.st_is_admin()));
drop policy if exists st_ent_upd on public.st_entries;
create policy st_ent_upd on public.st_entries for update using (org_id = public.st_my_org() and (member_id = public.st_my_profile() or public.st_is_admin()));
drop policy if exists st_ent_del on public.st_entries;
create policy st_ent_del on public.st_entries for delete using (org_id = public.st_my_org() and (member_id = public.st_my_profile() or public.st_is_admin()));

drop policy if exists st_sale_ins on public.st_sales;
create policy st_sale_ins on public.st_sales for insert with check (org_id = public.st_my_org() and (closer_id = public.st_my_profile() or created_by = public.st_my_profile() or public.st_is_admin()));
drop policy if exists st_sale_upd on public.st_sales;
create policy st_sale_upd on public.st_sales for update using (org_id = public.st_my_org() and (closer_id = public.st_my_profile() or created_by = public.st_my_profile() or public.st_is_admin()));
drop policy if exists st_sale_del on public.st_sales;
create policy st_sale_del on public.st_sales for delete using (org_id = public.st_my_org() and (closer_id = public.st_my_profile() or created_by = public.st_my_profile() or public.st_is_admin()));

-- 5. El selector necesita ver TUS orgs y TUS perfiles (además de los de tu org activa)
drop policy if exists st_orgs_sel_own on public.st_orgs;
create policy st_orgs_sel_own on public.st_orgs for select
  using (id in (select org_id from public.st_profiles where user_id = auth.uid()));
drop policy if exists st_prof_sel_own on public.st_profiles;
create policy st_prof_sel_own on public.st_profiles for select using (user_id = auth.uid());
