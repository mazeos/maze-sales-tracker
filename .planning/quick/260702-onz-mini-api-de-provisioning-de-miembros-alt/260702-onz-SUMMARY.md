---
phase: quick-260702-onz
plan: 01
subsystem: provisioning-miembros
tags: [supabase, auth, service-role, nginx, docker-compose, soft-delete, multi-tenant]
requires:
  - st_profiles (migration 001)
  - Supabase self-hosted (GoTrue + PostgREST)
provides:
  - Mini-API Node de provisioning de miembros (POST/DELETE /api/members)
  - Columna st_profiles.active (soft-delete)
  - Alta/baja real de miembros desde la UI
affects:
  - index.html (form equipo, addMember, delMember, loadFromSupabase)
  - nginx.conf (proxy /api/)
  - docker-compose.yml / docker-compose.dev.yml (servicio api)
tech-stack:
  added:
    - "Node 22 http nativo + fetch global (mini-API sin dependencias npm)"
  patterns:
    - "Provisioning server-side con SERVICE_ROLE_KEY + filtrado manual por org_id"
    - "Soft-delete (active=false) + ban de auth user en vez de DELETE de perfil"
key-files:
  created:
    - supabase/migrations/002_member_active.sql
    - api/server.js
    - api/Dockerfile
    - api/package.json
  modified:
    - nginx.conf
    - docker-compose.yml
    - docker-compose.dev.yml
    - index.html
decisions:
  - "Baja = soft-delete (active=false) + ban del auth user, nunca DELETE del perfil (st_entries tiene ON DELETE CASCADE → se perderían datos históricos)"
  - "Mini-API sin dependencias npm (http nativo + fetch) → cero superficie de supply-chain"
  - "Copy visible al usuario en tuteo (nunca voseo) por constraint del orquestador"
metrics:
  duration: ~12 min
  completed: 2026-07-02
  tasks: 3
  files: 8
---

# Quick 260702-onz: Mini-API de provisioning de miembros Summary

Provisioning real server-side de miembros: una mini-API Node sin dependencias crea auth users + perfiles con la service key, con soft-delete que conserva el histórico y banea el login, cableada por nginx y docker-compose.

## Qué se construyó

Antes, `window.addMember`/`window.delMember` solo mutaban un array en memoria: no creaban auth users (imposible desde el browser, requiere `service_role`) y la "baja" no impedía el login. Ahora:

1. **Migración 002** — columna `active boolean not null default true` en `st_profiles` (idempotente). La baja es soft (`active=false`), nunca DELETE, porque `st_entries.member_id` tiene `ON DELETE CASCADE`.

2. **Mini-API `api/server.js`** (269 líneas, sin deps npm — solo `http` nativo + `fetch` de Node 22):
   - Middleware `requireAdmin`: valida el JWT contra `/auth/v1/user` (anon key), lee el perfil real con service key y exige `role='admin'`. Guarda el `org_id` del admin.
   - `POST /api/members`: valida (name/email/password no vacíos, password ≥ 8, role ∈ {setter,triage,closer}); crea auth user (`email_confirm:true`); inserta perfil; si el insert falla hace **rollback** borrando el auth user. Email duplicado → 409.
   - `DELETE /api/members/{id}`: verifica que el target pertenece al **mismo org** del admin (anti cross-tenant → 404 si no); `PATCH active=false` + `PUT ban_duration:"87600h"`.
   - Logs a stdout sin passwords. Sin CORS (mismo origen vía nginx).

3. **Cableado** — `nginx.conf` proxya `location /api/` → `http://api:3000`; ambos compose (prod + dev) suman el servicio `api` (`build: ./api`, `env_file: .env`, red `default`) y ponen nginx en las redes `traefik-public` + `default`.

4. **UI `index.html`** — el form "Agregar miembro" suma campos Email y Contraseña; `addMember`/`delMember` son async y llaman a `/api/members` con `Bearer access_token`, refrescan vía `loadFromSupabase()`+`renderTeam()`, y no muestran toasts falsos de éxito ante error. `loadFromSupabase` filtra `p.active!==false`.

## Tasks completadas

| Task | Nombre | Commit | Archivos |
| ---- | ------ | ------ | -------- |
| 1 | Migración soft-delete + mini-API Node | 508c5e1 | 002_member_active.sql, api/server.js, api/Dockerfile, api/package.json |
| 2 | Cableado nginx + servicio api en compose | a9a7019 | nginx.conf, docker-compose.yml, docker-compose.dev.yml |
| 3 | UI de alta/baja real contra /api/members | ccf4d07 | index.html (+ corrección de copy en api/server.js) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Copy en voseo corregido a tuteo**
- **Found during:** Task 3
- **Issue:** Los mensajes que escribí inicialmente en `api/server.js` (Task 1) y en `index.html` usaban voseo ("Tenés que poner", "volvé a entrar", "Intentá de nuevo"), violando el constraint del orquestador ("español latino, tuteo, nunca voseo") — que además coincide con lo pedido en la acción del plan.
- **Fix:** Reemplazados por formas de tuteo ("Tienes que poner", "vuelve a entrar", "Inténtalo de nuevo"). No se tocó el copy preexistente fuera de scope (ej. línea "Poné el cliente" en el form de ventas).
- **Files modified:** api/server.js, index.html
- **Commit:** ccf4d07

## Threat Model — mitigaciones aplicadas

- **T-onz-01 (EoP):** `requireAdmin` valida el JWT server-side y exige `role='admin'` del perfil real antes de cualquier operación → un caller no-admin recibe 403.
- **T-onz-02 (Info Disclosure):** el DELETE verifica `org_id` del target vs. del admin → baja cross-tenant imposible (404).
- **T-onz-03 (Tampering):** rollback del auth user si falla el insert del perfil → sin usuarios huérfanos que puedan loguearse sin perfil.
- **T-onz-04:** logs sin passwords.
- **T-onz-05 (Spoofing):** el token se valida contra GoTrue con la anon key; no se confía en claims del cliente.
- **T-onz-SC:** sin dependencias npm → sin superficie de supply-chain.

## user_setup pendiente (lo hace el orquestador, NO va al repo)

1. **Crear el `.env` untracked** en el app_dir del VPS con 4 vars:
   - `SUPABASE_URL` = `https://supabase.mazefunnels.io`
   - `SERVICE_ROLE_KEY` = JWT con role `service_role` de Supabase self-hosted
   - `ANON_KEY` = anon key (la misma embebida en index.html)
   - `PORT` = opcional, default 3000
2. **Aplicar la migración 002** vía `docker exec psql` en el contenedor de Postgres de Supabase.
3. **Rebuild/redeploy** del compose para levantar el nuevo servicio `api` (`docker compose up --build -d`).

## Self-Check: PASSED

- Archivos creados/modificados: los 8 existen en disco (verificado).
- Commits 508c5e1, a9a7019, ccf4d07: presentes en el árbol git (verificado).
- `node --check api/server.js`: pasa. Ambos compose parsean como YAML válido con el servicio `api`.
