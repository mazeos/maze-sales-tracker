# Recrear el pasado del tracker desde HighLevel — Diseño

**Fecha:** 2026-07-10
**Estado:** Diseño aprobado (brainstorming) → planes por fase → implementación
**Origen:** Idea de Ale (2026-07-10). Hoy "Cargar día" es carga manual día a día. Con la data que GHL ya tiene, se puede recrear el pasado del embudo sin cargarlo a mano.

## Contexto y problema

El motor (`api/metrics.js`, `computeMemberKpis`) ya calcula todos los KPIs de un miembro **para cualquier fecha** desde GHL (citas, ventas, conversaciones, inbound, agendas). El modo sombra lo corre por día y guarda `auto_value` vs `manual_value` en `st_shadow_metrics`, pero **solo para calibrar** — no escribe en los contadores reales (`st_entries`).

Ya existe el botón **⚡ Autocompletar** en "Cargar día" (`GET /api/capture/ghl`), que trae la data de GHL del día elegido y la escribe en los contadores para revisar y guardar — pero **solo para closers** (citas + ventas certeras).

Falta: (a) que el ⚡ sirva para **todos los roles**, y (b) un **backfill por rango** para llenar muchos días de una.

## Objetivo

Poder recrear el pasado del tracker con la data de GHL, en dos modos: día por día (extendiendo el ⚡) y por rango (backfill masivo con vista previa).

## Modo A — Día por día (extender el ⚡ Autocompletar)

El botón **⚡ Autocompletar** de "Cargar día" pasa a aparecer para **todos los roles** (hoy gated a `closer`).
- **Closer:** sigue trayendo lo certero (citas del calendario + ventas del día) — sin cambios.
- **Setter / triage:** usa `computeMemberKpis` (el motor completo del modo sombra) para la fecha elegida → outbound/inbound/respuestas/seguimientos/links/agendas.
- Los valores se escriben en los contadores de "Cargar día" (editables, con badge de origen), el usuario revisa y guarda. Igual que hoy, para todos.

`GET /api/capture/ghl` se extiende: si el miembro no es closer, corre `computeMemberKpis` y devuelve sus KPIs (mismo formato `{metrics: {kpi: {value, source:'ghl'}}}`).

## Modo B — Backfill por rango (apoyado en el modo sombra)

En **Configuraciones** del admin de la org (decisión Ale: cada dueño backfillea su equipo), un panel **"Recrear desde HighLevel"**:

1. **Elegís** rango de fechas (desde–hasta, tope **90 días**) + miembros (todo el equipo o seleccionar).
2. **Corre el motor sobre el rango** (job en background): para cada día × miembro, corre `computeMemberKpis` y guarda `auto_value` en `st_shadow_metrics` (reutiliza la lógica de `runShadowForOrg`, parametrizada por fecha). Barra de progreso. Es la parte pesada (trae histórico de GHL).
3. **Vista previa:** tabla de días × KPIs con lo que trajo de GHL (los `auto_value`), **marcando en color los que pisarían** una carga manual existente (`manual_value != null` distinto del auto).
4. **Confirmás** → escribe los `auto_value` elegidos como carga real (`st_entries`), respetando lo que decidas sobre los que pisan (la preview los muestra aparte y podés incluirlos o no).

Esto también materializa la "graduación sombra → real" que ya estaba prevista en el diseño del modo sombra.

## Modelo de datos

Sin tablas nuevas:
- `st_shadow_metrics` (ya existe): el backfill puebla su `auto_value` por día del rango.
- `st_entries` (ya existe): el destino final de los valores confirmados (`{member_id, entry_date, metrics}`).

## Confiabilidad por rol (nota)

- **Closer** (citas/ventas): certero desde GHL.
- **Setter** (conversaciones/inbound/agendas): lo que calcula el motor sombra — en calibración. La **vista previa** (Modo B) y la edición (Modo A) permiten revisar antes de fijar. Por eso se incluye todo, sin bloquear.

## Alcance y fases

### Fase 1 — Modo A (chica, sobre lo existente)
- `GET /api/capture/ghl` para todos los roles (setter/triage vía `computeMemberKpis`).
- Front: mostrar el ⚡ para todos los roles.

### Fase 2 — Modo B (grande)
- Backend: job de backfill por rango (corre el motor por fecha, guarda en `st_shadow_metrics`) + endpoint de estado/progreso + endpoint de "aplicar" (shadow → entries).
- Front: panel "Recrear desde HighLevel" en Configuraciones (rango + miembros + progreso + vista previa + confirmar).

### Fuera
- Automatizar el backfill (es a pedido, no un cron).
- Backfill de KPIs no calculables por GHL (ofertas, referidos, bienvenidas/CTA a calibrar).

## Criterios de éxito

1. En "Cargar día", cualquier miembro (setter incluido) puede autocompletar la fecha elegida con la data de GHL (Fase 1).
2. El admin puede correr un backfill de un rango de fechas para su equipo y ver una vista previa antes de aplicar (Fase 2).
3. La vista previa marca claramente qué escribiría sobre carga manual existente.
4. Al confirmar, los valores quedan como carga real del tracker (`st_entries`) y se ven en el embudo/dashboard de esos días pasados.
5. Nada se escribe sin la confirmación del admin.

## Fuera de alcance explícito
- Cron/automatización del backfill.
- KPIs no derivables de GHL.
- Backfill de rangos > 90 días en una sola corrida (se hace por tramos).
