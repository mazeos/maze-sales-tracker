---
phase: quick-260708-n5r
plan: 01
subsystem: team-management
tags: [team_mode, roles, enforcement, multi-tenant, security]
requires: [st_orgs.team_mode, st_profiles.role, st_profiles.ghl_user_id]
provides: [role-vs-team_mode-enforcement]
affects: [api/server.js, index.html, supabase/migrations]
tech-stack:
  added: []
  patterns: [defensa-en-profundidad, fail-open-lectura, exencion-GHL]
key-files:
  created:
    - supabase/migrations/016_team_mode_role_enforcement.sql
  modified:
    - api/server.js
    - index.html
decisions:
  - "Mapa modo→roles vive en una fuente por capa (server.js, trigger DB, index.html)"
  - "Import GHL (ghl_user_id no-null) exento del enforcement en todas las capas"
  - "Fail-open a 'full' ante error de lectura del team_mode en backend"
  - "Cero migración de datos: roles legacy-inválidos se conservan"
  - "Panel super-admin no filtra el select (team_mode no está en su scope); seguridad la dan patchOrgMember + trigger"
metrics:
  duration: ~10min
  completed: 2026-07-08
---

# Phase quick-260708-n5r Plan 01: Enforcement de team_mode al asignar rol Summary

Enforcement de `st_orgs.team_mode` (solo/sc/full) sobre `st_profiles.role` en cuatro capas — alta manual, cambio super-admin, trigger DB y frontend — con exención total del import GHL. Corrige el bug 🔴 confirmado 2026-07-08 (el team_mode no se validaba en ninguna capa).

## Tasks completadas (3 de 4 auto; la 4 es checkpoint humano — NO ejecutada)

### Task 1 — Backend (api/server.js) · commit 2e9262e
- `MODE_ROLES` + `roleAllowedForMode(role, mode)` cerca de `VALID_ROLES` (L109). 'admin' siempre válido; fallback a `full`.
- `readTeamMode(orgId)`: GET `st_orgs?select=team_mode` con `svcHeaders()`, fail-open a `'full'` ante error (loguea warning).
- `createMember` (L982): tras el check de `VALID_ROLES`, lee el modo con `admin.org_id` (no del body) y rechaza 400 con el mensaje canónico si el rol no está permitido.
- `patchOrgMember` (L2184, capa NUEVA): valida `body.role` contra `readTeamMode(orgId)` solo cuando `hasRole` — el flujo de `active`-only queda intacto. Ubicado junto a la validación de rol existente.
- `roleAllowedForMode(` aparece 3 veces (def + 2 usos). `node --check` pasa.

### Task 2 — Trigger DB (migración 016) · commit e93c426
- `supabase/migrations/016_team_mode_role_enforcement.sql`: función `public.st_enforce_team_mode_role()` (security definer, search_path=public) + trigger `BEFORE INSERT OR UPDATE OF role ON st_profiles`.
- Orden: admin exento → exención GHL (`ghl_user_id is not null`) → rol sin cambios en UPDATE (`is not distinct from OLD.role`, protege `save()` y legacy) → lee `team_mode` (coalesce `full`) → valida contra el mapa → `raise exception ... errcode 23514` (PostgREST → 400).
- Idempotente (`create or replace` + `drop trigger if exists`). Lógica reutilizada del intento anterior (`backup/trabajo-260708-base-vieja:.../008_...`), idéntica salvo el número.
- **NO aplicada a la DB** (es parte del checkpoint humano).

### Task 3 — Frontend (index.html) · commit 28b6ec7
- `MODE_ROLES` / `allowedRoles(mode)` / `ROLE_MODE_MSG` cerca de `ROLE_LABEL`.
- `roleOpts(sel)`: derivado de `allowedRoles(DB.team.mode)`; si `sel` es legacy-inválido lo incluye igual (selected) para no romper el select ni forzar el cambio.
- `#newRole` (form de alta): opciones desde `allowedRoles(DB.team.mode)`.
- `setMemberRole`: si el nuevo valor difiere del actual y no está permitido → `toast(ROLE_MODE_MSG)`, `renderTeam()` (revierte) y `return`.
- `addMember`: valida el rol antes del POST → `toast` y `return` si es inválido.
- Import GHL (~L1268) NO tocado (exento). Panel super-admin (~L1729): comentado — el `team_mode` no está en el scope del panel (`/api/orgs` solo trae `id,name,created_at`), la seguridad la dan `patchOrgMember` + el trigger.
- `allowedRoles(DB.team.mode)` aparece 4 veces (≥3 requerido).

## Deviations from Plan

None - las 3 tasks auto se ejecutaron exactamente como estaban escritas. Se confirmó (como el plan anticipaba en el paso 7 de Task 3) que el panel super-admin no tiene el `team_mode` en su scope, por lo que se dejó el select sin filtrar y se documentó con comentario.

## Checkpoint pendiente (Task 4 — human-verify, BLOCKING)

NO ejecutado por diseño. Requiere acción humana:
1. Aplicar la migración `016_team_mode_role_enforcement.sql` en Supabase.
2. Reiniciar la mini-API para tomar `server.js`.
3. Verificar los 6 escenarios (alta manual, cambio de rol, exención GHL, borde modo restrictivo). Ver `<how-to-verify>` en el PLAN.

## Self-Check: PASSED
- api/server.js: `node --check` OK; MODE_ROLES/roleAllowedForMode/readTeamMode presentes; roleAllowedForMode( ×3.
- supabase/migrations/016_team_mode_role_enforcement.sql: existe; contiene st_enforce_team_mode_role, exención GHL, guarda is-not-distinct, trigger before insert/update of role.
- index.html: MODE_ROLES/allowedRoles/ROLE_MODE_MSG presentes; allowedRoles(DB.team.mode) ×4.
- Commits verificados: 2e9262e, e93c426, 28b6ec7 en feature/team-mode-enforcement.
