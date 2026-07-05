# Diseño — Comisiones sobre cash real (toggle por org)

**Fecha:** 2026-07-05
**Proyecto:** Maze Sales Tracker IA (`/docker/maze-sales-tracker-dev`)
**Estado:** Aprobado por Alejandro (sesión 2026-07-05)
**Depende de:** feature Caja/cuotas (`2026-07-05-cuotas-caja-design.md`) — usa `st_cuotas`

## Problema

Hoy la comisión del closer se calcula como `% × contador "Cash"` que él mismo carga a mano en Cargar día (`closerPayout()` en `index.html`). Eso comisiona sobre lo declarado, no sobre lo que entró de verdad, y no contempla las cuotas del back.

## Decisiones

- **Toggle por org** (no por closer), en Configuraciones, solo admin. OFF = comportamiento actual intacto.
- Con el toggle activado, la base del mes del closer = **front + back cobrado**:
  - Front = Σ `cash + reserva` de las ventas con `closer_id = él` (por `sale_date` del período)
  - Back = Σ `paid_amount` de cuotas **cobradas en el período** (por `paid_date`, monto real) cuyas ventas son suyas
- El closer cobra comisión de una cuota recién cuando entra la plata.

## Datos

Migración `011_commission_base.sql`:

```sql
alter table public.st_orgs add column if not exists commission_base text not null default 'contador'
  check (commission_base in ('contador','cobrado'));
```

- Sin RLS nueva: `st_orgs` ya restringe UPDATE al admin.
- `loadFromSupabase` mapea `DB.team.commission_base`; el guardado va por el update de `st_orgs` existente en `pushToSupabase` (agregar el campo).

## Lógica (frontend)

Función nueva `closerPayoutBase(memberId, start, end)` que devuelve `{front, back, base}`:
- `front`: filtra `DB.sales` por `closer === memberId` y `date` en rango
- `back`: filtra `DB.cuotas` por `status === 'pagada'`, `paid_date` en rango, y la venta (`sale_id`) con `closer === memberId`
- `closerPayout(m)` pasa a decidir por `DB.team.commission_base`: `'cobrado'` → `% × (front+back)` del mes actual; `'contador'` → igual que hoy (`cash_nuevo` del contador)

## UI

1. **Configuraciones → card Agencia**: switch "Comisiones sobre lo cobrado (ventas + cuotas)" (solo admin, patrón de los settings existentes). Al cambiarlo se refrescan los "A cobrar este mes".
2. **"A cobrar este mes"** por closer (ya existe en Configuraciones): respeta el modo.
3. **Vista Caja → bloque "Comisiones del período"** (visible solo con toggle en `'cobrado'` y si hay closers con % > 0): tabla por closer — front, back, %, a cobrar — usando el selector de período de la vista.
4. **Drill-down de comisión** (fórmula en el panel): muestra la base según el modo (`cash contador` vs `front + back`).

## Casos borde

- Venta sin `closer_id` → no comisiona a nadie (ni front ni sus cuotas).
- El bloque de Caja y Configuraciones muestran **solo closers activos** (como todo el resto de la app). Las comisiones de un closer dado de baja quedan fuera de alcance v1.
- Cambio de % → recalcula sobre el período visible; no hay histórico de % (igual que hoy).
- Toggle OFF en una org que nunca lo tocó → cero cambios de comportamiento (default `'contador'`).

## Testing

- SQL: transaccional — venta con closer + cuota pagada → verificar sumas front/back por rango.
- UI en dev: activar toggle, verificar "A cobrar" cambia; cobrar una cuota → el back del closer sube en el período del cobro; toggle OFF → vuelve al contador.

## Fuera de alcance

- Comisiones para setter/triage; histórico de % de comisión; export/liquidación.
