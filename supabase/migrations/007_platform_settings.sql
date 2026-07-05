-- 007_platform_settings.sql
-- Settings de plataforma (super-admin): key/value simple para configuración
-- global de Maze Sales Tracker. Primer uso: el Private Integration Token de
-- agencia de GHL (key 'ghl_agency_pit'), que lista TODAS las subcuentas.
--
-- DECISIÓN DE SEGURIDAD (mismo patrón que 003_integrations.sql): esta tabla
-- tiene RLS habilitada SIN policies y SIN permisos para authenticated/anon.
-- Eso la deja en deny-all para cualquier rol no privilegiado vía PostgREST:
-- el agency PIT solo lo lee y escribe la service role de la mini-API (que
-- bypassea RLS). Al browser jamás viaja el valor completo — únicamente un
-- hint de 4 caracteres vía GET /api/platform/settings (solo super-admins).
--
-- Idempotente: se puede correr múltiples veces sin error.
create table if not exists public.st_platform_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

-- RLS habilitada SIN policies = deny-all para roles no privilegiados.
-- NO crear policies ni otorgar permisos a authenticated/anon en esta tabla.
alter table public.st_platform_settings enable row level security;
