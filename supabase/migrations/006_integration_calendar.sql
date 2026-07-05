-- 006_integration_calendar.sql
-- Calendario de llamadas elegido por la org desde Configuraciones (Fase 2.3).
--
-- Hasta ahora el calendario de admisión era un env global (GHL_CALENDAR): servía
-- para instancias dedicadas pero no para multi-tenant. Estas columnas guardan el
-- calendario que el admin elige en la UI (select filtrado a calendarios con
-- closers sincronizados). Nullable = la org todavía no configuró → la mini-API
-- cae al env GHL_CALENDAR como fallback (modo PIT / instancia dedicada).
--
-- NO se toca RLS ni permisos: st_integrations sigue en deny-all (RLS habilitada
-- sin policies); solo la service role de la mini-API lee/escribe estas columnas.
--
-- Idempotente: se puede correr múltiples veces sin error.
alter table public.st_integrations add column if not exists calendar_id text;
alter table public.st_integrations add column if not exists calendar_name text;
