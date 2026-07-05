---
phase: quick
plan: 260704-p9c
subsystem: integrations
tags: [ghl, oauth, multi-tenant, security]
requires: []
provides:
  - "Tabla st_integrations (RLS deny-all) para tokens OAuth por org"
  - "Flujo OAuth 2.0 completo con GHL Marketplace: start + callback + status + disconnect"
  - "Card 'Integración HighLevel' admin-only en Configuraciones"
affects: [api/server.js, index.html, supabase/migrations]
tech-stack:
  added: []
  patterns:
    - "State OAuth firmado con HMAC-SHA256 (SERVICE_ROLE_KEY) + timingSafeEqual + expiración 10 min"
    - "RLS habilitada sin policies ni permisos = deny-all vía PostgREST; solo la service role accede"
    - "checkAdminToken(token) reutilizable para JWT por header o por query param"
key-files:
  created:
    - supabase/migrations/003_integrations.sql
  modified:
    - api/server.js
    - index.html
decisions:
  - "connected_by queda null en el upsert del callback: no hay sesión de usuario ahí; el dato clave es org_id (viene del state firmado)"
  - "JWT por query param en /oauth/start aceptado (T-q-05): vida corta, TLS, navegación única; cookie/POST rompería el patrón sin-deps"
  - "refreshGhlToken implementado pero sin consumidores: queda listo para la fase de sync"
metrics:
  duration: "~5 min"
  completed: "2026-07-04"
requirements: [GHL-01]
---

# Quick Task 260704-p9c: Integración GHL Fase 1 — Conexión OAuth desde Configuraciones — Summary

**One-liner:** Flujo OAuth 2.0 de GHL Marketplace (chooselocation → callback con state HMAC → upsert de tokens en st_integrations blindada) + card admin-only de conectar/desconectar en Configuraciones, con la app 100% funcional en modo manual si faltan las env vars.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Migración 003_integrations.sql — tabla st_integrations blindada | 651f036 | supabase/migrations/003_integrations.sql |
| 2 | Endpoints OAuth GHL en api/server.js | f5a6593 | api/server.js |
| 3 | Card "Integración HighLevel" en Configuraciones | c9c31ed | index.html |

## What Was Built

### Migración (`supabase/migrations/003_integrations.sql`)
- Tabla `public.st_integrations`: `org_id unique` (FK a st_orgs, on delete cascade) → una integración GHL por org, habilita el UPSERT `on_conflict=org_id`.
- Columnas de tokens (`access_token`, `refresh_token`, `token_expires_at`) + metadata (`location_id`, `location_name`, `company_id`, `scopes`, `connected_by`).
- **RLS habilitada SIN policies y SIN permisos a authenticated/anon** → deny-all vía PostgREST; solo la service role de la mini-API lee/escribe tokens.

### Mini-API (`api/server.js`, sin deps npm)
- Env vars nuevas: `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `PUBLIC_URL` (normalizada sin `/` final). `GHL_ENABLED` calculado: si falta alguna, la API arranca igual y los endpoints OAuth responden 503.
- Refactor: `requireAdmin(req)` ahora es wrapper de `checkAdminToken(bearerToken)` (misma validación GoTrue + role=admin en st_profiles), reutilizado por `/oauth/start` con el JWT que llega por query.
- `GET /api/oauth/start`: valida admin, redirige 302 a `marketplace.gohighlevel.com/oauth/chooselocation` con los 9 scopes y `state=signState(org_id)`.
- `GET /api/oauth/callback`: verifica state (HMAC-SHA256 con SERVICE_ROLE_KEY, `timingSafeEqual`, expiración 10 min) → exchange en `services.leadconnectorhq.com/oauth/token` (form-urlencoded, `user_type: Location`) → nombre de subcuenta best-effort (`GET /locations/{id}`, Version 2021-07-28) → UPSERT `on_conflict=org_id` con `Prefer: resolution=merge-duplicates` → redirect `/?ghl=connected`. Errores → `/?ghl_error={state|code|token|save}`.
- `GET /api/integrations/ghl`: requireAdmin; select explícito `location_id,location_name,created_at` — **jamás tokens**. Responde `{connected, location_id, location_name, connected_at}` o `{connected:false}`.
- `DELETE /api/integrations/ghl`: requireAdmin; borra la fila de la org, idempotente.
- `refreshGhlToken(integration)`: refresca si vence en <5 min, persiste tokens rotados vía PATCH; listo para las fases de sync.

### UI (`index.html`)
- `ghlCard()` en Configuraciones, solo `IS_ADMIN`, con 3 estados: "Verificando conexión…" (dispara `loadGhlStatus()` con guard anti-duplicados), desconectado (copy + botón "Conectar con HighLevel"), conectado ("✅ Conectado a **{location_name}**" + fecha es-AR + botón Desconectar `.btn danger sm`).
- `window.connectGhl`: navega a `/api/oauth/start?token={JWT}`. `window.disconnectGhl`: confirm + DELETE + toast + re-render.
- `boot()`: lee `?ghl=connected` / `?ghl_error=…`, muestra toast (`state` → "El enlace expiró, intentá conectar de nuevo") y limpia con `history.replaceState`.
- Cero CSS nuevo: solo clases y tokens existentes (`var(--muted)`, `.section`, `.eyebrow`, `.btn`), válidos en ambos temas.

## Verification Results

- `node --check api/server.js` — pasa.
- Smoke test sin env vars de GHL: API arranca, `/api/health` → 200, `/api/oauth/start` → 503. ✅
- Migración: `st_integrations` con org_id unique, RLS on, cero `create policy`, cero `grant`. ✅
- `grep "GHL_CLIENT"` en el repo: solo referencias a `process.env` — cero secretos (repo público). ✅
- Status endpoint: select explícito sin columnas de tokens. ✅
- `git diff --stat` vs base: exactamente 3 archivos (migración, api/server.js, index.html). ✅
- Human-check pendiente post-deploy del orquestador (flujo completo en sales-tracker-test).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Comentario de la migración disparaba el verify anti-grants**
- **Found during:** Task 1
- **Issue:** El comentario en español decía "SIN grants a authenticated/anon", y el verify del plan (`! grep -qi "grant"`) matcheaba la palabra dentro del propio comentario.
- **Fix:** Reword a "SIN permisos para authenticated/anon". Cero cambio funcional.
- **Files modified:** supabase/migrations/003_integrations.sql
- **Commit:** 651f036

## Known Stubs

- `refreshGhlToken` en `api/server.js` no lo consume ninguna ruta todavía — **intencional según el plan** ("queda listo para fases siguientes"); lo consumirá la fase de sync GHL (GHL-02+).

## Self-Check: PASSED

- supabase/migrations/003_integrations.sql — FOUND
- api/server.js (rutas oauth) — FOUND
- index.html (card) — FOUND
- Commits 651f036, f5a6593, c9c31ed — FOUND

## Post-merge (orquestador — pendiente)

1. Agregar al `.env` de sales-tracker-test: `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET` (Fate Vault → `03 Credenciales/APIs y Tokens.md`) y `PUBLIC_URL=https://sales-tracker-test.mazefunnels.io`.
2. Registrar la redirect URI `https://sales-tracker-test.mazefunnels.io/api/oauth/callback` en la app del Marketplace de GHL.
3. Aplicar `003_integrations.sql` en el Supabase del VPS.
4. Redeploy + reinicio de la mini-API.
5. Human-check del flujo completo como admin.
