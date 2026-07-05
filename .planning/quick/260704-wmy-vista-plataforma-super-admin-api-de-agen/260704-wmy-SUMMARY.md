---
phase: quick-260704-wmy
plan: 01
subsystem: platform-admin
tags: [super-admin, ghl, agency-pit, pre-link, platform-view]
requires: [quick-260704-vqc]
provides:
  - st_platform_settings (key/value deny-all para settings globales)
  - GET/POST /api/platform/settings (token de agencia, solo hint)
  - GET /api/platform/locations (buscador de subcuentas de la agencia)
  - POST /api/orgs con location_id (pre-vínculo sin tokens)
  - Estado pending en GET /api/integrations/ghl
  - Guard location_mismatch en oauthCallback
  - Vista Plataforma (renderPlatform) en index.html
affects: [alta-de-orgs, oauth-ghl, configuraciones]
tech-stack:
  added: []
  patterns:
    - "Settings de plataforma en tabla deny-all, solo service role"
    - "Secretos solo como hint ····XXXX en respuestas"
    - "Pick por índice (PLAT_LOC_RESULTS[i]) en vez de inyectar datos GHL en onclick"
key-files:
  created:
    - supabase/migrations/007_platform_settings.sql
  modified:
    - api/server.js
    - index.html
decisions:
  - "Validación EN VIVO del PIT contra locations/search antes de guardarlo"
  - "Fila de st_integrations sin access_token = pending (NO conectada) en todo el server"
  - "pickPlatLoc por índice sobre PLAT_LOC_RESULTS para evitar XSS en atributos onclick"
metrics:
  duration: 14min
  completed: 2026-07-05
---

# Quick Task 260704-wmy: Vista Plataforma super-admin (API de agencia + pre-vínculo de subcuentas) Summary

Vista Plataforma exclusiva del super-admin: token de agencia GHL editable validado en vivo (solo hint ····XXXX sale de la API), buscador de subcuentas reales paginado hasta 300 con anotación linked_org, alta de orgs pre-vinculadas a una subcuenta (fila st_integrations sin tokens) y OAuth que solo puede completar el pre-vínculo (mismatch = rechazo).

## Tareas ejecutadas

| Task | Nombre | Commit | Archivos |
| ---- | ------ | ------ | -------- |
| 1 | Migración st_platform_settings + endpoints /api/platform/* | d3ed2ab | supabase/migrations/007_platform_settings.sql, api/server.js |
| 2 | Pre-vínculo en POST /api/orgs + pending + null-safety + guard mismatch | b17c83d | api/server.js |
| 3 | Vista Plataforma en index.html (rail, renderPlatform, mudanza Organizaciones, buscador) | 49dc745 | index.html |

## Qué se construyó

**Backend (api/server.js):**
- Helpers `getPlatformSetting`/`setPlatformSetting`/`deletePlatformSetting` + `PIT_KEY` (patrón getIntegration, service role).
- `GET /api/platform/settings`: `{agency_pit_set, agency_pit_hint}` — el token completo jamás sale.
- `POST /api/platform/settings`: valida el PIT en vivo con `GET /locations/search?limit=1` antes de guardar; vacío = borrar; logs solo `set`/`cleared` + email.
- `searchAgencyLocations(pit, q)`: pagina hasta 3 páginas de 100, filtra por name/email/id, devuelve `[{id,name,city,country}]`.
- `GET /api/platform/locations?q=`: 409 sin PIT, 502 si GHL falla, anota `linked_org`, capa a 20.
- `createOrg`: `location_id` opcional con validación fail-fast (PIT configurado → existe en agencia → no duplicada) ANTES de crear; pre-vínculo INSERT sin tokens DESPUÉS; warning no-fatal si el INSERT falla.
- `getGhlStatus`: fila sin `access_token` → `{connected:false, pending:true, location_id, location_name}`.
- Null-safety: `getGhlCreds` exige `access_token`; `refreshGhlToken` lanza sin `refresh_token`; `listGhlUsers`/`importGhlUser` responden 409 con fila pending.
- `oauthCallback`: si la fila pre-asignada tiene otro `location_id` → no guarda nada y redirige `?ghl_error=location_mismatch` (log con IDs, jamás tokens).
- Router: 3 rutas nuevas con `requireSuperAdmin` (fail-closed 403).

**Frontend (index.html):**
- Ítem "Plataforma" en el rail (SVG edificio), oculto por defecto; visible solo si `/api/platform/settings` devuelve 200 (best-effort en boot, fail-closed).
- `renderPlatform()`: guard `IS_SUPER`, card "API de agencia HighLevel" (estado + hint, input password siempre editable, guardar vacío = borrar) + `orgsCard()` completa.
- Organizaciones mudada: `renderTeam` ya no renderiza `orgsCard`; los re-renders del ciclo (loadOrgs/createOrg/closeOrgCreds) apuntan a `renderPlatform`.
- Buscador de subcuenta: debounce 400ms, pinta solo `#platLocResults` (no pierde foco), filas con `linked_org` deshabilitadas, chip fijado con ✕, `esc()` en todo dato GHL.
- `createOrg` manda `location_id` si hay selección, limpia `PLAT_LOC_SEL` al crear y muestra el warning del backend.
- `ghlCard` del tenant: branch pending "Subcuenta asignada: X — falta autorizar la conexión" + botón Conectar; banner `admin-lock` si volvió con `location_mismatch`.

**Migración (007_platform_settings.sql):** tabla `st_platform_settings` key/value, RLS habilitada SIN policies (deny-all), idempotente, comentario de seguridad estilo 003.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Seguridad/XSS] pickPlatLoc por índice en vez de (id, name)**
- **Found during:** Task 3f
- **Issue:** El plan pedía `window.pickPlatLoc(id, name)` inyectando datos de GHL en el atributo `onclick`; el HTML decodifica entidades antes de parsear el JS, así que un name con comillas rompería/inyectaría (T-Q1-05).
- **Fix:** Los resultados se guardan en `PLAT_LOC_RESULTS` y el click pasa solo el índice: `pickPlatLoc(i)`. Mismo comportamiento, cero datos GHL en atributos.
- **Files modified:** index.html
- **Commit:** 49dc745

**2. [Rule 3 - Loop de reintento] orgsCard con branch de error explícito**
- **Found during:** Task 3e
- **Issue:** Al quitar el cloak `ORGS_ALLOWED===false → ''` y mantener el lazy `ORGS===null → loadOrgs()`, un fallo de `/api/orgs` dejaba ORGS en null → loop infinito de fetch+re-render.
- **Fix:** `ORGS_ALLOWED===false` muestra "No se pudieron cargar las organizaciones. Recargá la página." (la vista ya es solo super-admin, no hace falta cloak).
- **Files modified:** index.html
- **Commit:** 49dc745

## Verificación

- `node --check api/server.js` → OK; JS inline de index.html extraído y `node --check` → OK.
- Smoke test local (`SUPABASE_URL=http://localhost:9 SERVICE_ROLE_KEY=x ANON_KEY=x`, sin `SUPER_ADMIN_EMAILS`): GET/POST `/api/platform/settings` → 403, GET `/api/platform/locations?q=x` → 403, `/api/health` → 200.
- Greps: migración sin `create policy`; `agency_pit` jamás en `console.log` (solo booleans/status); `orgsCard` ausente de renderTeam; `data-view="platform"` oculto por defecto; `esc()` en name/meta/linked_org del buscador.

## Known Stubs

Ninguno — no quedan placeholders ni datos hardcodeados que bloqueen el objetivo del plan.

## Threat Flags

Ninguna superficie nueva fuera del threat model del plan (T-Q1-01..07 mitigadas según lo planificado).

## Self-Check: PASSED

- Archivos creados/modificados verificados en disco (migración 007, api/server.js, index.html, SUMMARY).
- Commits d3ed2ab, b17c83d y 49dc745 verificados en `git log`.
- SUMMARY intencionalmente NO commiteado (constraint del orquestador); único untracked del worktree.

## Post-merge (orquestador)

1. Aplicar `007_platform_settings.sql` en el Supabase self-hosted.
2. Deploy según el flujo del repo.
3. Seed del agency PIT real vía `POST /api/platform/settings` con sesión super-admin (valor en el vault — JAMÁS commitearlo).
4. QA e2e según la sección `<verification>` del plan.
