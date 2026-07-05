---
phase: quick-260704-vqc
plan: 01
subsystem: platform-admin
tags: [super-admin, multi-tenant, provisioning, organizaciones]
requires: []
provides:
  - "GET/POST /api/orgs gateados por requireSuperAdmin (env SUPER_ADMIN_EMAILS)"
  - "Sección Organizaciones al final de Configuraciones (solo super-admins)"
affects: [api/server.js, index.html]
tech-stack:
  added: []
  patterns:
    - "requireSuperAdmin: auth de plataforma por email en env, sin dependencia de st_profiles"
    - "Card condicional fail-closed en UI: null=no consultado, false=no renderizar nada"
key-files:
  created: []
  modified: [api/server.js, index.html]
decisions:
  - "Lista SUPER_ADMIN_EMAILS vacía = fail-closed 403 sin llamar a la red (habilita smoke test local)"
  - "Password autogenerada: 14 chars base64url sin caracteres confusos, viaja UNA vez solo si generated && createdAuth"
  - "Cuentas del GoTrue compartido sin st_profile se adoptan (jamás se toca su contraseña); con perfil en otra org → 409"
metrics:
  duration: ~12 min
  completed: 2026-07-05
---

# Quick Task 260704-vqc: Panel super-admin de Organizaciones Summary

Alta de tenants (org + admin) desde la UI, visible solo para super-admins de Maze vía `SUPER_ADMIN_EMAILS`, con rollback total en fallos y credenciales de un solo uso.

## Task Commits

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Backend — requireSuperAdmin + GET/POST /api/orgs | 952a6d0 | api/server.js |
| 2 | Frontend — sección Organizaciones en Configuraciones | c6b81a5 | index.html |

## What Was Built

**Backend (`api/server.js`):**
- `SUPER_ADMINS`: parseo único de `SUPER_ADMIN_EMAILS` (split coma, lowercase, trim, sin vacíos). Cero emails en el código (repo público).
- `requireSuperAdmin(req)`: lista vacía → 403 inmediato sin red; bearer → GoTrue `/auth/v1/user` (lee `user.email` además de `user.id`, no reusa `checkUserToken`); sin match → 403 "Solo el equipo de Maze puede gestionar organizaciones". No toca `st_profiles`.
- `GET /api/orgs`: 3 fetches masivos (st_orgs, st_profiles, st_integrations con select limitado a `org_id,location_name` — tokens jamás) + emails de admins vía `getAuthEmail` con un Map cache por request. Devuelve `{orgs:[{id,name,created_at,members_active,ghl_connected,ghl_location_name,admins}]}`.
- `POST /api/orgs`: validaciones 400 → crear org (defaults de schema para tz/team_mode) → resolver auth user con las 3 ramas de duplicado:
  - sin match en GoTrue → rollback org + 500 genérico (no filtra info del auth compartido)
  - con st_profile en alguna org → rollback org + 409 "Ese email ya pertenece a otro equipo del tracker"
  - sin perfil → adopción de la cuenta (`existing_account:true`, contraseña intacta)
  - fallo del perfil admin → rollback doble: org siempre, auth user SOLO si `createdAuth` (cuentas adoptadas jamás se borran)
- Password autogenerada: loop de `crypto.randomBytes(24).toString('base64url')` filtrando `/[-_0OoIl1]/g` hasta 14 chars. `admin_password` en la respuesta SOLO si `generated && createdAuth`. Jamás en logs.

**Frontend (`index.html`):**
- Estado: `ORGS, ORGS_ALLOWED (null/false/true), ORGS_LOADING, ORG_CREATED, ORG_CREATING`.
- `loadOrgs()`: carga lazy patrón `loadGhlStatus`; 401/403 y cualquier error → `ORGS_ALLOWED=false` silencioso (fail-closed, sin toast).
- `orgsCard()`: devuelve `''` si `ORGS_ALLOWED!==true` (ni el título se renderiza). Contiene: box de credenciales de un solo uso (URL `location.origin` + email + contraseña solo si el backend la devolvió; variante existing_account "entra con su contraseña de siempre"; aviso "no se vuelven a mostrar"; Copiar con fallback textarea; ✕ para cerrar), tabla `rollup` (Nombre|Miembros|HighLevel|Admins, todo por `esc()`), form de alta con hint "dejá vacío para autogenerar".
- `window.createOrg`: validación client-side, guard anti doble-submit, POST con Bearer, en éxito guarda `ORG_CREATED` (solo memoria) y re-dispara `loadOrgs()`; errores → toast con `data.error` (cubre el 409).
- Composición: `${orgsCard()}` al final de `renderTeam()`, después de `${ghlTeamCard()}`.

## Deviations from Plan

**1. [Adaptación menor] Verify de Task 2 apuntaba al repo principal**
- **Found during:** Task 2 verification
- **Issue:** el comando de verify del plan usaba rutas absolutas a `/Users/alevogeler/maze-sales-tracker/index.html` (repo principal), pero la ejecución corre en el worktree.
- **Fix:** mismos greps sobre el `index.html` del worktree. Resultados: orgsCard=2, api=2, createOrg=2.
- **Commit:** c6b81a5

**2. [Entorno] Puerto 3999 ocupado en el smoke test**
- **Found during:** Task 1 verification
- **Issue:** el puerto 3999 del verify estaba tomado por un proceso ajeno (server viejo sin /api/orgs → 404).
- **Fix:** mismo smoke test en el puerto 4187 → GET=403 y POST=403 con body `{"error":"Solo el equipo de Maze puede gestionar organizaciones"}`.
- **Commit:** 952a6d0

Ninguna desviación de lógica: el plan se implementó tal cual.

## Verification Results

- `node --check api/server.js` → OK
- API arrancada con envs dummy SIN `SUPER_ADMIN_EMAILS`: GET y POST `/api/orgs` → **403** (fail-closed)
- `grep "SUPER_ADMIN" api/server.js` → solo referencias a la env, cero emails hardcodeados
- Ningún `console.log` incluye la variable de la contraseña (los 7 logs del flujo /api/orgs auditados)
- Script inline de `index.html` extraído y validado con `node --check` → OK
- Sin SSH, sin deploy, sin migraciones (cumple constraints)

## Known Stubs

None — no hay placeholders ni datos hardcodeados; toda la sección se alimenta de `/api/orgs`.

## Threat Flags

None — toda la superficie nueva (`GET/POST /api/orgs`) estaba en el threat model del plan (T-vqc-01..05) y sus mitigaciones se implementaron.

## Post-merge (pendiente del orquestador)

1. Agregar `SUPER_ADMIN_EMAILS` al `.env` del entorno de pruebas.
2. Deploy (patrón habitual del VPS).
3. QA e2e según la sección `<output>` del plan (login super-admin, alta de prueba, 409 con email de otra org, invisibilidad para el admin de Clara, limpieza).

## Self-Check: PASSED

- SUMMARY.md existe (sin commitear, según constraints)
- Commit 952a6d0 verificado en git log
- Commit c6b81a5 verificado en git log
