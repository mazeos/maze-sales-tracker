# Multi-cuenta (membresías) — Diseño + Plan

**Fecha:** 2026-07-05 · **Aprobado por Alejandro** (diseño conversacional, misma sesión)

## Problema
`st_profiles.id` = id del login (PK, FK a auth.users) → un email solo puede estar en UN equipo. El import rebota "ese email ya pertenece a otro equipo".

## Diseño
1. **Membresías**: `st_profiles.user_id` (login). Perfiles existentes conservan `id` (= login histórico, FKs intactas); membresías nuevas nacen con `id` propio. Único (user_id, org_id).
2. **Org activa**: `st_user_state (user_id PK → active_profile_id)`. Sin Auth Hooks (GoTrue compartido).
3. **RLS**: helper `st_my_profile()` (perfil activo validado o único perfil activo); `st_my_org()`/`st_is_admin()` derivan de él. Políticas de ownership (`st_entries`, `st_sales`) pasan de `auth.uid()` a `st_my_profile()`. `st_orgs`/`st_profiles` SELECT amplían para que el usuario vea SUS orgs/perfiles (necesario para el selector).
4. **Mini-API**: `checkAdminToken`/`requireMember` resuelven el perfil ACTIVO por `user_id` (devuelven `uid` = id del PERFIL, semántica histórica intacta). Import: email en otra org ya NO es 409 → crea membresía nueva en la org del caller.
5. **UI**: al boot, perfiles por `user_id`; >1 activo → selector de equipo (overlay); chip "⇄ Equipo" en el topbar para cambiar. Un solo equipo = cero cambios visibles.

## Tasks
1. **Migración 013**: user_id + backfill + drop FK id→auth + default gen_random_uuid + unique + st_user_state + RLS + helpers nuevos + políticas ownership recreadas + políticas SELECT ampliadas. Test transaccional: usuario con 2 perfiles, st_my_profile() resuelve por estado y por fallback.
2. **server.js**: resolveActiveProfile(authUid); checkAdminToken y requireMember lo usan; import crea membresía (INSERT st_profiles con user_id) en vez de 409; los INSERT de perfiles existentes (import nuevo, /api/members, provisión de admins) agregan `user_id`.
3. **index.html**: boot multi-perfil + selector + chip cambiar equipo + upsert st_user_state.
4. **QA e2e**: crear membresía real de alejandro@mazefunnels.com como setter en Camino Digital (el caso de la captura) → login muestra selector → operar en ambos equipos → RLS cruzada verificada.

Constraints globales: idempotencia SQL, `node --check`, rebuild api, NOTIFY pgrst, castellano latino, commits frecuentes, push vía clone local del Mac.
