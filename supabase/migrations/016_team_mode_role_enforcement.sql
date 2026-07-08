-- 016_team_mode_role_enforcement.sql
-- Enforcement rol ↔ team_mode a nivel base de datos.
--
-- CONTEXTO: st_orgs.team_mode define qué roles admite una agencia:
--   solo → {setter}
--   sc   → {setter, closer}
--   full → {setter, triage, closer}
-- ('admin' SIEMPRE es válido, en cualquier modo.)
--
-- POR QUÉ EN LA DB: el CAMBIO de rol de un miembro existente se persiste
-- DIRECTO a PostgREST desde el browser (index.html save(), con ANON key + RLS),
-- sin pasar por la mini-API. Este trigger es la ÚNICA capa server-side que cubre
-- ese path. Además cubre el INSERT del alta como red de seguridad del backend.
--
-- EXENCIÓN GHL: el import desde GHL (ghl_user_id no-null) queda exento — cuando GHL
-- está conectado es la fuente de verdad del equipo (decisión 2026-07-04), así que puede
-- traer cualquier rol sin importar el team_mode. Coherente con el backend (server.js).
--
-- CERO MIGRACIÓN DE DATOS: bajar el team_mode a uno más restrictivo NO reescribe
-- roles existentes. Los miembros con un rol ahora inválido se conservan intactos;
-- solo se bloquea CAMBIAR hacia un rol inválido o CREAR uno nuevo inválido.
-- CRÍTICO: save() reescribe el rol de TODOS los miembros en cada guardado (aunque
-- no cambie). Por eso el trigger salta la validación cuando el rol no cambia:
-- sin esa guarda, un miembro con rol legacy-inválido rompería cualquier save.
--
-- Idempotente: se puede correr múltiples veces sin error.

create or replace function public.st_enforce_team_mode_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
  v_allowed text[];
begin
  -- admin siempre es válido, en cualquier modo.
  if new.role = 'admin' then
    return new;
  end if;

  -- Import desde GHL exento: cuando GHL está conectado es la fuente de verdad del
  -- equipo (alta manual oculta, decisión 2026-07-04), así que puede traer cualquier
  -- rol sin importar el team_mode. Los perfiles importados tienen ghl_user_id no-null;
  -- los de carga manual lo tienen null. El team_mode enforza SOLO la carga manual.
  if new.ghl_user_id is not null then
    return new;
  end if;

  -- Rol sin cambios en un UPDATE → no validar (protege save() y miembros legacy).
  if tg_op = 'UPDATE' and NEW.role is not distinct from OLD.role then
    return new;
  end if;

  -- Modo de la org; fallback a 'full' (coherente con el default del schema).
  select team_mode into v_mode from public.st_orgs where id = new.org_id;
  v_mode := coalesce(v_mode, 'full');

  -- Roles permitidos según el mapa canónico.
  v_allowed := case v_mode
    when 'solo' then array['setter']
    when 'sc'   then array['setter', 'closer']
    else array['setter', 'triage', 'closer']
  end;

  if new.role <> all(v_allowed) then
    -- errcode 23514 (check_violation) → PostgREST responde 400.
    raise exception 'Este rol no está disponible para el modo de equipo de tu agencia.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists st_profiles_team_mode_role on public.st_profiles;

create trigger st_profiles_team_mode_role
  before insert or update of role on public.st_profiles
  for each row
  execute function public.st_enforce_team_mode_role();
