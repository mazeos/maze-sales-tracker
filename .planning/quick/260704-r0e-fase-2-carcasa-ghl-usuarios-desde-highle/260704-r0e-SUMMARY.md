---
phase: quick-260704-r0e
plan: 01
subsystem: integraciones-ghl
tags: [ghl, oauth, usuarios, import, password, multi-tenant]
requires:
  - quick-260704-p9c (Fase 1 OAuth: st_integrations + refreshGhlToken + checkAdminToken)
provides:
  - Migración 004: st_profiles.ghl_user_id + índice único parcial
  - GET /api/ghl/users (lista con estado + reconciliación GHL-manda)
  - POST /api/ghl/users/import (reactivar / vincular / crear)
  - POST /api/me/password (cambio de contraseña del propio usuario)
  - UI "Equipo desde HighLevel" + modal "Cambiar mi contraseña"
affects:
  - Futura fase de auto-carga GHL (usa ghl_user_id como vínculo perfil↔usuario GHL)
tech-stack:
  added: []
  patterns:
    - checkUserToken extraído de checkAdminToken (auth de usuario sin exigir admin)
    - fetchGhlUsers helper (refresh token + GET users, excluye deleted)
    - getAuthEmail con cache Map por request (GoTrue admin)
key-files:
  created:
    - supabase/migrations/004_ghl_user_id.sql
  modified:
    - api/server.js
    - index.html
decisions:
  - "D-01..D-04 del plan aplicadas tal cual: import explícito por fila, rol elegido por admin, Location ID = password inicial, GHL como última palabra (baja automática)"
  - "El dup de email en import responde 409 'Ese email ya tiene cuenta en otra organización' (mismo patrón regex de createMember)"
  - "La reconciliación es best-effort por perfil: si un PATCH falla se loguea y se sigue, sin abortar la respuesta"
metrics:
  duration: 7 min
  completed: 2026-07-04
  tasks: 3
  commits: 3
---

# Quick Task 260704-r0e: Fase 2 carcasa GHL — Usuarios desde HighLevel Summary

Import de usuarios de la subcuenta GHL como miembros del tracker con Location ID como contraseña inicial, reconciliación donde GHL manda (baja automática + aviso) y cambio de contraseña self-service para cualquier usuario.

## Qué se construyó

### Task 1 — Migración 004 + endpoints en la mini-API (commit `2d55450`)

- **`supabase/migrations/004_ghl_user_id.sql`**: `ghl_user_id text` en `st_profiles` + índice único parcial `st_profiles_ghl_user_id_key` (`where ghl_user_id is not null`). Idempotente, estilo 002/003. **NO aplicada a ninguna base — la aplica el orquestador post-merge.**
- **`checkUserToken(bearerToken)`**: refactor sin cambio de comportamiento — el paso 1 de `checkAdminToken` (validación JWT contra GoTrue) extraído como helper reutilizable; `checkAdminToken` lo consume y agrega el paso 2 (perfil + role=admin).
- **`getIntegration(orgId)`**: fila completa de `st_integrations` con service key; null en error (solo server-side, jamás al browser).
- **`GET /api/ghl/users`** (requireAdmin): 409 sin integración → refresh token (502 si falla) → lista GHL sin deleted → estado por usuario (`importado`/`inactivo`/`vinculable`/`nuevo`, emails case-insensitive solo para perfiles sin ghl_user_id, cache Map por request) → **reconciliación D-04**: perfiles importados activos que ya no están en GHL → `active=false` + ban `87600h` (best-effort), nombres en `removed`. Respuesta: `{access_code, users, removed}` — nunca tokens.
- **`POST /api/ghl/users/import`** (requireAdmin): valida `role` en setter/triage/closer/**admin** → re-consulta la lista GHL server-side (jamás confía en name/email del body) → según el caso: **reactivar** (PATCH active=true + unban `ban_duration:'none'`), **vincular** (PATCH solo ghl_user_id, password intacta) o **crear** (auth user con `password = location_id`, `email_confirm:true`, perfil con rollback exacto de createMember; dup → 409).
- **`POST /api/me/password`** (checkUserToken, sin exigir admin): min 8 caracteres, `PUT /auth/v1/admin/users/{uid}` con el uid del JWT — nadie puede cambiar la contraseña de otro.

### Task 2 — UI "Equipo desde HighLevel" (commit `54d32b8`)

- Sección en Configuraciones debajo de `ghlCard()`, visible solo si `IS_ADMIN && GHL_STATUS.connected`.
- **Box del código de acceso**: Location ID en monospace + botón Copiar (`navigator.clipboard` con fallback textarea + `execCommand('copy')`) + texto explicando que es la contraseña inicial.
- **Tabla de usuarios**: nombre, email, chip de estado (`.pill.st-*` con overrides light para `st-nuevo`/`st-vinculable`), selector de rol (default setter, incluye Admin) y acción por fila (Importar/Vincular/Reactivar; importados muestran ✓ sin controles). Todo dato GHL pasa por `esc()`.
- **Aviso de bajas**: banner estilo `.admin-lock` con N y nombres cuando `removed` no viene vacío; tras bajas se recarga el equipo local (`loadFromSupabase`).
- `disconnectGhl` resetea `GHL_USERS`/`GHL_REMOVED` para no mostrar datos viejos al reconectar.

### Task 3 — Modal "Cambiar mi contraseña" (commit `71d2315`)

- Ítem de candado en el rail (`data-action="password"`, junto a logout) visible para **cualquier** usuario logueado — fuera del gating IS_ADMIN.
- Modal lazy con el patrón `.drill-overlay`/`.drill` (click afuera y ✕ cierran): dos inputs password, validación client-side (min 8 + coincidencia, toasts sin cerrar), submit a `POST /api/me/password` con Bearer JWT, botón deshabilitado durante el request.

## Verificación

- `node --check api/server.js` limpio; script inline de index.html extraído y parseado con `node --check` limpio.
- API arranca sin env GHL (log "modo manual"): `/api/health` 200, `/api/ghl/users` 401, `/api/ghl/users/import` 401, `/api/me/password` 401, `/api/oauth/start` 503.
- Greps de artefactos: "Equipo desde HighLevel", `fetch('/api/ghl/users'`, `loadGhlUsers`, `importGhlUser`, `openPasswordModal`, `fetch('/api/me/password'`, `data-action="password"` — todos presentes.
- Migración 004 idempotente (`add column if not exists` + `create unique index if not exists ... where ghl_user_id is not null`).
- Scan de secretos sobre el diff completo del feature: sin tokens/keys hardcodeados (repo público).

## Deviations from Plan

**1. [Menor] Un commit atómico por task en vez de un único commit final**
- **Found during:** Task 3 (el plan pedía un solo commit con los 3 archivos)
- **Issue:** El protocolo del ejecutor exige commit atómico por task; el verify del plan (`git log -1` con los 3 archivos) asumía commit único.
- **Fix:** 3 commits atómicos (2d55450 migración+API, 54d32b8 UI equipo, 71d2315 modal password). Los 3 archivos del plan están commiteados; mismo resultado neto.
- **Files modified:** —
- **Commits:** 2d55450, 54d32b8, 71d2315

**2. [Rule 3 - Blocking] Proceso stale en el puerto 3999 durante la verificación**
- **Found during:** Task 1 (verificación local)
- **Issue:** Un server viejo (sin las rutas nuevas) ocupaba el puerto 3999 y respondía 404, falseando la verificación.
- **Fix:** Kill del proceso stale y re-verificación en puertos 4111/4112 — 401/503 coherentes.
- **Files modified:** ninguno (solo entorno local)

## Known Stubs

Ninguno — no hay placeholders ni datos hardcodeados que bloqueen el goal. La sección solo aparece con org conectada; sin conexión la UI existente de Fase 1 ya cubre el estado.

## Threat Flags

Ninguno fuera del threat model del plan: los endpoints nuevos (`/api/ghl/users`, `/api/ghl/users/import`, `/api/me/password`) están todos registrados y mitigados en el STRIDE register (T-q2-01..07).

## Pendiente para el orquestador (post-merge)

1. Aplicar `supabase/migrations/004_ghl_user_id.sql` en el supabase-db del VPS.
2. Deploy a `sales-tracker-test`.
3. QA e2e con la org "Maze — Pruebas" (Ale / Guillermo / Quantom): cargar lista → importar con rol setter → login con email + Location ID → cambiar contraseña → verificar reconciliación.

## Self-Check: PASSED

- `supabase/migrations/004_ghl_user_id.sql` — FOUND
- `api/server.js` con `/api/ghl/users`, `getIntegration`, `checkUserToken` — FOUND
- `index.html` con "Equipo desde HighLevel" y `openPasswordModal` — FOUND
- Commits 2d55450, 54d32b8, 71d2315 — FOUND en `git log`
