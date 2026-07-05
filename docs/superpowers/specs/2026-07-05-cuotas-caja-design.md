# Diseño — Tracker de cuotas por cobrar + Caja (front/back)

**Fecha:** 2026-07-05
**Proyecto:** Maze Sales Tracker IA (`/docker/maze-sales-tracker-dev`)
**Estado:** Aprobado por Alejandro (diseño conversacional, sesión 2026-07-05)

## Problema

Las ventas guardan `facturado`, `cash`, `cuotas` (número) y `reserva`, pero nada rastrea las cuotas individuales pendientes de cobro. No existe una vista de caja. Alejandro distingue dos cajas:

- **Caja del front** = cash collected al momento de la venta (cash + reservas)
- **Caja del back** = cuotas que se van cobrando después de la venta

## Alcance

Se construye en `maze-sales-tracker-dev`, se prueba, y se despliega a **ambos** despliegues de producción: `maze-sales-tracker` (multi-tenant) y `clara-sales-tracker` (Clara). Mismo código base.

## Modelo de datos

Tabla nueva `st_cuotas`:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK → st_orgs | cascade |
| `sale_id` | uuid FK → st_sales | cascade (borrar venta borra sus cuotas) |
| `numero` | int | Cuota 1, 2, 3… |
| `monto` | numeric | Editable |
| `due_date` | date | Editable; vencimiento |
| `status` | text | `pendiente` \| `pagada`. **"Vencida" NO se guarda**: se deriva al leer (`due_date < hoy AND status = 'pendiente'`). Sin cron. |
| `paid_date` | date | Cuándo entró el cobro |
| `paid_amount` | numeric | Cuánto entró realmente (default = monto, editable al cobrar) |
| `created_at` | timestamptz | |

Índices: `(org_id)`, `(sale_id)`, `(org_id, status, due_date)`.

### Generación automática (trigger en Postgres)

Las ventas se insertan directo desde el frontend a Supabase (no pasan por la API), y a futuro también las insertará la auto-carga GHL con service role. Por eso la generación vive en un **trigger** sobre `st_sales` (insert y update de campos monetarios/cuotas):

- Resto por cobrar = `facturado − cash − reserva`. Si ≤ 0 → no se genera nada.
- **"Cantidad de pagos" (`st_sales.cuotas`) incluye el pago hecho al cierre cuando entró cash** (decisión 2026-07-05). Pendientes a generar = `cuotas − (1 si cash > 0) − (pagadas registradas)`. Si hay resto pero la cuenta da 0, se genera **1** cuota por el resto — la plata en la calle nunca queda invisible.
- Cuotas mensuales iguales, la primera al mes siguiente de `sale_date`.
- Centavos: la última cuota absorbe la diferencia de redondeo (la suma de cuotas = resto exacto).
- **Update de la venta**: se regeneran solo las cuotas `pendiente`; las `pagada` jamás se tocan. Se generan `cuotas − (cantidad de pagadas)` cuotas nuevas, repartiendo `resto − Σ paid_amount de las pagadas`. Si ese resto ajustado ≤ 0, no queda ninguna pendiente.

### RLS

Mismo patrón que el resto de tablas `st_`:

- SELECT: toda la org (`org_id = st_my_org()`)
- INSERT / UPDATE / DELETE: **solo admin** (`st_is_admin()`). Solo el admin edita cuotas y registra cobros.

### Backfill

Script SQL único (idempotente) que se corre una vez por base al desplegar: para cada `st_sales` existente con resto por cobrar > 0 y sin cuotas generadas, genera su plan desde `sale_date`. Las cuotas con fecha pasada aparecen como vencidas para que el admin las concilie (marque cobradas las que ya entraron).

Ojo: dev, prod multi-tenant y Clara comparten **una sola base Supabase** (`supabase.mazefunnels.io`, tablas `st_*`). El backfill corre una sola vez y se valida con un **dry-run transaccional** (`begin … rollback`) revisando el resumen por org antes de aplicar de verdad.

## UI — Sección "Caja"

Sección nueva en el menú, mobile-first, estilos existentes del tracker. De arriba hacia abajo:

1. **Totales del período** (selector semana/mes como el resto de la app):
   - Caja front: `Σ cash + reserva` de ventas del período (por `sale_date`)
   - Caja back: `Σ paid_amount` de cuotas cobradas en el período (por `paid_date`)
   - Total combinado
2. **Total en la calle**: `Σ monto` de todas las cuotas no pagadas (pendientes + vencidas)
3. **Proyección**: próximos 3 meses, mes por mes, `Σ monto` de cuotas pendientes por `due_date`
4. **Tabla de cuotas**: cliente, programa, cuota n°/total, monto, vencimiento, estado (vencidas destacadas en rojo). Filtro por estado + búsqueda por cliente. Acciones (solo admin):
   - **Cobrar**: confirma `paid_amount` (default el monto, editable si entró distinto) y `paid_date` (default hoy)
   - **Editar**: monto o fecha de la cuota puntual
   - **Link al contacto GHL**: botón por fila → `https://app.mazefunnels.com/v2/location/{location_id}/contacts/detail/{ghl_contact_id}`. `ghl_contact_id` ya existe en `st_sales` (viene de la cita al cargar la venta); `location_id` sale de la integración GHL de la org. Siempre dominio white-label, nunca gohighlevel.com. Si la venta no tiene contacto: aviso gris "sin contacto GHL" (se corrige editando la venta).

Miembros no-admin: sección visible en solo-lectura (patrón existente de la app).

## Casos borde

- Venta sin resto por cobrar → sin cuotas aunque `cuotas > 0`
- Cobro por monto distinto → la cuota queda `pagada` con su `paid_amount` real; la caja del back refleja lo que entró de verdad
- Editar venta parcialmente cobrada → solo se recalculan las pendientes
- Borrar venta → cascade borra sus cuotas
- Venta backfilleada sin `ghl_contact_id` → fila sin link, con aviso

## Despliegue

1. Migraciones `008_cuotas.sql` (tabla + RLS), `009_cuotas_trigger.sql` (generación) y `010_cuotas_backfill.sql` + sección Caja en **dev**
2. QA en dev: crear venta con cuotas, cobrar, editar, borrar, verificar totales/proyección/backfill
3. Deploy a `maze-sales-tracker` (prod) y `clara-sales-tracker`, corriendo el backfill una sola vez por base
4. Avisar a Clara que le aparecerán cuotas vencidas viejas para conciliar

## Testing

- QA manual en dev del flujo completo (generar → cobrar → editar → totales)
- Backfill validado en dev con copia de datos reales antes de tocar prod
- Verificar RLS: un miembro no-admin no puede cobrar/editar cuotas; una org no ve cuotas de otra

## Fuera de alcance (v1)

- Recordatorios automáticos de cobro (WhatsApp/email vía GHL) — posible v2
- Cobro parcial de una cuota en múltiples pagos (una cuota = un cobro)
- Reportes de caja exportables
