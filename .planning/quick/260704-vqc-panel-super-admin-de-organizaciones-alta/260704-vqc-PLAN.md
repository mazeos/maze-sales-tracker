---
phase: quick-260704-vqc
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [api/server.js, index.html]
autonomous: true
requirements: [QUICK-260704-VQC]

must_haves:
  truths:
    - "Un super-admin de Maze (email en SUPER_ADMIN_EMAILS) ve la sección Organizaciones al final de Configuraciones, con la lista de todas las orgs del tracker"
    - "Un super-admin puede crear una organización nueva con su admin desde el form, y recibe las credenciales (URL + email + contraseña) UNA sola vez en un box copiable"
    - "Un admin de una org cliente (no super-admin) NO ve la sección Organizaciones — ni el título"
    - "Si el email del admin nuevo ya pertenece a otra org del tracker, la creación falla con 409 y NO queda ninguna org huérfana creada"
    - "Sin SUPER_ADMIN_EMAILS configurada, GET/POST /api/orgs responde 403 siempre"
  artifacts:
    - path: "api/server.js"
      provides: "requireSuperAdmin + GET/POST /api/orgs con rollback"
      contains: "SUPER_ADMIN_EMAILS"
    - path: "index.html"
      provides: "Sección Organizaciones (tabla + form + box de credenciales) al final de Configuraciones"
      contains: "orgsCard"
  key_links:
    - from: "index.html"
      to: "/api/orgs"
      via: "fetch con Bearer session.access_token"
      pattern: "fetch\\('/api/orgs'"
    - from: "api/server.js router"
      to: "requireSuperAdmin"
      via: "gate antes de listOrgs/createOrg"
      pattern: "requireSuperAdmin"
---

<objective>
Panel super-admin de Organizaciones en Maze Sales Tracker: dar de alta tenants (org + su admin) desde la UI, visible SOLO para los super-admins de la plataforma (emails de Maze en env `SUPER_ADMIN_EMAILS`). Decisión de Alejandro: el alta de tenants es SOLO por este panel — no existe signup público, los clientes nunca se auto-registran.

Purpose: hoy dar de alta un tenant (org + admin) exige tocar la DB a mano. Con esto, Maze onboardea clientes nuevos desde la propia app.
Output: `GET/POST /api/orgs` gateados por `requireSuperAdmin` en `api/server.js` + sección "Organizaciones" al final de Configuraciones en `index.html`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@api/server.js
@index.html
@supabase/migrations/001_sales_tracker.sql

<interfaces>
<!-- Contratos ya existentes en el codebase. Usar directo, sin explorar. -->

De `api/server.js` (backend, Node nativo sin npm — http + crypto + fetch global):

```js
// Env ya parseadas arriba del archivo (líneas 25-58): SUPABASE_URL, SERVICE_ROLE_KEY, ANON_KEY, PORT, GHL_*...
function sendJSON(res, status, obj)                 // respuesta JSON estándar
function readJSONBody(req)                          // Promise<{ok, data}> — body JSON con guarda de 1MB
function svcHeaders(extra = {})                     // headers service-role para PostgREST/GoTrue admin
async function checkUserToken(bearerToken)          // valida JWT contra GoTrue /auth/v1/user → {ok, uid} | {ok:false, status, error}
                                                    // OJO: la respuesta de GoTrue incluye user.email — checkUserToken lo descarta
async function getAuthEmail(uid, cache)             // email lowercase/trim de un auth user vía GoTrue admin, cache Map por request
async function findAuthUserByEmail(emailNorm)       // listado paginado GoTrue admin (10 págs × 100), match exacto → user | null
// Patrón detección de email duplicado en GoTrue (createMember, línea 678):
//   authRes.status === 422 || 409 || /already|registered|exists|duplicate/i.test(JSON.stringify(authUser))
// Patrón rollback (createMember, líneas 704-713): si el INSERT del perfil falla →
//   DELETE /auth/v1/admin/users/{uid} best-effort + 500 "No se creó nada."
// Patrón adopción (importGhlUser, líneas 1339-1365): uid existente sin st_profile en NINGUNA org →
//   crear st_profile sobre ese uid, JAMÁS tocar su contraseña, respuesta con existing_account: true
// Router: http.createServer con if (req.method === X && path === Y) secuenciales (líneas 1431-1516)
```

Schema (001 + columnas agregadas por fases GHL, todas ya en la DB):

```sql
st_orgs:         id uuid pk default gen_random_uuid(), name text not null,
                 tz default 'America/Argentina/Buenos_Aires', team_mode default 'full', created_at timestamptz
st_profiles:     id uuid pk (= auth.users.id), org_id uuid not null, name text not null,
                 role check in ('admin','setter','triage','closer'), commission numeric default 0,
                 created_at; columnas posteriores usadas por el código: active bool, ghl_user_id text
st_integrations: org_id (una fila por org), provider, location_id, location_name, access_token, refresh_token...
                 -- al listar: select SOLO org_id,location_name — JAMÁS tokens
```

De `index.html` (SPA vanilla, un solo archivo):

```js
// Configuraciones = renderTeam() (state.view==='team'), línea 1318. Composición final (línea 1367):
//   VIEW.innerHTML = topbar('') + `...secciones...${addMemberBox}${ghlCard()}${ghlTeamCard()}` + footer();
function esc(s)                       // escape HTML — usar en TODO dato dinámico
function toast(msg, ms)               // notificación
// Patrón carga lazy (loadGhlStatus, línea 1027): flag LOADING + estado global null=no consultado,
//   const { data:{ session } } = await sb.auth.getSession();
//   fetch('/api/...',{headers:{'Authorization':'Bearer '+session.access_token}})
//   finally{ LOADING=false; if(state.view==='team') renderTeam(); }
// Patrón card condicional (ghlCard/ghlTeamCard): función que devuelve '' o el HTML de un
//   `<div class="section"><div class="eyebrow">Título</div>...</div>`
// Clases CSS existentes: section, eyebrow, grid2, field, inp, btn / btn ghost sm / btn danger sm,
//   rollup (wrapper de tabla), pill, empty, admin-lock, ghl-code / ghl-code-val / ghl-code-txt
// Box copiable de referencia: codeBox en ghlTeamCard (línea 1146) + copyGhlAccessCode (línea 1195,
//   navigator.clipboard con fallback textarea+execCommand)
// Handlers globales: window.nombreFn = async () => {...}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Backend — requireSuperAdmin + GET/POST /api/orgs en api/server.js</name>
  <files>api/server.js</files>
  <action>
Todo en `api/server.js`, siguiendo el estilo existente (comentarios en español, logs `[api] ...`, mensajes de error en español tuteo, cero dependencias npm).

**1. Env + helper `requireSuperAdmin`.** Junto a las demás envs del tope del archivo, parsear `SUPER_ADMIN_EMAILS` (lista separada por comas) una sola vez a un array `SUPER_ADMINS`: split por coma, lowercase, trim, filtrar vacíos. Documentar en el comentario de rutas del header del archivo las dos rutas nuevas. Implementar `async function requireSuperAdmin(req)`:
- Si `SUPER_ADMINS` está vacío → devolver de inmediato `{ ok:false, status:403, error:'Solo el equipo de Maze puede gestionar organizaciones' }` SIN llamar a la red (esto habilita el smoke test local sin Supabase).
- Extraer el bearer del header Authorization igual que `checkUserToken` (soporta 'Bearer x' o token pelado; vacío → 401 'Falta el token de sesión').
- Validar contra GoTrue `GET /auth/v1/user` con `apikey: ANON_KEY` (mismo fetch que `checkUserToken`, pero acá SÍ leer `user.email` además de `user.id` — no reusar `checkUserToken` porque descarta el email y obligaría a una segunda llamada). Status != 200 o sin uid → 401 'Sesión inválida'; error de red → 502.
- Normalizar `user.email` (lowercase/trim) y comparar contra `SUPER_ADMINS`; sin match → 403 con el mismo error de arriba. Match → `{ ok:true, uid, email }`.
- NO toca `st_profiles`: el super-admin es de plataforma, puede no tener perfil en ninguna org.

**2. `GET /api/orgs` → `async function listOrgs(req, res, sa)`.** Tres fetches masivos con `svcHeaders()` + N llamadas GoTrue para emails de admins (pocas orgs: N+1 aceptable):
- `GET /rest/v1/st_orgs?select=id,name,created_at&order=created_at.asc` (la columna created_at existe en 001).
- `GET /rest/v1/st_profiles?select=id,org_id,role,active` (todas; agrupar por org_id en memoria).
- `GET /rest/v1/st_integrations?select=org_id,location_name` (SOLO esas dos columnas — jamás tokens).
- Por org: `members_active` = count de perfiles con `active !== false` (incluye admins; null cuenta como activo, patrón existente); `ghl_connected` = existe fila en st_integrations; `ghl_location_name` = location_name o null; `admins` = emails de los perfiles `role==='admin'` (activos o no) resueltos con `getAuthEmail(p.id, cache)` usando UN Map cache compartido para todo el request, filtrando los null.
- Cualquier fetch a PostgREST con status != 200 → 500 'No se pudieron leer las organizaciones'; error de red → 502 mismo mensaje. Respuesta 200: `{ orgs: [...] }`. Log: `[api] GET /api/orgs super=${sa.email} n=${orgs.length} -> 200`.

**3. `POST /api/orgs` → `async function createOrg(req, res, sa)`.** Body `{name, admin_name, admin_email, admin_password?}` vía `readJSONBody`:
- Validaciones (400): `name` trim no vacío → 'Tienes que poner el nombre de la organización'; `admin_name` trim no vacío → 'Tienes que poner el nombre del admin'; `admin_email` trim + regex básica tipo `/^\S+@\S+\.\S+$/` → 'El email del admin no es válido'; si viene `admin_password` (string no vacío) exigir >= 8 chars → 'La contraseña tiene que tener al menos 8 caracteres'.
- Password: si no vino, autogenerar con `crypto.randomBytes` → `toString('base64url')`, removiendo caracteres confusos (regex `/[-_0OoIl1]/g`), acumulando en un loop hasta juntar 14 chars y cortando en 14. Marcar `generated = true`. NUNCA loggear la contraseña (ni la autogenerada ni la del body).
- (a) Crear la org: `POST /rest/v1/st_orgs` con `Prefer: return=representation` y body `{ name }` — tz y team_mode salen de los defaults del schema 001 (Buenos Aires / full), no hardcodearlos acá. Fallo → 500 'No se pudo crear la organización'.
- (b) Resolver el auth user. Intentar `POST /auth/v1/admin/users` con `{ email, password, email_confirm: true }` (patrón createMember). Si responde duplicado (mismo test de createMember: status 422/409 o regex `/already|registered|exists|duplicate/i` sobre el JSON):
  - `findAuthUserByEmail(emailNorm)` (emailNorm = lowercase/trim). Si null → rollback org (DELETE `/rest/v1/st_orgs?id=eq.{orgId}` best-effort) + 500 genérico 'No se pudo crear el usuario. Inténtalo de nuevo.' (no filtrar info del auth compartido — patrón importGhlUser).
  - Si el uid tiene st_profile en ALGUNA org (`GET /rest/v1/st_profiles?id=eq.{uid}&select=id,org_id`, fila presente) → rollback org + 409 `{error:'Ese email ya pertenece a otro equipo del tracker'}`.
  - Si no tiene perfil → adoptar la cuenta: usar ese uid, `existing_account = true`, `createdAuth = false`, y JAMÁS tocar su contraseña ni ningún atributo del auth user (es una cuenta viva de otra app del GoTrue compartido — patrón importGhlUser rama adopción).
  - Cualquier otro fallo del create (status fuera de 2xx o sin id) → rollback org + 500 genérico.
  - Si el create salió bien → `createdAuth = true`, `existing_account = false`.
- (c) Crear el perfil admin: `POST /rest/v1/st_profiles` con `{ id: uid, org_id: orgId, name: admin_name, role: 'admin', commission: 0 }`. Si falla → rollback doble best-effort: DELETE de la org creada Y DELETE del auth user (`DELETE /auth/v1/admin/users/{uid}`) SOLO si `createdAuth` (nunca borrar una cuenta adoptada) → 500 'No se pudo crear el admin. No se creó nada.'.
- Respuesta 200: `{ org: {id, name}, admin_email, existing_account }` e incluir `admin_password` SOLO si `generated && createdAuth` (si la cuenta ya existía, entra con su contraseña de siempre; si la password vino en el body, el super-admin ya la conoce). Log sin password: `[api] POST /api/orgs super=${sa.email} created org=${orgId} admin=${uid} existing=${existing_account} -> 200`.

**4. Router.** Antes del bloque de `/api/members`, agregar: si `path === '/api/orgs'` y método GET o POST → `const sa = await requireSuperAdmin(req); if (!sa.ok) return sendJSON(res, sa.status, {error: sa.error});` y despachar a `listOrgs` / `createOrg`.
  </action>
  <verify>
    <automated>node --check api/server.js && (SUPABASE_URL=http://127.0.0.1:1 SERVICE_ROLE_KEY=x ANON_KEY=x PORT=3999 node api/server.js & SVPID=$!; sleep 1; GETC=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3999/api/orgs); POSTC=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3999/api/orgs -H 'Content-Type: application/json' -d '{}'); kill $SVPID; echo "GET=$GETC POST=$POSTC"; [ "$GETC" = "403" ] && [ "$POSTC" = "403" ])</automated>
  </verify>
  <done>`node --check` pasa. Con la API arrancada SIN `SUPER_ADMIN_EMAILS`, GET y POST /api/orgs devuelven 403 (aún sin token). requireSuperAdmin no consulta st_profiles. El flujo POST implementa rollback en las 3 ramas de fallo y la password autogenerada solo viaja en la respuesta cuando generated && createdAuth, y jamás aparece en un console.log.</done>
</task>

<task type="auto">
  <name>Task 2: Frontend — sección Organizaciones al final de Configuraciones en index.html</name>
  <files>index.html</files>
  <action>
Todo en `index.html`, copiando los patrones existentes (carga lazy estilo `loadGhlStatus`, card estilo `ghlCard`/`ghlTeamCard`, `esc()` en todo dato dinámico, español tuteo).

**1. Estado global + carga lazy.** Junto a los estados GHL, declarar: `let ORGS=null, ORGS_ALLOWED=null, ORGS_LOADING=false, ORG_CREATED=null;` (`ORGS_ALLOWED`: null = todavía no se consultó, false = 401/403 → no renderizar nada, true = super-admin). `async function loadOrgs()`: guard `if(ORGS_LOADING) return;`, tomar la sesión con `sb.auth.getSession()` (sin sesión → `ORGS_ALLOWED=false`), fetch `GET /api/orgs` con `Authorization: Bearer session.access_token`; si `res.ok` → `ORGS = data.orgs || []` y `ORGS_ALLOWED = true`; si status 401/403 → `ORGS_ALLOWED = false` (silencioso, sin toast: un admin normal no debe enterarse de que la sección existe); otro error → `ORGS_ALLOWED = false` también (fail-closed). `finally{ ORGS_LOADING=false; if(state.view==='team') renderTeam(); }`. Se dispara UNA vez por sesión de vista: solo cuando `ORGS_ALLOWED===null` (mismo truco que `GHL_STATUS===null` en ghlCard).

**2. `function orgsCard()`.** Devuelve `''` si `ORGS_ALLOWED===false`. Si `ORGS_ALLOWED===null` → llamar `loadOrgs()` y devolver `''` (no mostrar ni el título hasta confirmar 200). Si `true`, devolver una `<div class="section">` con eyebrow "Organizaciones" que contiene, en orden:
- (a) **Box de credenciales** (solo si `ORG_CREATED` no es null — ver punto 4): reusar el patrón visual de `.ghl-code` (o inline styles con `var(--line)`/`var(--muted)` para contraste en ambos temas). Contenido: nombre de la org creada, la URL de la app (`location.origin`), el email del admin y — solo si vino `admin_password` en la respuesta — la contraseña. Si `existing_account` es true, en lugar de contraseña mostrar: "Ya tenía cuenta — entra con su contraseña de siempre". Aviso destacado: "Guardá estas credenciales ahora: no se vuelven a mostrar". Botón "Copiar" que copia un bloque de texto plano (URL + email + contraseña si existe) con `navigator.clipboard.writeText` y fallback textarea+`document.execCommand('copy')` (mismo patrón exacto que `copyGhlAccessCode`). Botón o ✕ para cerrar el box (`ORG_CREATED=null; renderTeam();`).
- (b) **Tabla de orgs** con el patrón `<div class="rollup"><table>` de `ghlTeamCard`: columnas Nombre | Miembros | HighLevel | Admins. Por fila: `esc(o.name)`, `o.members_active`, `o.ghl_connected ? esc(o.ghl_location_name || 'Conectado') : '—'`, `o.admins` unidos por coma (esc cada uno) o '—'. Sin orgs → `<div class="empty">`.
- (c) **Form "Nueva organización"**: sub-bloque con `grid2` + `field`/`inp`: Nombre de la organización (`id="orgName"`), Nombre del admin (`id="orgAdminName"`), Email del admin (`id="orgAdminEmail"`, type email), Contraseña (`id="orgAdminPass"`, type text, placeholder/hint "dejá vacío para autogenerar"). Botón `class="btn"` "Crear organización" → `onclick="createOrg()"`.

**3. Composición.** En `renderTeam()` (línea ~1367), agregar `${orgsCard()}` al FINAL, después de `${ghlTeamCard()}` y antes de `footer()` — la sección queda al final de Configuraciones, después de todo lo existente.

**4. `window.createOrg`.** Leer y trim los 4 inputs; validar client-side (toast y return): nombre org, nombre admin, email no vacíos; si hay contraseña, >= 8 chars. Deshabilitar doble-submit con un flag. Tomar sesión, `POST /api/orgs` con `Content-Type: application/json` + Bearer, body `{name, admin_name, admin_email, admin_password}` (omitir `admin_password` del body si quedó vacío). Si `res.ok`: guardar `ORG_CREATED = { name: data.org.name, email: data.admin_email, password: data.admin_password || null, existing: !!data.existing_account }`, toast 'Organización creada', y refrescar la tabla re-disparando el fetch (`ORGS_ALLOWED=null; loadOrgs();` — el box `ORG_CREATED` sobrevive al refresh porque es estado aparte) — la contraseña NUNCA se persiste (ni localStorage ni logs), vive solo en `ORG_CREATED` hasta que se cierre el box o se navegue. Si error: `toast(data.error || 'No se pudo crear la organización')` (cubre el 409 "Ese email ya pertenece a otro equipo del tracker"). Error de red → toast 'No se pudo conectar con el servidor'.
  </action>
  <verify>
    <automated>c1=$(grep -c "orgsCard" /Users/alevogeler/maze-sales-tracker/index.html); c2=$(grep -c "'/api/orgs'" /Users/alevogeler/maze-sales-tracker/index.html); c3=$(grep -c "createOrg" /Users/alevogeler/maze-sales-tracker/index.html); echo "orgsCard=$c1 api=$c2 createOrg=$c3"; [ "$c1" -ge 2 ] && [ "$c2" -ge 2 ] && [ "$c3" -ge 2 ] && node --check api/server.js</automated>
  </verify>
  <done>`orgsCard()` existe y está compuesta al final de `renderTeam()` (después de `ghlTeamCard()`). Con 401/403 en GET /api/orgs no se renderiza NADA de la sección (ni título). El box de credenciales muestra URL + email + contraseña solo cuando el backend la devolvió, con aviso de "no se vuelven a mostrar", variante existing_account, botón Copiar con fallback, y la tabla se refresca tras crear. Todo dato dinámico pasa por `esc()`.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → /api/orgs | Input no confiable cruza al backend con service-role detrás |
| GoTrue compartido | auth.users es compartido entre apps (tracker, CallIQ…): un email duplicado NO implica org del tracker |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-vqc-01 | Elevation of privilege | GET/POST /api/orgs | mitigate | `requireSuperAdmin`: JWT validado contra GoTrue + email comparado contra `SUPER_ADMIN_EMAILS` (env, nunca en código — repo público). Lista vacía = fail-closed 403 |
| T-vqc-02 | Information disclosure | respuesta POST /api/orgs | mitigate | `admin_password` viaja UNA sola vez, solo si generated && createdAuth; jamás en logs ni en localStorage; UI avisa "no se vuelven a mostrar" |
| T-vqc-03 | Information disclosure | GET /api/orgs (st_integrations) | mitigate | select limitado a `org_id,location_name` — tokens jamás salen del server |
| T-vqc-04 | Tampering | rollback parcial en POST | mitigate | rollback org en toda rama de fallo post-creación; DELETE del auth user SOLO si fue creado por este endpoint (cuentas adoptadas intactas, patrón importGhlUser) |
| T-vqc-05 | Spoofing | email duplicado en GoTrue compartido | mitigate | resolución vía `findAuthUserByEmail` + chequeo de st_profile en cualquier org → 409; sin match → 500 genérico sin filtrar info del auth compartido |
</threat_model>

<verification>
- `node --check api/server.js` pasa.
- API arrancada con envs dummy y SIN `SUPER_ADMIN_EMAILS`: `GET /api/orgs` y `POST /api/orgs` → 403 (fail-closed).
- `grep -n "SUPER_ADMIN" api/server.js` no muestra ningún email hardcodeado (repo público).
- Ningún `console.log` del flujo createOrg incluye la variable de la contraseña.
- El ejecutor NO hace SSH ni deploy — la verificación e2e queda para post-merge.
</verification>

<success_criteria>
- Endpoints `GET/POST /api/orgs` implementados con `requireSuperAdmin` (env `SUPER_ADMIN_EMAILS`, sin dependencia de st_profiles) y las tres ramas de duplicado (409 otra org / adopción / 500 genérico) + rollbacks.
- Sección "Organizaciones" al final de Configuraciones: tabla, form de alta y box de credenciales copiable de un solo uso; invisible por completo para no-super-admins.
- Cero secretos en el repo; contraseña autogenerada visible una única vez.
</success_criteria>

<output>
Al terminar, crear `.planning/quick/260704-vqc-panel-super-admin-de-organizaciones-alta/260704-vqc-SUMMARY.md`.

## Post-merge (orquestador — NO lo hace el ejecutor)

1. Agregar `SUPER_ADMIN_EMAILS` (emails del equipo Maze, separados por coma) al `.env` del entorno de pruebas del tracker.
2. Deploy (patrón habitual del proyecto en el VPS).
3. QA e2e: (a) login con un email super-admin → Configuraciones muestra "Organizaciones" con la lista (Clara visible); (b) crear una org de prueba con password autogenerada → box de credenciales aparece una vez, login del admin nuevo funciona; (c) repetir con el email de un miembro existente de otra org → 409; (d) login con el admin de Clara → la sección NO aparece; (e) borrar la org de prueba de la DB al terminar.
</output>
