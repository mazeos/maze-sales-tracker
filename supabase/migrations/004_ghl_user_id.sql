-- 004_ghl_user_id.sql
-- Vínculo perfil del tracker ↔ usuario de la subcuenta GHL.
--
-- Fase 2 de la integración GHL: el admin importa usuarios de su subcuenta de
-- HighLevel como miembros del tracker. Cada perfil importado guarda acá el id
-- del usuario GHL de origen, lo que permite:
--   1. Mostrar el estado correcto en la lista (Importado / Vinculable / Nuevo / Inactivo).
--   2. Reconciliar con GHL como fuente de verdad: si el usuario ya no existe en
--      la subcuenta, el perfil se da de baja automáticamente (active=false + ban).
--
-- El índice único PARCIAL permite muchos perfiles con ghl_user_id NULL (miembros
-- creados a mano, sin GHL) pero garantiza un solo perfil por usuario GHL.
--
-- Idempotente: se puede correr múltiples veces sin error.
alter table public.st_profiles add column if not exists ghl_user_id text;

create unique index if not exists st_profiles_ghl_user_id_key
  on public.st_profiles(ghl_user_id)
  where ghl_user_id is not null;
