# Diseño — Autocompletar desde GHL (Fase 3 carcasa)

**Fecha:** 2026-07-05
**Proyecto:** Maze Sales Tracker IA (`/docker/maze-sales-tracker-dev`)
**Estado:** Aprobado por Alejandro (sesión 2026-07-05)
**Depende de:** integración OAuth GHL por org + calendario de llamadas configurado (Fases 1–2.3 carcasa, ya en dev)

## Problema

Cada miembro tipea a mano en Cargar día números que GHL (o el propio tracker) ya sabe con certeza: citas, asistencias, no-shows, cierres, cash. Fricción diaria y fuente de inconsistencias — el pecado original de la planilla.

## Principio rector (Ale): "híbrido siempre"

Auto solo lo **certero**; lo nativo (conversaciones, respuestas, links TikTok/IG) queda manual. Nada se guarda sin que el humano revise y confirme. **Regla dura: si una métrica no se puede atribuir con certeza, NO se autocompleta.**

## Decisiones

- **Solo botón, sin job nocturno** (el endpoint queda reutilizable si algún día se quiere el job).
- **GHL manda en lo certero**: al apretar el botón, las métricas certeras se pisan con el dato fresco; las manuales no se tocan. El usuario ve qué cambió y puede corregir antes de guardar.
- **Cierres y cash se autocompletan desde las Ventas del tracker** (st_sales del día, server-side), no desde GHL — una sola fuente de verdad.

## Mini-API — endpoint nuevo

`GET /api/capture/ghl?date=YYYY-MM-DD[&member_id=uuid]`

- Auth: JWT del usuario logueado. Sin `member_id` = para sí mismo; con `member_id` solo admin (para cargar el día de otro).
- Resuelve org → integración GHL (tokens con refresh, helper `refreshGhlToken` existente) → `calendar_id` de la org. Sin integración o sin calendario → **501** (mismo contrato que `/api/ghl/leads`; la UI oculta el botón).
- Trae los appointments del calendario del día pedido, con el día calculado en la **TZ de la org** (no UTC).
- Arma la respuesta según el rol del miembro:
  - **Closer** (matchea por su `ghl_user_id` en `assignedUserId` de la cita): `llamadas` (citas del día), `asistencias` (status `showed`), `noshows` (status `noshow`)
  - **Setter**: VERIFICADO contra la API real (2026-07-05): `createdBy.userId` llega **null** (booking widget / third party) → la atribución setter→cita NO es certera. Además las métricas del setter están partidas por canal (`agend_ig`/`agend_wpp`) que GHL no conoce. **Decisión: v1 = autocompletar SOLO para closers**; setter y triage siguen 100% manuales (endpoint responde 400 para esos roles).
  - **Cierres/cash** (closer): query server-side a `st_sales` (`closer_id = member`, `sale_date = date`) con service role → `cierres` = cantidad, `cash` = Σ cash.
- Respuesta: `{ date, member_id, metrics: { asistencias: {value, certain, source:'ghl'}, cierres: {value, certain, source:'ventas'}, ... } }` — solo las métricas que aplican al rol; todo lo no incluido es manual.
- Miembro sin `ghl_user_id`: solo vuelven las métricas `source:'ventas'` (si es closer); las de GHL no aplican.

## UI — Cargar día

1. Botón **"⚡ Autocompletar desde GHL"** junto al selector de fecha. Visible solo si: org con GHL conectado (probe al endpoint, mismo patrón lazy de `loadGhlLeads`) y el miembro seleccionado tiene métricas autocompletables.
2. Al apretar: fetch → por cada métrica con `certain:true`, setea el contador y le pone un **badge "GHL"** (o "Ventas") al lado del número; las métricas manuales quedan intactas. Toast resumen: "3 métricas traídas de GHL — revisá y guardá".
3. El usuario puede corregir cualquier valor (el badge desaparece si lo edita a mano). **Guardar sigue siendo el mismo flujo de siempre** — nada se persiste al apretar el botón.
4. Errores: 501 → botón oculto; error de red/GHL → toast "No se pudo traer de GHL, cargá a mano" sin romper nada.
5. Fecha pasada: funciona igual (el endpoint recibe `date`) — sirve para corregir días anteriores.

## Permisos

- El endpoint valida org y membresía server-side (patrón de la mini-API: JWT → perfil → org).
- `member_id` ajeno sin ser admin → 403.
- Los datos de GHL nunca tocan la base directo: viajan a la UI y solo se guardan por el flujo normal de `st_entries` (RLS existente: cada uno lo suyo, admin todo).

## Casos borde

- Cita cancelada/reprogramada → no cuenta como asistencia ni no-show (solo `showed`/`noshow` cuentan; estados intermedios se ignoran).
- Cita sin `assignedUserId` o de un user sin perfil en el tracker → se ignora (no certera).
- Día sin citas → métricas en 0 con `certain:true` (cero certero pisa lo cargado: si GHL dice que no hubo llamadas, no hubo).
- Dos clics seguidos → idempotente (mismo resultado, badges iguales).

## Testing

- Endpoint: casos 401/403/501, día con citas reales de la subcuenta de pruebas (org Maze — Pruebas, calendario `ro6sNtUQPK4y98SDTn6s`), member sin ghl_user_id, member_id ajeno como no-admin.
- UI en dev: autocompletar como closer con citas del día, badge visible, corregir un valor a mano, guardar, recargar y verificar persistencia; botón oculto sin GHL.

## Fuera de alcance

- Job nocturno de auto-carga; webhooks de GHL; autocompletar conversaciones/respuestas/links (nativas, siempre manuales); ofertas (no certera en GHL).
