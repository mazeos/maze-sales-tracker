-- ============================================================
-- Maze Sales Tracker IA — Ventas conectadas a GHL (quick 260704-u3n)
-- Columnas nuevas de st_sales para el módulo Ventas-GHL:
--   primer_pago     -> monto del primer pago del contrato
--   fue_reserva     -> la venta fue una reserva (seña), no un pago completo
--   ghl_contact_id  -> contacto de GHL asociado (dispara onboarding)
-- Idempotente: en la base viva del VPS estas columnas YA existen
-- (agregadas a mano para la instancia de Clara) → esta migración es no-op ahí.
-- ============================================================

alter table public.st_sales add column if not exists primer_pago numeric not null default 0;
alter table public.st_sales add column if not exists fue_reserva boolean not null default false;
alter table public.st_sales add column if not exists ghl_contact_id text;
