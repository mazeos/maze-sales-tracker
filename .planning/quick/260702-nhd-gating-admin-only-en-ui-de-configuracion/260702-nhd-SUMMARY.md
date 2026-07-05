---
phase: quick-260702-nhd
plan: 01
subsystem: ui-permisos
tags: [gating, admin-only, rls, ui, permisos]
requires: [IS_ADMIN, ME]
provides: [GATING-ADMIN-UI]
affects: [index.html]
tech-stack:
  added: []
  patterns: ["gating admin-only vía IS_ADMIN en render + early-return en handlers"]
key-files:
  created: []
  modified: [index.html]
decisions:
  - "Doble capa de gating: UI (disabled/ocultar) + defensa en profundidad (early-return en handlers globales)"
  - "Info del equipo VISIBLE para todos (transparencia); solo la edición se bloquea para no-admin"
  - "Copy nuevo en castellano neutro con tuteo; textos rioplatenses existentes intactos"
metrics:
  duration: ~8 min
  completed: 2026-07-02
---

# Phase quick-260702-nhd Plan 01: Gating admin-only en UI de Configuraciones Summary

Gating admin-only en las vistas **Configuraciones** (`renderTeam`) y **Metas** (`renderGoals`): un colaborador ve toda la info del equipo pero no puede editarla — inputs/selects `disabled`, botones de mutación ocultos, aviso visible, y handlers globales con early-return que alinean la UI con la RLS real de Supabase (evitando el toast "guardado" mentiroso vía DevTools).

## What Was Built

**Task 1 — UI read-only + aviso (commit 2bd5960)**
- Helper `adminNotice()` que renderiza `🔒 Solo el admin puede editar esta sección. Puedes ver los datos del equipo, pero no modificarlos.` (tuteo neutro) solo para no-admin.
- CSS `.admin-lock` usando tokens existentes (funciona en tema oscuro) + override `body[data-theme="light"] .admin-lock{color:#7d5300;...}` para contraste WCAG >=4.5 en tema claro (mismo color que el proyecto ya usa para warn en claro).
- `renderTeam()`: `const ro=!IS_ADMIN;` → `disabled` en nombre de agencia, modo de equipo, zona horaria, `cfg-name`, `cfg-role` y comisión. Botón "Quitar" (`delMember`) y sección "Agregar miembro" ocultos para no-admin. "Editar sus números" visible solo para admin o en la propia fila del colaborador (`ME && m.id===ME.id`).
- `renderGoals()`: `const ro=!IS_ADMIN;` → `disabled` en los 3 inputs de metas semanales + aviso.

**Task 2 — Guards early-return (commit 7804a3b)**
- `if(!IS_ADMIN) return;` como primera sentencia en los 9 handlers globales: `setAgName`, `setMode`, `setTz`, `setMemberName`, `setMemberRole`, `setCommission`, `addMember`, `delMember`, `setGoal`.
- Intactos: `editMemberData` (solo navega a la tabla, que ya tiene su gating `canEdit`), `bump`, `setMoney`, `tblEdit`, `addSale`, `delSale`.

## Deviations from Plan

### Base del worktree corregida (setup)

- **Encontrado durante:** setup (worktree_branch_check). El `merge-base` del HEAD (`5b37af8`) difería del base objetivo (`1459697`), que estaba **por delante** del HEAD.
- **Acción:** `git reset --hard 1459697` según el paso 2 del check. El HEAD inicial (`5b37af8`) apuntaba a una versión **localStorage sin auth** de `index.html` (sin `IS_ADMIN`/`ME`/Supabase); el base correcto `1459697` sí contiene la versión Supabase multi-tenant con `IS_ADMIN`, `ME`, `canEdit`, sobre la que el plan fue escrito. Tras el reset, todos los números de línea del plan coincidieron.
- **Impacto:** Ninguno en el resultado; sin este reset el plan habría sido inimplementable.

Fuera de eso: plan ejecutado exactamente como fue escrito. Ningún Rule 1-4 aplicado.

## Known Stubs

Ninguno.

## Verification

- `node` check Task 1: `OK task1` (adminNotice, .admin-lock, override tema claro presentes).
- `node` check Task 2: `OK task2 — guards en todos los handlers` (los 9 handlers con `if(!IS_ADMIN) return`).
- Verificación manual pendiente (checkpoint del orquestador): admin edita todo sin aviso; colaborador ve aviso + controles disabled, "Quitar"/"Agregar miembro" ausentes, "Editar sus números" solo en su fila; `setGoal(...)` desde consola con IS_ADMIN=false no muta; aviso legible en ambos temas.

## Self-Check: PASSED

- FOUND: index.html (modificado)
- FOUND commit 2bd5960 (Task 1)
- FOUND commit 7804a3b (Task 2)
