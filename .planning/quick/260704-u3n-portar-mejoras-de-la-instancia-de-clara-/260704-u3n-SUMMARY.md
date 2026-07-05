---
phase: quick-260704-u3n
plan: 01
subsystem: ventas-ghl
tags: [ghl, ventas, multi-tenant, ux, a11y]
requires: [st_integrations (003), refreshGhlToken, checkUserToken]
provides: [GET /api/ghl/leads, POST /api/sales/ghl, migración 005, editNum/setNum, vista Ventas extendida]
affects: [instancia Clara (próxima actualización desde repo), cualquier tenant con OAuth GHL]
tech-stack:
  added: []
  patterns: [creds GHL por org con fallback PIT env, cache en memoria por org, best-effort por paso, degradación a modo manual]
key-files:
  created: [supabase/migrations/005_sales_ghl.sql]
  modified: [api/server.js, index.html]
decisions:
  - "IDs de custom fields y pipeline SOLO por env (GHL_CF_JSON / GHL_PIPELINE_JSON) — cero IDs de Clara en el repo público"
  - "Cache de leads en Map por orgId (TTL 60s) — nunca cache global entre tenants"
  - "Select de leads arranca oculto y el input manual visible: el modo GHL es opt-in cuando hay leads (inverso al parche de Clara)"
  - "Seed demo renombrado 'Camino Digital' → 'Agencia Demo' (gate de repo público)"
metrics:
  duration: ~8 min
  completed: 2026-07-05T00:57:00Z
  tasks: 3/3
  files: 3
---

# Quick 260704-u3n: Portar mejoras de la instancia de Clara — Summary

**One-liner:** Módulo Ventas-GHL multi-tenant (leads con cita + cierre de ciclo custom fields/tag/oportunidad/Slack por env), doble clic en contadores, rail reordenado y a11y — portado del parche mono-tenant de Clara sin un solo ID ni pixel de su branding.

## Tareas ejecutadas

| Task | Nombre | Commit | Archivos |
|------|--------|--------|----------|
| 1 | Migración 005 + endpoints GHL de ventas en la mini-API | `72382ba` | supabase/migrations/005_sales_ghl.sql, api/server.js |
| 2 | Doble clic en contadores, rail reordenado y a11y/móvil | `14d52f5` | index.html |
| 3 | Vista Ventas extendida con leads GHL y disparo de onboarding | `d0aa0ed` | index.html |

## Qué se construyó

**Backend (api/server.js):**
- Env nuevas opcionales: `GHL_PIT`, `GHL_LOCATION`, `GHL_CALENDAR`, `SLACK_TOKEN`, `SLACK_WINS_CHANNEL` + JSON tolerantes `GHL_CF_JSON` (8 claves de custom fields) y `GHL_PIPELINE_JSON` (pipelineId/stageReserva/stagePago). Si faltan o son inválidos → constante `null` + aviso en log, la API arranca igual.
- `ghlHeaders(token, version)` parametrizado por token (el token varía por org, a diferencia del PIT global del diff).
- `requireMember(req)`: cualquier miembro ACTIVO (reusa `checkUserToken` + perfil vía service key; inactivo → 403).
- `getGhlCreds(orgId)`: OAuth de la org (`getIntegration` + `refreshGhlToken`, el Error burbujea → 502) → fallback PIT/LOCATION por env → `null` (→ 501).
- `GET /api/ghl/leads`: citas −14/+7 días del calendario `GHL_CALENDAR`, filtro cancelled/invalid, dedupe por contacto (cita más reciente), nombre con dedupe de palabras, sort desc, **cache Map por orgId TTL 60s**. 501 claros si falta creds o calendario.
- `POST /api/sales/ghl`: custom fields (salteado si `GHL_CF` null) + tag `reserva`/`venta-cerrada` + oportunidad (salteada si `GHL_PIPELINE` null) + Slack (salteado sin token/canal), todo best-effort por paso. Deep-link white-label `app.mazefunnels.com/v2/location/...`.
- Router: ambas rutas con `requireMember`, sin colisión con `GET /api/ghl/users` (admin). Comentario de rutas del encabezado actualizado.

**Migración (005_sales_ghl.sql):** 3× `alter table ... add column if not exists` (primer_pago, fue_reserva, ghl_contact_id) — no-op esperado contra la base viva del VPS.

**Frontend (index.html):**
- Doble clic en contadores de Cargar día → input numérico inline (Enter/blur confirma, Escape cancela); `window.setNum`/`window.editNum` tal cual el diff.
- Rail: dashboard → **sales** → capture → table → team → **goals (visible)**. Nav-i con `tabIndex=0` + Enter/Espacio + `:focus-visible` lima.
- Móvil: cap-intro colapsa a 1 línea (tap expande), tooltips del rail ocultos; `.inp:disabled` atenuado.
- Vista Ventas: selector de lead GHL (oculto por defecto) + input manual (visible por defecto), cuotas/primer pago/flag+monto de reserva, triage condicional, botón `s_submit` que cambia a "Registrar venta y disparar onboarding" solo con leads. `loadGhlLeads` con fallback silencioso a modo manual (501/error/0 leads). `addSale` guarda los campos nuevos y dispara el POST best-effort con los toasts del diff; sin ghlId → toast "Venta registrada" a secas.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocker] Seed demo con "Camino Digital" pre-existente rompía el grep gate**
- **Found during:** Task 3 (verify)
- **Issue:** `seed()` (demo local pre-existente del v1) usaba `team:{name:'Camino Digital'}`; el gate `! grep "Camino Digital" index.html` del plan no podía pasar.
- **Fix:** renombrado a `'Agencia Demo'` (dato de demo, sin impacto funcional).
- **Files modified:** index.html
- **Commit:** `d0aa0ed`

## Verificación

- `node --check api/server.js` ✅
- API arranca con env dummy de Supabase y SIN env GHL/Slack: solo avisos, `/api/health` 200, `/api/ghl/leads` sin token → 401 ✅
- Sintaxis de los `<script>` inline válida (new Function) ✅
- Grep gates: cero IDs de Clara (incl. los 4 CF extra no listados en el gate del plan), cero Camino Digital/DDB65F/clara-brand/Cormorant, footer Maze intacto, sales antes que capture, goals presente ✅
- `bump`/`setMoney` sin cambios (diff contra base vacío para esas funciones) ✅
- Sin deleciones ni archivos untracked ✅

## Known Stubs

Ninguno — la degradación sin GHL es comportamiento intencional del producto (carga manual), no un stub.

## Threat Flags

Ninguna superficie nueva fuera del `<threat_model>` del plan: los dos endpoints nuevos estaban modelados (T-u3n-01…05) y sus mitigaciones aplicadas (env-only, creds por org server-side, cache por org, `esc()` en options del select).

## Self-Check: PASSED

- supabase/migrations/005_sales_ghl.sql: FOUND
- api/server.js modificado: FOUND
- index.html modificado: FOUND
- Commits 72382ba, 14d52f5, d0aa0ed: FOUND en `git log`
