---
phase: quick-260705-1ln
plan: 01
subsystem: plataforma-super-admin
tags: [orgs, impersonation, gotrue, magic-link, delete-org]
requires: []
provides: [delete-org-endpoint, member-login-link-endpoint, plataforma-danger-zone-ui, entrar-como-ui]
affects: [api/server.js, index.html]
key-files:
  created: []
  modified: [api/server.js, index.html]
decisions:
  - "Borrado explícito tabla por tabla (st_sales → st_entries → st_goals → st_integrations → st_profiles → st_orgs) con Prefer:return=representation para contar filas, sin depender de ON DELETE CASCADE"
  - "GoTrue jamás se toca en deleteOrg: auth compartido con otras apps Maze; borrar st_profiles alcanza para bloquear el acceso"
  - "Magic link: contempla action_link y hashed_token tanto al tope como anidados en data.properties (variantes de GoTrue)"
  - "getAuthEmail se llama con new Map() (cache por request, un solo uid)"
metrics:
  duration: ~15min
  completed: 2026-07-05
---

# Quick Task 260705-1ln: Eliminar organizaciones + Entrar como (impersonación) Summary

Super-admin puede eliminar una org completa con confirmación por nombre exacto y entrar a la app como cualquier miembro activo vía magic link de GoTrue.

## Qué se agregó

### API (`api/server.js`) — commit `f358fef`

**Rutas nuevas (ambas detrás de `requireSuperAdmin`, fail-closed):**

1. `DELETE /api/orgs/{orgId}` — handler `deleteOrg`:
   - Valida existencia de la org (404 si no existe).
   - Borra explícitamente, en orden: `st_sales`, `st_entries`, `st_goals`, `st_integrations`, `st_profiles`, `st_orgs` — cada DELETE filtra `org_id=eq.{orgId}` (anti cross-org) y cuenta filas vía `Prefer: return=representation`.
   - Si un DELETE falla → 500 con mensaje en español indicando borrado parcial + log de qué tabla falló.
   - **JAMÁS toca `auth.users` / `/auth/v1/admin/users`** (comentario explicativo en el handler: GoTrue compartido con otras apps de Maze).
   - Respuesta: `{ok:true, deleted:{profiles,sales,entries}}`.

2. `POST /api/orgs/{orgId}/members/{uid}/login-link` — handler `memberLoginLink`:
   - 503 si falta `PUBLIC_URL`; 404 si el uid no pertenece a la org; 400 si el miembro está inactivo; 404 si no hay email; 502 si GoTrue falla.
   - `POST /auth/v1/admin/generate_link` con `{type:'magiclink', email, redirect_to: PUBLIC_URL}`.
   - Construye `link` desde `action_link` o `hashed_token` (top-level o `data.properties`).
   - **Cero link/token/email en logs** — solo `orgId + uid + super=sa.email`.

Router: `orgMatch` (DELETE) después de las rutas org existentes; `orgLoginLinkMatch` (POST) evaluado ANTES de `orgMemberMatch`. Header del archivo actualizado con las 2 rutas.

### UI (`index.html`) — commit `1544658`

- **Zona de peligro** al final de `orgPanelHtml()`: sección separada con `border-top`, botón `btn danger sm` "Eliminar organización" → modal lazy (`delOrgOv`, patrón `pwOv`): advertencia de irreversibilidad, input de confirmación con botón "Eliminar definitivamente" deshabilitado hasta que el valor sea EXACTAMENTE `org.name` (comparación contra `DEL_ORG.name` crudo por referencia, no contra el DOM). OK → toast con conteos, cierre de modal+panel, refresco de `loadOrgs()` + `renderPlatform()`. Error → toast sin cerrar el modal.
- **"Entrar como"** por fila de miembro, SOLO si `m.active!==false`: `confirm()` previo → `POST .../login-link` → `window.location.href = data.link`. El link jamás se muestra/loggea.
- Todo texto dinámico por `esc()`, español tuteo, tokens CSS existentes (`btn danger` ya existía, línea 184).

## Deviations from Plan

None - plan executed exactly as written.

## Verificaciones corridas

- `node --check api/server.js` → OK.
- JS inline de `index.html` extraído (1 bloque) → `node --check` OK.
- Arranque local con env dummy (`SUPER_ADMIN_EMAILS` vacía): `DELETE /api/orgs/test` → **403**, `POST /api/orgs/test/members/u1/login-link` → **403** (fail-closed, sin 404/500).
- Greps: `admin/generate_link` presente (1); cero `console.log/error` con `action_link`/`hashed_token`; `deleteOrg` sin llamadas a `/auth/v1/admin/users`; `Entrar como` (3), `Eliminar definitivamente` (3), fetch de `login-link` presente; cero `console.log` con link en index.html.
- Cero secretos nuevos; sin dependencias nuevas; sin SSH ni deploy.

## Commits

| Task | Commit | Descripción |
|------|--------|-------------|
| 1 | `f358fef` | feat(quick-260705-1ln): DELETE org + login-link de impersonación en la API |
| 2 | `1544658` | feat(quick-260705-1ln): UI Plataforma — modal eliminar org + botón Entrar como |

## Known Stubs

None.

## Threat Flags

None — las dos superficies nuevas (DELETE org, login-link) ya estaban registradas en el `<threat_model>` del plan con disposición `mitigate`, y todas las mitigaciones se implementaron.

## Self-Check: PASSED
- api/server.js modificado y commiteado (f358fef) — FOUND
- index.html modificado y commiteado (1544658) — FOUND
- SUMMARY.md creado — FOUND
