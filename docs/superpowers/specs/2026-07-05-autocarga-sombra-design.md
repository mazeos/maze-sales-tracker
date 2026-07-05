# Diseño — Auto-carga con modo sombra y calibración KPI por KPI

**Fecha:** 2026-07-05
**Proyecto:** Maze Sales Tracker IA (`/docker/maze-sales-tracker-dev`)
**Estado:** Aprobado por Alejandro (brainstorming + tests de calibración en vivo, sesión 2026-07-05)
**Depende de:** integración OAuth GHL por org (con scope `conversations.readonly`, app v2.0.0), Caja/cuotas, botón Autocompletar

## Problema

El tracker depende de que cada miembro cargue sus números a mano. GHL ya sabe gran parte de esa actividad con certeza. Objetivo: medición automática del tracker diario — sin inventar jamás un número (principio "híbrido siempre").

## Concepto central: modo sombra + graduación

1. **Modo sombra**: un job nocturno calcula, para cada miembro y día, el valor automático de cada KPI candidato y lo guarda JUNTO al valor cargado a mano — sin tocar los contadores.
2. **Panel de calibración** (vista para admin/super-admin): por KPI muestra día a día `valor GHL vs valor cargado` y el % de coincidencia.
3. **Graduación MANUAL**: cuando Alejandro/el admin ve un KPI estable, prende su switch. Graduado = el job escribe el valor en `st_entries` cada noche, **el contador sigue editable** (badge "auto"); una corrección manual manda y queda registrada.
4. Un KPI que nunca calibra se queda manual para siempre — el sistema es honesto por diseño.

**Prioridad de Ale: los KPIs del setter son los más relevantes.** El motor nace midiendo closer + setter; triage después.

## Validación previa (2026-07-05, prototipo `sombra.js` en `/root/` del VPS)

11 KPIs calibrados contra escenarios simulados (citas creadas/mutadas por API) y datos reales (DMs de Ale): llamadas, asistencias, no_shows, cancelados, segundas, cita-borrada, outbound, inbound_ig, respuestas, seguimientos, cierres/cash. Hallazgos de ingeniería:

- **GHL no respeta `startTime`/`endTime`** del query de eventos → SIEMPRE re-filtrar fechas client-side, en la TZ de la org.
- Un miembro puede tener **distintos usuarios GHL** para calendario y conversaciones (caso real de Ale) → el vínculo `ghl_user_id` debe apuntar al usuario correcto por fuente; si hiciera falta, vínculo secundario.
- Humano vs automatización: `source` del mensaje (`app` = humano, `workflow` = automation) — la actividad del Setter IA no contamina.
- El OAuth no tiene `calendars/events.write` (no lo necesita el motor: solo lectura).
- "Desconectar" la integración borra `calendar_id` → al reconectar hay que re-elegir calendario.

## Diccionario de medición (regla exacta por KPI)

🟢 certero (testeado) · 🟡 a calibrar · 🔴 manual por diseño

**Closer:** llamadas 🟢 (citas del día del calendario de llamadas, asignadas a su ghl_user_id, no canceladas/inválidas/borradas) · asistencias 🟢 (`showed`) · no_shows 🟢 (`noshow`) · cancelados 🟢 (`cancelled`) · segundas 🟢 (cita válida de hoy cuyo contacto tuvo cita **showed** en 30 días previos) · disponibilidad 🟡 (**config del calendario + disponibilidad del usuario**: cupos ofrecidos ese día según horarios y duración de slot — no free-slots en vivo) · cierres/cash_nuevo/reservas/revenue 🟢 (st_sales del día) · cash_cuotas 🟢 (Σ paid_amount de cuotas cobradas hoy de sus ventas) · ofertas 🔴 · referidos 🔴.

**Setter** (conversaciones GHL asignadas a su ghl_user_id; solo mensajes humanos `source:app`; canal = tipo de conversación): outbound 🟢 (conversación cuyo PRIMER mensaje histórico es saliente humano de hoy) · inbound_ig 🟢 (**personas**: conversaciones IG únicas con inbound hoy — no mensajes) · inbound_wpp_tk / inbound_wpp_ig 🟡 (ídem WhatsApp; split tk/ig por **número de línea**, config por org) · respuestas 🟢 (conversaciones con inbound de hoy posterior a un saliente humano previo) · seg_ig/seg_wpp 🟢 (saliente humano de hoy en conversación no abierta hoy, por canal) · links_ig/links_wpp 🟡 (saliente humano de hoy que contiene el **dominio de agenda de la subcuenta** — config por org, regla de Ale) · bienvenidas 🟡 (envíos ManyChat, calibrar cómo aparecen) · agend_ig/agend_wpp 🔴 (GHL no atribuye quién agendó) · cta 🔴.

**Triage:** agendadas/asistencias/no_shows 🟡 (mismo motor de citas sobre un **calendario de triage** por org — config nueva) · pases 🔴 (futuro: pipeline stages).

## Arquitectura

**Datos:**
- `st_shadow_metrics` — una fila por org × member × fecha × kpi: `{auto_value, manual_value_al_momento, computed_at}`. Solo la escribe el job (service role). RLS: SELECT org, sin escritura de clientes.
- `st_kpi_config` — por org × kpi: `{status: 'sombra'|'auto'|'off', config jsonb}` (config: dominio de agenda, mapa números WhatsApp→canal, calendario de triage). Escribe solo admin.
- Graduado: el job upsertea el valor en `st_entries.metrics[kpi]` con marca `_auto: [kpis]` para el badge; edición manual pisa y el diff queda visible en el panel.

**Motor (worker nocturno):**
- Proceso Node en el compose del tracker (patrón mini-API, sin deps), corre a las 23:45 TZ de cada org + recalcula el día anterior (reconciliación de citas que cambian de estado tarde).
- Por org con GHL conectado: resuelve miembros con `ghl_user_id`, calcula todos los KPIs candidatos (lógica portada de `sombra.js`), guarda sombra, y escribe en `st_entries` SOLO los KPIs graduados.
- Paginación completa de conversaciones (el prototipo usaba límite 100) + rate-limit friendly (throttle, reintentos).
- El botón ⚡ Autocompletar existente queda como refresco manual bajo demanda; comparte la misma lógica de cálculo (una sola fuente de verdad en el código).

**Panel de calibración (UI, vista Plataforma o Configuraciones-admin):**
- Tabla por KPI: últimos N días, `auto vs manual`, % match, racha de días iguales.
- Switch por KPI (sombra → auto). Chip de estado en Cargar día para KPIs graduados (badge "auto").

## Fases

- **A — Motor sombra + panel (closer + setter):** tablas, worker nocturno, panel de calibración, todos los KPIs 🟢/🟡 de closer y setter en sombra. Config por org: dominio de agenda + mapa de líneas WhatsApp.
- **B — Graduación:** switch por KPI, escritura en st_entries con badge "auto", editable siempre.
- **C — Triage + disponibilidad:** calendario de triage por org, disponibilidad desde config del calendario, bienvenidas si calibra.

## Fuera de alcance

- Webhooks de GHL (el pull nocturno + botón alcanza; webhooks = optimización futura).
- Automatizar ofertas, referidos, pases, cta, agend_* (deshonesto por diseño).
- Graduación automática por regla (siempre la prende un humano).

## Testing

- La lógica de cálculo portada de `sombra.js` se verifica contra los mismos escenarios ya calibrados (citas simuladas vía API con PIT + DMs reales).
- El modo sombra ES el test permanente del sistema: días de discrepancia son visibles antes de graduar.
