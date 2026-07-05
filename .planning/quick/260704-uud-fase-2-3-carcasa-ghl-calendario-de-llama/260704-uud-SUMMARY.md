---
phase: quick-260704-uud
plan: 01
subsystem: ventas-ghl
tags: [ghl, calendario, multi-tenant, integraciones]
requires: [st_integrations (003), ghl_user_id en st_profiles (004), módulo Ventas-GHL (005)]
provides:
  - Columnas calendar_id/calendar_name en st_integrations (migración 006)
  - GET /api/ghl/calendars (calendarios filtrados a closers sincronizados)
  - POST /api/integrations/ghl/calendar (guardar/desconfigurar con validación server-side)
  - Resolución de calendario por org en ghlLeads (org → env GHL_CALENDAR → 501)
  - Bloque UI "Calendario de llamadas" en la card de integración
affects: [api/server.js, index.html, supabase/migrations]
tech-stack:
  added: []
  patterns: [validación server-side del body contra lista re-obtenida, carga lazy de estado UI (patrón loadGhlStatus), fallback env para instancias dedicadas]
key-files:
  created: [supabase/migrations/006_integration_calendar.sql]
  modified: [api/server.js, index.html]
decisions:
  - "Solo se listan calendarios con algún closer sincronizado en teamMembers (decisión de Alejandro: no listar todos los de la location)"
  - "Modo PIT (instancia dedicada) no persiste calendario en DB: se maneja por env GHL_CALENDAR; el POST responde 409 sin integración OAuth"
  - "getGhlCreds devuelve la fila de integración junto a las creds para evitar doble getIntegration"
metrics:
  duration: ~12 min
  completed: 2026-07-05
  tasks: 2/2
  commits: [d0eb121, 3973512]
---

# Quick Task 260704-uud: Fase 2.3 — Calendario de llamadas por org Summary

**One-liner:** El calendario de llamadas del módulo Ventas-GHL pasa de env global (GHL_CALENDAR) a configurable por org desde Configuraciones, con select filtrado server-side a calendarios atendidos por closers sincronizados y fallback al env para instancias dedicadas (modo PIT).

## Tareas completadas

| Task | Nombre | Commit | Archivos |
| ---- | ------ | ------ | -------- |
| 1 | Migración 006 + endpoints de calendario + resolución por org en ghlLeads | d0eb121 | supabase/migrations/006_integration_calendar.sql, api/server.js |
| 2 | Bloque "Calendario de llamadas" en la card de integración | 3973512 | index.html |

## Qué se construyó

### Backend (api/server.js)
- **`getGhlCreds` extendido**: devuelve `{ token, locationId, integration }` (integration=null en modo PIT). Los callers existentes (`ghlLeads`, `salesGhl`) no se rompen; `ghlLeads` lee `creds.integration.calendar_id` sin segunda llamada a `getIntegration`.
- **`listOrgCalendars(creds, orgId)`**: lee closers sincronizados (`role=closer`, `active !== false`, `ghl_user_id` no nulo) con la service key; si no hay ninguno corta ANTES de llamar a GHL (`sinClosers: true`). Con closers, pide `GET /calendars/?locationId=` (Version 2021-04-15) y filtra a calendarios cuyo `teamMembers[].userId` matchea algún closer. Respuesta mínima: `{id, name, closers}` — sin teamMembers crudos ni tokens.
- **`GET /api/ghl/calendars`** (requireAdmin): 502 si falla el refresh o GHL, 409 sin creds, 200 con `{calendars, selected, selected_name, hint?}`.
- **`POST /api/integrations/ghl/calendar`** (requireAdmin): body vacío → desconfigura (calendar_id/calendar_name a null, idempotente). Con calendar_id → re-obtiene la lista filtrada server-side y valida pertenencia (400 "Ese calendario no está disponible" si no está); persiste `cal.id` + `cal.name` de la respuesta de GHL, nunca del body. Ambos caminos invalidan `leadsCache` de la org. 409 en modo PIT (sin fila donde persistir).
- **`ghlLeads`**: `calendarId = (creds.integration && creds.integration.calendar_id) || GHL_CALENDAR`; sin ninguno → 501 "Elegí el calendario de llamadas en Configuraciones → Integración HighLevel".

### Migración (006_integration_calendar.sql)
Dos `add column if not exists` (`calendar_id text`, `calendar_name text`) en `st_integrations`. Idempotente. RLS/permisos intactos (deny-all).

### UI (index.html)
- Estado `GHL_CALS`/`GHL_CALS_LOADING` + `loadGhlCalendars()` (patrón exacto de `loadGhlStatus`).
- `ghlCalendarBlock()` renderizado en la rama conectada de `ghlCard()` (solo admin), entre el "✅ Conectado…" y Desconectar: loading → error (muestra `msg` del server si existe) → hint sin closers → select `.chip` con "— Sin configurar —" + opciones `{name} · {closers}` (todo por `esc()`), preselección de `selected`, botón Guardar.
- `saveGhlCalendar()`: POST con Bearer, actualiza `GHL_CALS.selected/selected_name`, toasts "Calendario guardado" / "Calendario sin configurar" / error del server.
- Reset `GHL_CALS=null` en la rama ok de `disconnectGhl`.

## Verificación

- `node --check api/server.js` ✅
- API arranca con env dummy y SIN env GHL (modo manual) ✅
- Sin Authorization: `GET /api/ghl/calendars` → 401, `POST /api/integrations/ghl/calendar` → 401, `/api/health` → ok ✅
- Migración 006 con ambos `add column if not exists`, sin tocar RLS ✅
- `GHL_CALENDAR` queda SOLO como fallback dentro de ghlLeads ✅
- "Ese calendario no está disponible" + `leadsCache.delete` presentes ✅
- Inline script de index.html parsea como ESM (`node --check`) ✅
- Diff sin secretos ni IDs de tenants (repo público) ✅

Nota de verificación: el puerto 3999 del comando de verificación del plan estaba ocupado por un proceso viejo del server (respondía 404 en las rutas nuevas); se re-verificó en el puerto 4177 con resultado limpio.

## Deviations from Plan

None - plan executed exactly as written. (Único ajuste operativo: puerto de verificación 3999 → 4177 por proceso stale, no afecta el código.)

## Known Stubs

Ninguno. Los flujos quedan cableados end-to-end; el fallback env es intencional (modo PIT/instancia dedicada, documentado en el plan).

## Threat Flags

Ninguno fuera del threat model del plan: los dos endpoints nuevos están cubiertos por T-uud-01..05 (requireAdmin, validación server-side del body, respuesta mínima sin tokens, corte pre-GHL sin closers, esc() en el render).

## Post-merge (orquestador — pendiente, NO lo hace el ejecutor)

1. Correr `006_integration_calendar.sql` en el Supabase self-hosted.
2. Deploy a `sales-tracker-test`.
3. QA e2e según la sección `<output>` del plan (select filtrado, persistencia, leads del calendario elegido, hint sin closers, desconfigurar → fallback env, instancia PIT intacta).

## Self-Check: PASSED

- supabase/migrations/006_integration_calendar.sql: FOUND
- api/server.js (rutas nuevas): FOUND
- index.html ("Calendario de llamadas"): FOUND
- Commit d0eb121: FOUND
- Commit 3973512: FOUND
