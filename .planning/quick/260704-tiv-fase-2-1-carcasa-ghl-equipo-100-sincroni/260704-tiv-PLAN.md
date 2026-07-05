---
phase: quick-260704-tiv
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [api/server.js, index.html]
autonomous: true
requirements: [QUICK-260704-TIV]
must_haves:
  truths:
    - "Al importar desde GHL un email que ya existe en el auth compartido SIN perfil en el tracker, el import crea el perfil sobre el auth user existente y responde existing_account:true (nunca 409, nunca toca su contraseña)"
    - "Al importar un email cuyo perfil ya pertenece a OTRA org del tracker, el import responde 409 'Ese email ya pertenece a otro equipo del tracker'"
    - "Al importar un email con perfil en ESTA org, el import lo vincula (ghl_user_id) y responde linked:true; si estaba inactivo lo reactiva y desbanea"
    - "Con GHL conectado, la sección 'Agregar miembro' NO aparece en Configuraciones; en su lugar hay una nota que dirige a 'Equipo desde HighLevel'"
    - "Sin GHL conectado, el alta manual funciona exactamente como antes"
    - "La baja manual (Quitar / delMember) sigue disponible siempre, conectado o no"
  artifacts:
    - path: "api/server.js"
      provides: "importGhlUser con resolución de email duplicado vía GoTrue admin (búsqueda paginada por email exacto) + helper findAuthUserByEmail"
      contains: "existing_account"
    - path: "index.html"
      provides: "Aviso existing_account en el handler de import + alta manual condicionada a GHL_STATUS.connected"
      contains: "existing_account"
  key_links:
    - from: "api/server.js importGhlUser rama duplicado"
      to: "GoTrue /auth/v1/admin/users (listado paginado)"
      via: "fetch con svcHeaders, filtro client-side por email exacto lowercase/trim"
      pattern: "admin/users\\?page="
    - from: "index.html window.importGhlUser"
      to: "data.existing_account"
      via: "toast/aviso condicional en la rama res.ok"
      pattern: "existing_account"
    - from: "index.html renderTeam"
      to: "GHL_STATUS.connected"
      via: "render condicional de la sección Agregar miembro"
      pattern: "GHL_STATUS\\s*&&\\s*GHL_STATUS\\.connected"
---

<objective>
Fase 2.1 de la carcasa GHL del Maze Sales Tracker: (1) arreglar el bug real del import cuando el email ya existe en el GoTrue compartido (caso verificado: `mazefunnels@gmail.com` existe en auth.users desde abril SIN st_profile y el endpoint devuelve 409 "otra organización" — incorrecto), y (2) aplicar la decisión de Alejandro (2026-07-04, no revisitar): con GHL conectado, los ÚNICOS usuarios posibles son los sincronizados desde GHL — el alta manual desaparece de la UI mientras haya conexión. La baja manual se mantiene siempre.

Purpose: que el equipo sea 100% sincronizado desde HighLevel cuando hay conexión, y que el import no rechace cuentas legítimas que ya existen en el auth compartido entre apps (tracker, CallIQ, etc.).
Output: `api/server.js` con la rama de email duplicado resuelta por lookup en GoTrue admin + `index.html` con el aviso existing_account y el alta manual condicionada.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@api/server.js
@index.html

Rama de trabajo: `develop` (Fases 1 y 2 GHL ya mergeadas). Repo PÚBLICO: cero secretos en código.

Arquitectura relevante (verificada en vivo):
- El Supabase self-hosted comparte GoTrue entre varias apps (tracker, CallIQ de Clara, etc.). Un email puede existir en `auth.users` sin tener `st_profiles` — NO significa "otra organización del tracker".
- GoTrue admin permite listar usuarios: `GET {SUPABASE_URL}/auth/v1/admin/users?page=N&per_page=100` con `svcHeaders()`. La respuesta trae `{ users: [...] }`. Según la versión puede existir un query `?filter=`, pero NO depender de eso: usar listado paginado + filtro client-side por email exacto normalizado (lowercase/trim).
- La contraseña de cuentas preexistentes JAMÁS se modifica: son cuentas de otras apps del mismo auth.
</context>

<interfaces>
<!-- Contratos existentes en api/server.js que el ejecutor reutiliza tal cual -->

`svcHeaders(extra = {})` → headers con SERVICE_ROLE_KEY para Supabase/GoTrue admin (bypassea RLS).

`getAuthEmail(uid, cache)` → email normalizado (lowercase+trim) de un auth user, o null.

`importGhlUser(req, res, admin)` (líneas ~672-815) — flujo actual:
- (a) perfil con ese ghl_user_id → 409 "Ya está importado" o reactivar (active:true + PUT `ban_duration:'none'`)
- (b) perfil manual sin ghl_user_id con el mismo email → PATCH ghl_user_id → `{ok:true, linked:true}`
- (c) crear: POST `/auth/v1/admin/users` con `{email, password: integration.location_id, email_confirm: true}`; **la rama a modificar** es la detección de duplicado (líneas 778-782):

```js
if (authRes.status === 422 || authRes.status === 409 ||
    (authUser && /already|registered|exists|duplicate/i.test(JSON.stringify(authUser)))) {
  console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} email_dup -> 409`);
  return sendJSON(res, 409, { error: 'Ese email ya tiene cuenta en otra organización' });
}
```

En index.html:
- `renderTeam()` (líneas ~1208-1251): la sección "Agregar miembro" se renderiza en `${IS_ADMIN ? \`<div class="section"><div class="eyebrow">Agregar miembro</div>...\` : ''}` (líneas 1241-1249), antes de `${ghlCard()}${ghlTeamCard()}`.
- `GHL_STATUS` (línea 988): null = no consultado; `loadGhlStatus()` lo llena async y su `finally` re-llama `renderTeam()` si `state.view==='team'` → la sección condicionada se actualiza sola al llegar el estado. `disconnectGhl` setea `{connected:false}` y re-llama `renderTeam()`. Conectar pasa por redirect OAuth → reload completo. 
- `window.importGhlUser` (líneas 1133-1151): rama `res.ok` hace `toast(data.reactivated?'Reactivado':(data.linked?'Vinculado':'Importado'))`.
- `ghlTeamCard()` retorna '' si `!GHL_STATUS || !GHL_STATUS.connected`.
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: importGhlUser — resolver email duplicado contra GoTrue admin (vincular o adoptar cuenta existente)</name>
  <files>api/server.js</files>
  <action>
En `api/server.js`, reemplazar la rama de email duplicado de `importGhlUser` (el bloque de líneas 778-782 que hoy responde 409 "Ese email ya tiene cuenta en otra organización") por la siguiente lógica. NO tocar `createMember` (su rama 409 de duplicado queda como está). NO tocar las ramas (a) reactivar ni (b) vincular por email de perfiles de la org.

1. **Helper nuevo** `findAuthUserByEmail(emailNorm)` junto a los demás helpers de usuarios GHL (cerca de `getAuthEmail`): busca el auth user por email exacto vía GoTrue admin con listado paginado. `emailNorm` llega ya normalizado (lowercase + trim). Loop de `page=1` hasta 10 inclusive: `GET SUPABASE_URL + '/auth/v1/admin/users?page=' + page + '&per_page=100'` con `headers: svcHeaders()`. Parsear el body; el array de usuarios viene en `body.users` (si no es array, tratar como vacío). Buscar `u` tal que `typeof u.email === 'string' && u.email.toLowerCase().trim() === emailNorm`. Si se encuentra → return el objeto user (cortar el loop). Si la página trae 0 usuarios o menos de 100 → no hay más páginas, return null. Errores de red/status ≠ 2xx → return null (el caller responde genérico). Comentario en el código explicando por qué listado+filtro client-side y no `?filter=` (depende de la versión de GoTrue).

2. **En la rama de duplicado** (mantener la condición actual: status 422/409 o regex `/already|registered|exists|duplicate/i`):
   a. `const emailNorm = email.toLowerCase().trim();` y `const existingAuth = await findAuthUserByEmail(emailNorm);`. Si `!existingAuth || !existingAuth.id` → log `email_dup_sin_match` y `sendJSON(res, 500, { error: 'No se pudo crear el usuario. Inténtalo de nuevo.' })` (mensaje genérico, no filtrar información del auth compartido).
   b. Con `uid = existingAuth.id`, leer su perfil: `GET /rest/v1/st_profiles?id=eq.{uid}&select=id,org_id,name,active,ghl_user_id` con `svcHeaders()`. Error de red/status → 502 'No se pudieron leer los perfiles del equipo'.
   c. **Perfil existe y `org_id !== admin.org_id`** → `sendJSON(res, 409, { error: 'Ese email ya pertenece a otro equipo del tracker' })` + log `email_dup_otra_org -> 409`.
   d. **Perfil existe y `org_id === admin.org_id`** → vincular: PATCH `st_profiles?id=eq.{uid}` con body que incluya `ghl_user_id: ghlUserId` y, solo si el perfil no tiene `name` (null/vacío), también `name` (el de GHL). Si `active === false`, incluir `active: true` en el mismo PATCH y luego PUT `/auth/v1/admin/users/{uid}` con `{ ban_duration: 'none' }` (best-effort, mismo patrón try/catch vacío que la rama reactivar existente). PATCH fallido → 500 'No se pudo vincular al miembro'. OK → log `email_dup_linked id={uid} ghl={ghlUserId} -> 200` y `sendJSON(res, 200, { ok: true, linked: true })`.
   e. **Sin perfil en ninguna org** (el caso `mazefunnels@gmail.com`) → adoptar la cuenta: INSERT en `st_profiles` con `{ id: uid, org_id: admin.org_id, name, role, ghl_user_id: ghlUserId, commission: 0 }` (POST `/rest/v1/st_profiles` con `Prefer: return=representation`, igual que el insert existente). **CRÍTICO — dos prohibiciones:** (1) JAMÁS tocar la contraseña ni ningún atributo del auth user existente (es una cuenta viva de otra app del mismo auth); (2) si el INSERT falla, NO ejecutar el rollback DELETE del auth user (ese rollback solo aplica a auth users recién creados) — responder 500 'No se pudo guardar el perfil del miembro.' y listo. OK → log `email_dup_adopted uid={uid} role={role} ghl={ghlUserId} -> 200` y responder el perfil creado con el flag extra: `sendJSON(res, 200, { ...created, existing_account: true })` (con el mismo fallback de objeto literal que la rama de creación si `return=representation` no devolviera fila).

3. Todos los logs con el estilo existente: `[api] POST /api/ghl/users/import admin=${admin.uid} ...`. Cero secretos: no loguear emails completos si el estilo actual no lo hace (el estilo actual loguea uids/ghl ids — seguir eso).
  </action>
  <verify>
    <automated>node --check api/server.js && SUPABASE_URL=http://localhost:9999 SERVICE_ROLE_KEY=test ANON_KEY=test PORT=3999 node api/server.js & sleep 1; curl -s http://localhost:3999/api/health | grep -q '"ok":true' && kill %1 && echo OK</automated>
  </verify>
  <done>`node --check` pasa; la API arranca sin env GHL ("modo manual") y responde /api/health; la rama de duplicado ya no responde 409 directo: busca el auth user por email (paginado, hasta 10 páginas, corte al encontrar), distingue otra-org (409 nuevo mensaje) / misma-org (linked:true, reactiva si hacía falta) / sin-perfil (INSERT sobre el uid existente + existing_account:true, contraseña intacta, sin rollback DELETE).</done>
</task>

<task type="auto">
  <name>Task 2: index.html — aviso existing_account + alta manual condicionada a GHL conectado</name>
  <files>index.html</files>
  <action>
Dos cambios en `index.html`:

1. **Aviso existing_account** en `window.importGhlUser` (rama `res.ok`, línea ~1145): si `data.existing_account` es truthy, en vez del toast corto 'Importado', mostrar el aviso: `toast('Importado. Ojo: ya tenía cuenta, entra con su contraseña de siempre (no con el código de acceso)')`. Revisar la implementación de `toast()`: si acepta duración, pasarle una más larga (~6-8s) para que dé tiempo a leer; si no acepta parámetro, dejar el toast con el texto completo tal cual (no inventar un modal). El resto de la rama (`loadFromSupabase()` + `loadGhlUsers()`) no cambia.

2. **Alta manual condicionada** en `renderTeam()` (sección "Agregar miembro", líneas ~1241-1249): reemplazar el bloque `${IS_ADMIN ? \`...Agregar miembro...\` : ''}` por una lógica que, siendo admin: si `GHL_STATUS && GHL_STATUS.connected` → NO renderizar el form; en su lugar una nota breve estilo hint dentro de una `<div class="section">` con eyebrow "Agregar miembro" (o sin section, un hint corto — seguir el estilo visual de los `<p style="color:var(--muted);font-size:13px">` ya usados en `ghlCard`): «El equipo se sincroniza desde HighLevel. Importá miembros desde "Equipo desde HighLevel".». Si no está conectado (incluye `GHL_STATUS === null` mientras carga y `{connected:false}`) → el form de alta manual exactamente como hoy. Extraer el bloque a una función o const local para no duplicar template strings gigantes dentro del ternario.

   NO tocar: `window.addMember` (sigue existiendo para orgs sin conexión), `window.delMember` ni el botón "Quitar" (la baja manual se mantiene SIEMPRE), `ghlTeamCard()`.

3. **Verificar (solo lectura, ya debería cumplirse) el refresco del estado:** `loadGhlStatus()` re-llama `renderTeam()` en su `finally` cuando `state.view==='team'` → al llegar `connected:true` el form desaparece solo; `disconnectGhl` setea `GHL_STATUS={connected:false}` y llama `renderTeam()` → el form reaparece; conectar pasa por redirect OAuth con reload completo. Si alguno de esos tres caminos NO re-renderizara, arreglarlo; si ya funcionan, no tocar nada.
  </action>
  <verify>
    <automated>grep -c "existing_account" /Users/alevogeler/maze-sales-tracker/index.html | awk '$1>=1{print "OK"}' && grep -n 'GHL_STATUS && GHL_STATUS.connected' /Users/alevogeler/maze-sales-tracker/index.html | head -5</automated>
  </verify>
  <done>Con `GHL_STATUS.connected` truthy, renderTeam no incluye el form "Agregar miembro" sino la nota hint que dirige a "Equipo desde HighLevel"; sin conexión (null o connected:false) el form se renderiza idéntico al actual; el handler de import muestra el aviso largo cuando `data.existing_account`; delMember/Quitar intactos.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → mini-API | JWT del cliente; todo endpoint de import exige requireAdmin |
| mini-API → GoTrue admin | SERVICE_ROLE_KEY; el listado de auth users expone emails de OTRAS apps del auth compartido |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-tiv-01 | Information Disclosure | findAuthUserByEmail / respuestas del import | mitigate | Si el auth user existe pero no se encuentra/matchea, responder 500 genérico sin revelar existencia de cuentas de otras apps; nunca devolver datos del auth user al browser, solo el perfil st_profiles creado + flag existing_account |
| T-tiv-02 | Elevation of Privilege | rama email_dup adopta cuenta existente | mitigate | El perfil se crea solo en admin.org_id (del JWT validado, nunca del body); si el perfil existe en otra org → 409; la contraseña del auth user preexistente jamás se modifica (evita account takeover de usuarios de CallIQ u otras apps) |
| T-tiv-03 | Tampering | rollback DELETE de auth user | mitigate | En la rama de cuenta preexistente el rollback DELETE se omite explícitamente: borrar un auth user compartido rompería la otra app |
| T-tiv-04 | Spoofing | name/email del usuario a importar | mitigate (ya existente) | importGhlUser re-consulta la lista GHL server-side y nunca confía en name/email del body |
| T-tiv-SC | Tampering | npm installs | accept | Sin dependencias nuevas: server.js sigue siendo Node nativo sin npm |
</threat_model>

<verification>
- `node --check api/server.js` sin errores.
- La API arranca con env dummy y SIN env GHL (log "modo manual") y `/api/health` responde `{ok:true}`.
- `grep -n "existing_account" api/server.js index.html` → presente en la rama de adopción del server y en el handler de import del cliente.
- `grep -n "Ese email ya pertenece a otro equipo del tracker" api/server.js` → nuevo 409 solo para perfil en otra org.
- El bloque "Agregar miembro" en renderTeam está condicionado por `GHL_STATUS && GHL_STATUS.connected`; `window.addMember` y `window.delMember` siguen definidos sin cambios funcionales.
- Cero secretos nuevos en el diff (repo público).
</verification>

<success_criteria>
- Import de un email preexistente en el auth compartido sin perfil → crea st_profile sobre el uid existente, responde 200 + `existing_account:true`, contraseña intacta.
- Import de un email con perfil en otra org → 409 "Ese email ya pertenece a otro equipo del tracker".
- Import de un email con perfil en esta org → 200 `linked:true` (reactivado + unban si estaba inactivo).
- UI conectada a GHL: sin form de alta manual, con hint que dirige a "Equipo desde HighLevel"; desconectada: alta manual intacta. Baja manual siempre disponible.
</success_criteria>

<output>
Create `.planning/quick/260704-tiv-fase-2-1-carcasa-ghl-equipo-100-sincroni/260704-tiv-SUMMARY.md` when done.

## Post-merge (orquestador — el ejecutor NO hace SSH ni deploy)

1. Deploy a `sales-tracker-test`.
2. QA e2e:
   - Importar `mazefunnels@gmail.com` desde "Equipo desde HighLevel" → respuesta con `existing_account:true`, perfil creado en la org, y la cuenta sigue entrando con su contraseña de siempre (NO el código de acceso).
   - UI con GHL conectado → no aparece "Agregar miembro", aparece el hint.
   - Desconectar GHL → reaparece el alta manual; "Quitar" disponible en ambos estados.
</output>
