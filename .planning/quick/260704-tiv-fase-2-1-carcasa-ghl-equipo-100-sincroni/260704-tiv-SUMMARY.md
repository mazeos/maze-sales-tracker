---
phase: quick-260704-tiv
plan: 01
subsystem: ghl-integration
tags: [ghl, import, gotrue, auth-compartido, equipo, ui]
requires: [quick-260704-r0e]
provides:
  - "importGhlUser resuelve email duplicado contra GoTrue admin: vincular / rechazar por otra org / adoptar cuenta existente (existing_account:true)"
  - "Alta manual condicionada a GHL_STATUS.connected en renderTeam (con conexión, equipo 100% sincronizado desde HighLevel)"
affects: [api/server.js, index.html]
tech-stack:
  added: []
  patterns:
    - "Lookup GoTrue admin por email exacto: listado paginado (hasta 10x100) + filtro client-side, sin depender de ?filter="
    - "Adopción de auth user compartido: crear st_profile sobre uid existente sin tocar contraseña ni rollback DELETE"
key-files:
  created: []
  modified: [api/server.js, index.html]
decisions:
  - "Con GHL conectado, los únicos usuarios posibles son los sincronizados desde GHL — alta manual oculta en UI (decisión Alejandro 2026-07-04, no revisitar)"
  - "Email en auth compartido sin st_profile ≠ otra organización del tracker: se adopta la cuenta (caso mazefunnels@gmail.com)"
  - "Sin match del email en el listado admin → 500 genérico (no filtrar existencia de cuentas de otras apps)"
metrics:
  duration: "~6 min"
  completed: "2026-07-05T00:25:00Z"
  tasks: 2
  files: 2
---

# Quick Task 260704-tiv: Fase 2.1 carcasa GHL — equipo 100% sincronizado + fix import Summary

**One-liner:** El import GHL ahora resuelve emails duplicados contra GoTrue admin (vincula, rechaza solo si es de otra org del tracker, o adopta la cuenta preexistente con `existing_account:true` sin tocar su contraseña), y con GHL conectado la UI oculta el alta manual dirigiendo a "Equipo desde HighLevel".

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | importGhlUser — resolver email duplicado contra GoTrue admin | 08c3f3c | api/server.js |
| 2 | Aviso existing_account + alta manual condicionada a GHL conectado | db70a00 | index.html |

## What Was Built

### Task 1 — api/server.js
- **Helper `findAuthUserByEmail(emailNorm)`** (junto a `getAuthEmail`): busca el auth user por email exacto vía `GET /auth/v1/admin/users?page=N&per_page=100` con `svcHeaders()`. Loop de página 1 a 10, corte al encontrar match (`u.email.toLowerCase().trim() === emailNorm`), corte si la página trae <100 usuarios. Errores de red/status → `null`. Comentario en código explicando por qué listado + filtro client-side y no `?filter=` (depende de la versión de GoTrue).
- **Rama de duplicado de `importGhlUser`** (misma condición 422/409/regex): ya no responde 409 directo. Ahora:
  - Sin match en el listado → log `email_dup_sin_match` + 500 genérico ("No se pudo crear el usuario. Inténtalo de nuevo.") — no filtra info del auth compartido (T-tiv-01).
  - Perfil del uid en **otra org** → 409 "Ese email ya pertenece a otro equipo del tracker" (T-tiv-02: org_id siempre del JWT).
  - Perfil en **esta org** → PATCH `ghl_user_id` (+ `name` solo si faltaba, + `active:true` si estaba inactivo) y PUT `ban_duration:'none'` best-effort → `{ok:true, linked:true}`.
  - **Sin perfil en ninguna org** (caso `mazefunnels@gmail.com`) → INSERT de `st_profiles` sobre el uid existente → 200 con `{...created, existing_account:true}`. Contraseña/atributos del auth user JAMÁS tocados; si el INSERT falla, NO se ejecuta el rollback DELETE (T-tiv-03) — solo 500 "No se pudo guardar el perfil del miembro."
- `createMember` y las ramas (a) reactivar / (b) vincular quedaron intactas.

### Task 2 — index.html
- **`window.importGhlUser`**: si `data.existing_account`, toast largo (7s): "Importado. Ojo: ya tenía cuenta, entra con su contraseña de siempre (no con el código de acceso)". Resto de la rama (`loadFromSupabase()` + `loadGhlUsers()`) sin cambios.
- **`renderTeam()`**: bloque "Agregar miembro" extraído a consts locales (`addMemberForm` / `addMemberHint` / `addMemberBox`). Siendo admin: con `GHL_STATUS && GHL_STATUS.connected` se renderiza el hint («El equipo se sincroniza desde HighLevel. Importá miembros desde "Equipo desde HighLevel".») en vez del form; con `GHL_STATUS === null` (cargando) o `connected:false` el form queda idéntico al anterior.
- `window.addMember`, `window.delMember` y el botón "Quitar" intactos — la baja manual sigue disponible siempre.
- **Refresco verificado (solo lectura, sin cambios):** `loadGhlStatus()` re-llama `renderTeam()` en su `finally` cuando `state.view==='team'`; `disconnectGhl` setea `{connected:false}` + `renderTeam()`; conectar pasa por redirect OAuth con reload completo.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Funcionalidad crítica menor] `toast()` extendido con duración opcional**
- **Found during:** Task 2
- **Issue:** `toast(msg)` no aceptaba duración; el aviso existing_account (larguísimo) desaparecía en 1.8s — ilegible. El plan pedía duración larga "si acepta parámetro".
- **Fix:** `toast(msg,ms)` con default `ms||1800` — cero impacto en las llamadas existentes, sin modal.
- **Files modified:** index.html
- **Commit:** db70a00

## Verification

- `node --check api/server.js` → OK.
- API arranca con env dummy SIN env GHL: log "La API arranca en modo manual" + `/api/health` → `{"ok":true}` (puerto 4123; el 3999 del plan estaba ocupado por un proceso ajeno preexistente).
- `grep existing_account` presente en api/server.js (rama adopción) e index.html (handler import).
- `grep "Ese email ya pertenece a otro equipo del tracker"` → api/server.js:836.
- Condición `GHL_STATUS && GHL_STATUS.connected` en renderTeam (index.html:1250); `window.addMember` (1271) y `window.delMember` (1291) definidos sin cambios funcionales.
- Diff sin secretos nuevos (repo público).

## Known Stubs

None — sin stubs ni placeholders.

## Threat Flags

None — sin superficie nueva fuera del threat model del plan (T-tiv-01..04 mitigados como se especificó).

## Post-merge (orquestador — pendiente, fuera del alcance del ejecutor)

1. Deploy a `sales-tracker-test`.
2. QA e2e: importar `mazefunnels@gmail.com` → `existing_account:true`, perfil creado, contraseña intacta; UI conectada sin "Agregar miembro" + hint; desconectar → reaparece alta manual; "Quitar" disponible en ambos estados.

## Self-Check: PASSED

- api/server.js modificado y commiteado (08c3f3c) ✓
- index.html modificado y commiteado (db70a00) ✓
- Ambos commits presentes en `git log` de la rama worktree-agent-adb1f0e9d24035f3c ✓
- SUMMARY.md creado (NO commiteado, per constraints) ✓
