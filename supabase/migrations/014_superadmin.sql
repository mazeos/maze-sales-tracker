-- ============================================================
-- Maze Sales Tracker IA — Super-admins con permisos totales
-- Tabla de emails super-admin (espejo DB de SUPER_ADMIN_EMAILS del env,
-- necesaria porque la RLS no puede leer el env). st_is_admin() pasa a
-- devolver true para super-admins en CUALQUIER org → todos los permisos
-- de edición del tracker, sin importar el rol de su membresía.
-- Idempotente.
-- ============================================================

create table if not exists public.st_super_admins (
  email text primary key
);
alter table public.st_super_admins enable row level security;
-- deny-all para clientes: solo el service role la lee/escribe (la usan los helpers security definer)

insert into public.st_super_admins (email) values ('alejandro@mazefunnels.com')
on conflict (email) do nothing;

create or replace function public.st_is_super() returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists(
       select 1 from public.st_super_admins
        where lower(email) = lower(coalesce(auth.jwt()->>'email',''))
     ) $$;

create or replace function public.st_is_admin() returns boolean
  language sql stable security definer set search_path = public as
  $$ select public.st_is_super()
        or exists(select 1 from public.st_profiles where id = public.st_my_profile() and role = 'admin') $$;
