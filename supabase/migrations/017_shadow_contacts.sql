-- Desglose de contactos por métrica del modo sombra.
-- Cada fila (member, date, kpi) guarda, además del auto_value, la lista de
-- contactos que componen ese número: [{ id, name, count? }]. count solo cuando
-- el contacto aporta más de 1. Métricas sin contacto (tasas, montos) quedan null.
ALTER TABLE st_shadow_metrics ADD COLUMN IF NOT EXISTS contacts jsonb;
