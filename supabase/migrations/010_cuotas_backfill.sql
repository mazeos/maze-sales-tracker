-- ============================================================
-- Maze Sales Tracker IA — Backfill de cuotas para ventas existentes
-- Genera el plan SOLO para ventas que aún no tienen ninguna cuota.
-- Idempotente: en la segunda corrida no encuentra candidatas.
-- Las cuotas con fecha pasada quedarán "vencidas" para conciliar.
-- ============================================================

select public.st_regen_cuotas(s)
  from public.st_sales s
 where not exists (select 1 from public.st_cuotas c where c.sale_id = s.id);
