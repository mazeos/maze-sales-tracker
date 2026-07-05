---
phase: quick-260704-wmy
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supabase/migrations/007_platform_settings.sql
  - api/server.js
  - index.html
autonomous: true
requirements: [QUICK-260704-WMY]
must_haves:
  truths:
    - "Un super-admin (email en SUPER_ADMIN_EMAILS) ve el ítem 'Plataforma' en el rail; un admin normal NO lo ve jamás"
    - "El super-admin puede guardar/reemplazar/borrar el token de agencia GHL; la app valida el token EN VIVO contra locations/search antes de guardarlo"
    - "El token completo JAMÁS sale de la API: solo un hint '····' + últimos 4 caracteres"
    - "El super-admin busca subcuentas reales de la agencia por nombre/email/id y ve cuáles ya están vinculadas a una org"
    - "Crear una organización con subcuenta pre-vinculada deja una fila en st_integrations con location_id/location_name y SIN tokens"
    - "La sección Organizaciones vive en la vista Plataforma; en Configuraciones ya no existe"
    - "Un admin de una org con subcuenta pre-asignada ve 'Subcuenta asignada: X — falta autorizar' y si autoriza OTRA subcuenta en el OAuth, la app NO guarda y avisa location_mismatch"
  artifacts:
    - path: "supabase/migrations/007_platform_settings.sql"
      provides: "Tabla st_platform_settings con RLS deny-all"
      contains: "st_platform_settings"
    - path: "api/server.js"
      provides: "Endpoints /api/platform/settings, /api/platform/locations, POST /api/orgs con location_id, getGhlStatus pending, oauthCallback location_mismatch"
      contains: "searchAgencyLocations"
    - path: "index.html"
      provides: "Vista Plataforma (renderPlatform) con card de API de agencia + Organizaciones movidas + buscador de subcuentas"
      contains: "renderPlatform"
  key_links:
    - from: "index.html renderPlatform"
      to: "/api/platform/locations"
      via: "fetch con debounce 400ms"
      pattern: "api/platform/locations"
    - from: "api/server.js createOrg"
      to: "st_integrations"
      via: "INSERT pre-vínculo sin tokens tras crear org+admin"
      pattern: "location_id"
    - from: "api/server.js oauthCallback"
      to: "?ghl_error=location_mismatch"
      via: "redirect cuando la location autorizada difiere de la pre-asignada"
      pattern: "location_mismatch"
    - from: "api/server.js getGhlCreds"
      to: "fallback env PIT / null"
      via: "fila sin access_token = NO conectada"
      pattern: "access_token"
---

<objective>
Vista "Plataforma" exclusiva del super-admin en Maze Sales Tracker: configurar la API de agencia de GHL (token editable, validado en vivo, guardado en DB con hint de 4 chars), buscar subcuentas reales de la agencia (100+ locations, paginado + filtro q) y crear organizaciones ya pre-vinculadas a una subcuenta (fila en st_integrations sin tokens; el OAuth del cliente completa el vínculo después). La sección Organizaciones se muda de Configuraciones a esta vista.

Purpose: hoy el alta de una org y su conexión GHL son dos pasos desconectados y a ciegas — Ale tiene que crear la org, pasarle credenciales al cliente y esperar que el cliente autorice la subcuenta correcta entre 100+. Con el pre-vínculo, la subcuenta queda asignada desde el alta y el OAuth solo puede completarla (mismatch = rechazo).

Output: migración 007 + endpoints platform en api/server.js + vista Plataforma en index.html.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@api/server.js
@index.html
@supabase/migrations/003_integrations.sql

**Repo público — CERO secretos en código, logs o respuestas.** El agency PIT solo vive en la DB (st_platform_settings, deny-all) y en las respuestas solo viaja el hint `····XXXX`.

**Contratos GHL ya verificados en vivo (NO investigar):**
- El Agency PIT lista subcuentas con `GET https://services.leadconnectorhq.com/locations/search?limit=100&skip=N` (header `Version: 2021-07-28`; respuesta `{locations:[{id,name,city,country,email,...}]}`; paginación con `skip`).
- Ese mismo token NO puede operar DENTRO de una subcuenta (401 "Token's user type mismatch") — por eso el OAuth por org sigue existiendo y el pre-vínculo guarda SOLO location_id/location_name, sin tokens.
- La agencia de Ale tiene 100+ subcuentas → el buscador con `q` es necesario.

<interfaces>
Patrones existentes de api/server.js que el ejecutor DEBE reutilizar (no reinventar):

```javascript
// Auth super-admin (línea ~233): fail-closed 403 si SUPER_ADMIN_EMAILS vacío.
async function requireSuperAdmin(req) // -> { ok, uid, email } | { ok:false, status, error }

// Headers Supabase service-role (línea ~129):
function svcHeaders(extra = {}) // apikey + Authorization Bearer SERVICE_ROLE_KEY

// Headers GHL (línea ~93):
function ghlHeaders(token, version = '2021-07-28')
const GHL_BASE = 'https://services.leadconnectorhq.com';

// Fila completa de st_integrations por org (línea ~307) — incluye tokens, solo server-side:
async function getIntegration(orgId) // -> row | null

// Refresh OAuth (línea ~323): lanza Error si falla. HOY asume refresh_token presente.
async function refreshGhlToken(integration)

// Credenciales por org (línea ~375): HOY `if (integration)` trata CUALQUIER fila como conectada.
async function getGhlCreds(orgId) // -> { token, locationId, integration } | null

// Respuestas: sendJSON(res, status, obj) / readJSONBody(req) / redirect(res, url)
// Upsert PostgREST: POST ...?on_conflict=col + header Prefer: resolution=merge-duplicates
```

Patrones existentes de index.html:

```javascript
// Rail estático: .nav-i con data-view; listeners bindeados con querySelectorAll al cargar
// el script (línea ~570) — un ítem nuevo en el HTML estático se bindea solo.
// Router: state.view + go(view) + render() con cadena if/else (línea ~581).
// Estado lazy por sección: let X=null, X_LOADING=false; función loadX() que fetchea con
// el access_token de sb.auth.getSession() y al final re-renderiza si state.view coincide.
// Sección Organizaciones actual (líneas ~1319-1448): ORGS/ORGS_ALLOWED/ORG_CREATED/
// orgsCard()/loadOrgs()/window.createOrg/copyOrgCreds/closeOrgCreds — HOY renderiza
// dentro de renderTeam() (línea ~1499: `${ghlCard()}${ghlTeamCard()}${orgsCard()}`).
// Query params post-OAuth: boot() lee ?ghl= / ?ghl_error= (línea ~1715).
// Helpers UI: esc(), toast(msg,ms), info(tip), .section/.eyebrow/.rollup/.grid2/.field/.inp/.btn/.chip
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migración st_platform_settings + endpoints /api/platform/* en server.js</name>
  <files>supabase/migrations/007_platform_settings.sql, api/server.js</files>
  <action>
**1a. Crear `supabase/migrations/007_platform_settings.sql`** (007 = siguiente al último existente, 006_integration_calendar.sql). Contenido, siguiendo el estilo comentado de 003_integrations.sql: tabla `public.st_platform_settings` con `key text primary key`, `value text not null`, `updated_at timestamptz default now()`. RLS habilitada SIN policies (deny-all: el agency PIT solo lo lee/escribe la service role de la mini-API). Idempotente: `create table if not exists` + `alter table ... enable row level security`. Comentario de cabecera explicando la decisión de seguridad (mismo patrón que 003).

**1b. Helpers de settings en api/server.js** (ubicarlos cerca de getIntegration, con comentarios en español rioplatense como el resto del archivo):
- `getPlatformSetting(key)` → GET `/rest/v1/st_platform_settings?key=eq.{key}&select=value` con svcHeaders; devuelve `value` o `null` (también null en error de red — patrón getIntegration).
- `setPlatformSetting(key, value)` → POST `/rest/v1/st_platform_settings?on_conflict=key` con `Prefer: resolution=merge-duplicates`, body `{key, value, updated_at}`. Devuelve boolean de éxito.
- `deletePlatformSetting(key)` → DELETE `?key=eq.{key}`. Devuelve boolean.
- Constante `PIT_KEY = 'ghl_agency_pit'` (el nombre de la key, no el valor — no es un secreto).

**1c. `GET /api/platform/settings`** (handler `getPlatformSettings`, guard `requireSuperAdmin` en el router): lee el setting y responde `{agency_pit_set: bool, agency_pit_hint: '····'+value.slice(-4) || null}`. El token completo JAMÁS sale en la respuesta ni en logs.

**1d. `POST /api/platform/settings`** (handler `setPlatformSettings`, requireSuperAdmin): body `{agency_pit}` (string, trim). Si queda vacío/null → `deletePlatformSetting` → `{ok:true, agency_pit_set:false}`. Si no vacío → validar EN VIVO: `GET {GHL_BASE}/locations/search?limit=1` con `ghlHeaders(agency_pit)`; si el status no es 2xx → 400 `{error:"Token de agencia inválido o sin permisos de locations"}`; si valida → guardar y responder `{ok:true, agency_pit_set:true, agency_pit_hint:'····'+últimos4}`. En el console.log de la ruta loggear solo `set/cleared` y el email del super-admin — jamás el token.

**1e. Helper `searchAgencyLocations(pit, q)`**: pagina `GET {GHL_BASE}/locations/search?limit=100&skip={0|100|200}` con `ghlHeaders(pit)` hasta 3 páginas (300 locations máx); acumula `body.locations`; corta antes si una página vuelve con menos de 100. Si una página responde no-2xx, lanza Error (el caller responde 502). Filtro: `q` lowercase/trim contra `name`, `email` e `id` (includes); `q` vacío = todas. Devuelve array `[{id, name, city, country}]` (jamás el objeto crudo de GHL).

**1f. `GET /api/platform/locations?q=`** (handler `listAgencyLocations`, requireSuperAdmin): lee el PIT con `getPlatformSetting(PIT_KEY)`; sin config → 409 `{error:"Configurá primero el token de agencia"}`. Llama `searchAgencyLocations(pit, q)` (try/catch → 502 `{error:"No se pudo hablar con HighLevel. Probá de nuevo."}`). Anota `linked_org`: un fetch a `/rest/v1/st_integrations?select=org_id,location_id` + otro a `/rest/v1/st_orgs?select=id,name` con svcHeaders; mapea location_id → nombre de la org (o el org_id si el nombre no aparece). Respuesta: `{locations:[{id,name,city,country,linked_org}]}` con **máximo 20 resultados** (slice tras filtrar).

**1g. Router**: agregar bajo el bloque de `/api/orgs` — `if (path === '/api/platform/settings' && (GET||POST))` y `if (req.method==='GET' && path === '/api/platform/locations')`, ambos con `const sa = await requireSuperAdmin(req); if (!sa.ok) return sendJSON(...)` (mismo patrón exacto que /api/orgs). Actualizar el comentario-índice de rutas al tope del archivo con las 3 rutas nuevas.
  </action>
  <verify>
    <automated>node --check api/server.js && grep -c "st_platform_settings" supabase/migrations/007_platform_settings.sql && grep -v "^\s*//" api/server.js | grep -c "api/platform/settings\|api/platform/locations\|searchAgencyLocations" && ! grep -v "^\s*--" supabase/migrations/007_platform_settings.sql | grep -qi "create policy"</automated>
  </verify>
  <done>server.js parsea sin errores; la migración 007 crea st_platform_settings con RLS sin policies; existen los 2 endpoints platform + searchAgencyLocations, guardados por requireSuperAdmin; ninguna respuesta ni log contiene el token completo (solo hint de 4 chars).</done>
</task>

<task type="auto">
  <name>Task 2: Pre-vínculo en POST /api/orgs + estado pending + null-safety de tokens + guard en oauthCallback</name>
  <files>api/server.js</files>
  <action>
**2a. `POST /api/orgs` extendido (createOrg)**: aceptar `location_id` opcional en el body (string, trim). Si viene, ANTES de crear la org (fail-fast, sin complicar el rollback existente):
1. PIT configurado: `getPlatformSetting(PIT_KEY)`; sin config → 409 `{error:"Configurá primero el token de agencia"}`.
2. La location existe en la agencia: `searchAgencyLocations(pit, '')` (try/catch → 502) y buscar el id en el resultado completo (las 3 páginas, SIN el slice de 20); si no está → 400 `{error:"Esa subcuenta no existe en tu agencia"}`.
3. NO está ya vinculada: GET `/rest/v1/st_integrations?location_id=eq.{id}&select=org_id` con svcHeaders; si hay fila, leer el nombre de la org (`/rest/v1/st_orgs?id=eq.{org_id}&select=name`) → 409 `{error:"Esa subcuenta ya está vinculada a "+orgName}`.

Después del flujo existente (org + perfil admin creados, INTACTO), si hubo `location_id` validado: INSERT a `/rest/v1/st_integrations` con `{org_id, provider:'ghl', location_id, location_name}` (location_name = el `name` de la location encontrada en el paso 2) — **sin tokens** (quedan null; la migración 003 los permite nullables). Si este INSERT falla → NO abortar ni rollbackear (la org ya existe y es válida): sumar a la respuesta `{linked:false, warning:"La organización se creó pero no se pudo asignar la subcuenta. Asignala de nuevo o conectá por OAuth."}`. Si el INSERT anda, la respuesta suma `{location_id, location_name}`.

**2b. `getGhlStatus`**: agregar `access_token` al select (server-side only — JAMÁS al response). Si hay fila y `access_token` es null → responder `{connected:false, pending:true, location_id, location_name}`. Si hay fila con token → respuesta actual (`connected:true,...`). Sin fila → `{connected:false}`.

**2c. Null-safety — fila pre-vinculada sin tokens = NO conectada:**
- `getGhlCreds`: cambiar `if (integration)` por `if (integration && integration.access_token)` — una fila pending cae al fallback env PIT o null, como si no hubiera integración.
- `refreshGhlToken`: guard defensivo al inicio — `if (!integration.refresh_token) throw new Error('Integración sin tokens (pendiente de autorizar)')`, así nunca postea `refresh_token: undefined` a GHL.
- `listGhlUsers` y `importGhlUser`: donde hoy chequean `if (!integration)` → 409 "Conectá tu cuenta de HighLevel primero", extender a `if (!integration || !integration.access_token)` (una org pending no puede listar/importar usuarios todavía).
- Revisar que ningún otro uso de `getIntegration(...)` trate la fila pending como conectada (`setGhlCalendar` y `ghlLeads` pasan por getGhlCreds, quedan cubiertos por el primer punto).

**2d. `oauthCallback` — guard location_mismatch**: después de obtener tokens (paso 3 actual) y ANTES del upsert (paso 5), leer la fila existente con `getIntegration(orgId)`. Si hay fila con `location_id` y difiere de `tok.locationId` → NO guardar nada y `redirect(res, PUBLIC_URL + '/?ghl_error=location_mismatch')` (con console.log del mismatch: org, esperada, autorizada — IDs, no tokens). Si coincide (o no había fila / no tenía location_id) → upsert normal (los tokens completan el pre-vínculo; el upsert existente ya pisa location_name con el real).
  </action>
  <verify>
    <automated>node --check api/server.js && grep -v "^\s*//" api/server.js | grep -c "location_mismatch" && grep -v "^\s*//" api/server.js | grep -c "pending" && SUPABASE_URL=http://localhost:9 SERVICE_ROLE_KEY=x ANON_KEY=x PORT=3987 node api/server.js & sleep 1; C1=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3987/api/platform/settings); C2=$(curl -s -o /dev/null -w '%{http_code}' 'http://localhost:3987/api/platform/locations?q=x'); C3=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3987/api/health); kill %1 2>/dev/null; [ "$C1" = "403" ] && [ "$C2" = "403" ] && [ "$C3" = "200" ]</automated>
  </verify>
  <done>Con SUPER_ADMIN_EMAILS vacío, los endpoints platform responden 403 fail-closed sin tocar la red; createOrg valida PIT + existencia + no-duplicado antes de crear y pre-vincula sin tokens después (warning si el insert falla, sin abortar); getGhlStatus expone pending; getGhlCreds/refreshGhlToken/listGhlUsers/importGhlUser tratan fila sin access_token como no conectada; oauthCallback rechaza con ?ghl_error=location_mismatch si la subcuenta autorizada difiere de la pre-asignada.</done>
</task>

<task type="auto">
  <name>Task 3: Vista Plataforma en index.html — rail, renderPlatform, mudanza de Organizaciones, buscador y card pending</name>
  <files>index.html</files>
  <action>
**3a. Ítem del rail**: nuevo `.nav-i` con `data-view="platform"`, `id="nav-platform"`, `title="Plataforma"`, SVG de edificio/torre en el estilo existente (viewBox 24, stroke currentColor, stroke-width 1.8 — ej. rect vertical con ventanitas), `<span class="tt">Plataforma</span>`. Insertarlo DESPUÉS del ítem "goals" y ANTES de `<div class="spacer">`. Oculto por defecto: `style="display:none"`. Como el rail es HTML estático y los listeners se bindean con querySelectorAll al cargar el script, el ítem queda bindeado solo — no tocar el binding.

**3b. Detección super-admin (un único fetch tras el login)**: variables `let IS_SUPER=false, PLAT_SETTINGS=null;`. En `boot()`, después de setear ME/IS_ADMIN, un fetch a `/api/platform/settings` con el access_token: si 200 → `IS_SUPER=true; PLAT_SETTINGS=data;` y mostrar el ítem (`document.getElementById('nav-platform').style.display=''`). Cualquier otro status o error de red → queda oculto, silencioso (fail-closed, mismo espíritu que ORGS_ALLOWED). No bloquear el boot: puede ser un `.then()` best-effort o un await con try/catch.

**3c. Router**: en `render()`, agregar `else if(state.view==='platform') renderPlatform();`. `renderPlatform()` abre con guard: `if(!IS_SUPER){ go('dashboard'); return; }`.

**3d. `renderPlatform()` — card "API de agencia HighLevel"**: estado según PLAT_SETTINGS (`Configurada ····XXXX` con el hint, o `No configurada`); input `type="password"` id `platPit` placeholder "Pegá el Private Integration Token de agencia" (siempre editable — pedido de Ale) + botón Guardar → `window.savePlatPit`: POST `/api/platform/settings` body `{agency_pit: valor}`; si ok → actualizar PLAT_SETTINGS con la respuesta, toast ('Token de agencia guardado' / 'Token de agencia eliminado' si quedó vacío) y re-render; si error → toast con `data.error`. Guardar con input vacío = borrar el token (el backend ya lo maneja).

**3e. Mudanza de Organizaciones**: la sección completa (box de credenciales ORG_CREATED + tabla ORGS + form de alta, hoy en `orgsCard()`) se renderiza dentro de `renderPlatform()`. Quitar `${orgsCard()}` de `renderTeam()` POR COMPLETO (y con ello su disparo de `loadOrgs()` desde Configuraciones). Ajustar los re-renders del ciclo de vida: en `loadOrgs()` (finally), `createOrg` y `closeOrgCreds`, reemplazar `renderTeam()` / `if(state.view==='team') renderTeam()` por `if(state.view==='platform') renderPlatform()`. La simplificación permitida: dentro de renderPlatform, `orgsCard()` ya no necesita el guard ORGS_ALLOWED como cloak (la vista entera ya es solo super-admin), pero mantener el estado lazy (`ORGS===null → loadOrgs()` + "Cargando…").

**3f. Buscador de subcuenta en el form de alta**: estado `let PLAT_LOC_SEL=null; let _locT;`. En el form de "Nueva organización", agregar un field "Subcuenta de HighLevel (opcional)": si `PLAT_LOC_SEL` → chip fijado `{name} ✕` (el ✕ llama `window.clearPlatLoc` → PLAT_LOC_SEL=null + re-render); si no → input id `platLocQ` placeholder "Buscar subcuenta de tu agencia…" con `oninput="platLocSearch(this.value)"` + contenedor `<div id="platLocResults"></div>`. `window.platLocSearch`: debounce 400ms (clearTimeout/setTimeout en `_locT`) → GET `/api/platform/locations?q=`+encodeURIComponent(q) → pintar SOLO `#platLocResults` con innerHTML (NUNCA re-render completo: se pierde el foco del input): lista de filas clickeables (nombre + `city, country` en muted); si `linked_org` → fila deshabilitada (opacity, sin onclick) con nota "ya vinculada a {org}"; si 409 → mostrar el error del backend como hint ("Configurá primero el token de agencia"); si vacío → "Sin resultados". Click en una fila → `window.pickPlatLoc(id, name)` → `PLAT_LOC_SEL={id,name}` + re-render (aparece el chip). Escapar SIEMPRE con `esc()` todo dato de GHL. `window.createOrg`: si `PLAT_LOC_SEL`, sumar `location_id: PLAT_LOC_SEL.id` al body; al crear ok, limpiar PLAT_LOC_SEL; si la respuesta trae `warning`, toast del warning (además del flujo normal). Crear sin subcuenta sigue permitido (body sin location_id).

**3g. Card Integración del tenant (Configuraciones, `ghlCard()`)**: nuevo estado — si `GHL_STATUS.pending` → `Subcuenta asignada: <b>{location_name}</b> — falta autorizar la conexión` + botón "Conectar con HighLevel" (el `connectGhl()` existente, sin cambios; ubicar el branch entre `connected` y el else final). Además: flag `let GHL_MISMATCH=false;` — en el handler de query params de `boot()`, agregar el caso `ghl_error==='location_mismatch'` → `GHL_MISMATCH=true` + toast 'Autorizaste otra subcuenta de HighLevel' (y el replaceState existente). En `ghlCard()`, si estado pending y GHL_MISMATCH → banner `admin-lock`: "⚠️ Autorizaste otra subcuenta. Tenés que elegir {location_name}." (con el location_name de GHL_STATUS).
  </action>
  <verify>
    <automated>grep -c 'data-view="platform"' index.html && grep -c "renderPlatform" index.html && grep -c "api/platform/locations" index.html && ! sed -n '/^function renderTeam/,/^window.setAgName/p' index.html | grep -q "orgsCard" && grep -c "location_mismatch" index.html && grep -c "pending" index.html</automated>
  </verify>
  <done>El ítem Plataforma existe oculto por defecto y se muestra solo si GET /api/platform/settings devuelve 200; renderPlatform muestra la card del token (estado + input password siempre editable + guardar/borrar) y la sección Organizaciones completa con buscador de subcuenta (debounce 400ms, resultados con linked_org deshabilitado, chip con ✕, alta con y sin location_id); renderTeam ya no contiene orgsCard; la card del tenant muestra el estado pending con botón Conectar y el aviso de location_mismatch.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → /api/platform/* | Input no confiable de super-admin (token, q, location_id) |
| browser → POST /api/orgs (location_id) | El cliente podría inyectar una location ajena o duplicada |
| API → GHL (agency PIT) | Secreto de máximo privilegio: lista TODAS las subcuentas de la agencia |
| GHL → oauthCallback | Un cliente puede autorizar una subcuenta distinta a la asignada |
| datos GHL → DOM | name/city/email de locations van al innerHTML del buscador |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-Q1-01 | Information Disclosure | agency PIT en respuestas/logs | mitigate | Solo hint `····`+4 chars sale de la API; logs registran set/cleared, jamás el valor; st_platform_settings deny-all (RLS sin policies) |
| T-Q1-02 | Elevation of Privilege | /api/platform/* | mitigate | requireSuperAdmin en TODAS las rutas platform; SUPER_ADMIN_EMAILS vacío = 403 fail-closed; el rail se oculta pero la seguridad es server-side |
| T-Q1-03 | Tampering | POST /api/orgs con location_id forjada | mitigate | Re-validación server-side: la location debe existir en la agencia (searchAgencyLocations) y no estar en st_integrations; jamás se confía en el body |
| T-Q1-04 | Spoofing | oauthCallback con subcuenta equivocada | mitigate | Guard location_mismatch: si la fila pre-asignada tiene otro location_id, NO se guarda y redirect con error |
| T-Q1-05 | Tampering (XSS) | nombres de locations GHL en el buscador | mitigate | esc() en todo dato de GHL antes de innerHTML (patrón existente del archivo) |
| T-Q1-06 | Denial of Service | searchAgencyLocations sin tope | accept | Tope de 3 páginas (300 locations) + respuesta capada a 20; agencia de un solo super-admin, riesgo bajo |
| T-Q1-07 | Elevation of Privilege | fila pending tratada como conectada | mitigate | access_token null = NO conectada en getGhlCreds/listGhlUsers/importGhlUser; refreshGhlToken lanza si no hay refresh_token |
| T-Q1-SC | Tampering | npm/pip installs | accept | Cero dependencias npm en este cambio (server.js usa solo módulos nativos de Node) |
</threat_model>

<verification>
Verificación local del ejecutor (SIN SSH ni deploy):

1. `node --check api/server.js` — sin errores de sintaxis.
2. Arranque local con env dummy y SUPER_ADMIN_EMAILS vacío:
   `SUPABASE_URL=http://localhost:9 SERVICE_ROLE_KEY=x ANON_KEY=x PORT=3987 node api/server.js`
   - `GET /api/platform/settings` → 403 (fail-closed, sin llamada de red)
   - `GET /api/platform/locations?q=x` → 403
   - `POST /api/platform/settings` → 403
   - `GET /api/health` → 200
3. Greps de seguridad: ningún token/secreto nuevo hardcodeado; `agency_pit` nunca aparece en un `console.log`; la migración 007 no crea policies.
4. index.html: `data-view="platform"` presente y oculto por defecto; `orgsCard` ausente del cuerpo de renderTeam; `esc(` aplicado a los campos de locations en el buscador.

## Post-merge (orquestador — fuera del alcance del ejecutor)

1. Aplicar la migración `007_platform_settings.sql` en el Supabase self-hosted.
2. Deploy a pruebas/producción según el flujo del repo.
3. Seed del agency PIT real vía `POST /api/platform/settings` con la sesión de un super-admin (el valor está en el vault de Ale; el orquestador lo tiene — JAMÁS commitearlo).
4. QA e2e: login super-admin → ítem Plataforma visible → guardar token (hint correcto) → buscar subcuentas reales (100+, filtro q) → crear org pre-vinculada → login como esa org: card "Subcuenta asignada... falta autorizar" → OAuth con la subcuenta correcta (completa) y con otra (rechazo location_mismatch) → verificar que un admin normal NO ve Plataforma ni puede pegarle a /api/platform/* (403).
</verification>

<success_criteria>
- Migración 007 idempotente: st_platform_settings con RLS deny-all.
- 3 rutas nuevas guardadas por requireSuperAdmin; SUPER_ADMIN_EMAILS vacío → 403 en todas.
- El agency PIT: se guarda solo tras validación en vivo contra locations/search; solo sale como hint de 4 chars; se puede reemplazar y borrar.
- Buscador: pagina hasta 300 locations, filtra por name/email/id, capa a 20, anota linked_org.
- Alta de org con location_id: validaciones fail-fast (PIT, existencia, no-duplicado) + pre-vínculo sin tokens + warning no-fatal si el insert falla; alta sin location_id intacta.
- Estado pending visible para el admin del tenant; OAuth completa el pre-vínculo o rechaza mismatch.
- Organizaciones vive SOLO en Plataforma; Configuraciones ya no la renderiza.
- Cero secretos en código, logs o respuestas (repo público).
</success_criteria>

<output>
Crear `.planning/quick/260704-wmy-vista-plataforma-super-admin-api-de-agen/260704-wmy-SUMMARY.md` al terminar.
</output>
