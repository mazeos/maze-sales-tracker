---
phase: quick-260704-uud
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [supabase/migrations/006_integration_calendar.sql, api/server.js, index.html]
autonomous: true
requirements: [QUICK-260704-UUD]
must_haves:
  truths:
    - "El admin, con GHL conectado, ve en la card 'Integración HighLevel' un bloque 'Calendario de llamadas' con un select que lista SOLO los calendarios GHL asignados a closers ya sincronizados (perfiles activos role=closer con ghl_user_id)"
    - "Cada opción del select muestra el nombre del calendario y los closers que lo atienden ({name} · {closers})"
    - "Al guardar, el calendario elegido persiste en st_integrations (calendar_id + calendar_name) y queda preseleccionado en visitas futuras"
    - "GET /api/ghl/leads usa el calendario elegido por la org; si la org no eligió, cae al env GHL_CALENDAR (modo PIT/instancia dedicada); si no hay ninguno → 501 con mensaje que dirige a Configuraciones"
    - "Un calendar_id que no está en la lista filtrada server-side se rechaza con 400 'Ese calendario no está disponible' (el POST re-valida, nunca confía en el body)"
    - "Org sin closers sincronizados → select vacío + hint 'Importá primero a tus closers desde Equipo desde HighLevel'"
    - "Guardar con calendar_id vacío desconfigura (calendar_id/calendar_name a null) y responde ok"
  artifacts:
    - path: "supabase/migrations/006_integration_calendar.sql"
      provides: "Columnas calendar_id y calendar_name en st_integrations, idempotente"
      contains: "add column if not exists calendar_id"
    - path: "api/server.js"
      provides: "Helper listOrgCalendars + GET /api/ghl/calendars + POST /api/integrations/ghl/calendar + resolución de calendario por org en ghlLeads"
      contains: "/api/ghl/calendars"
    - path: "index.html"
      provides: "Bloque 'Calendario de llamadas' en ghlCard (estado conectado, solo admin): select + Guardar + hint"
      contains: "Calendario de llamadas"
  key_links:
    - from: "api/server.js listOrgCalendars"
      to: "GHL GET /calendars/?locationId="
      via: "fetch con ghlHeaders(token, '2021-04-15') y filtro por teamMembers[].userId ∈ closers sincronizados"
      pattern: "calendars/\\?locationId="
    - from: "api/server.js ghlLeads"
      to: "st_integrations.calendar_id"
      via: "creds.integration devuelta por getGhlCreds (sin segunda llamada a getIntegration)"
      pattern: "integration\\.calendar_id"
    - from: "index.html ghlCard"
      to: "GET /api/ghl/calendars"
      via: "fetch lazy al renderizar el estado conectado (patrón loadGhlStatus)"
      pattern: "api/ghl/calendars"
    - from: "index.html saveGhlCalendar"
      to: "POST /api/integrations/ghl/calendar"
      via: "fetch con Bearer + body {calendar_id}"
      pattern: "integrations/ghl/calendar"
---

<objective>
Fase 2.3 de la carcasa GHL del Maze Sales Tracker: el calendario de llamadas deja de ser un env global (`GHL_CALENDAR`) y pasa a ser configurable por org desde la UI de Configuraciones. El admin elige el calendario en un select que muestra SOLO los calendarios de la subcuenta GHL asignados a closers ya sincronizados en el tracker (decisión de Alejandro: no listar todos los calendarios de la location, solo los relevantes al equipo de cierre). `ghlLeads` resuelve el calendario por org, con el env como fallback para instancias dedicadas (modo PIT, ej. Clara).

Purpose: multi-tenancy real del módulo Ventas-GHL — cada org configura su propio calendario sin tocar envs ni redeployar.
Output: migración 006 (calendar_id/calendar_name en st_integrations) + dos endpoints nuevos en `api/server.js` + bloque "Calendario de llamadas" en la card de integración de `index.html`.
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

Rama de trabajo: `develop` (Fases GHL 1/2/2.1/2.2 + porteo de Clara ya mergeados). Repo PÚBLICO: cero secretos ni IDs de tenants en el código, comentarios o plan.

Arquitectura relevante (verificada en el código actual):
- `st_integrations` (migración 003): una fila por org (UNIQUE org_id), deny-all vía RLS sin policies; solo la service key la toca. Los tokens JAMÁS llegan al browser.
- Modo dual de credenciales GHL: (1) OAuth por org en `st_integrations`, (2) fallback env `GHL_PIT` + `GHL_LOCATION` (instancia dedicada). `GHL_CALENDAR` (línea 54) es hoy el ÚNICO origen del calendario y es global — eso es lo que esta fase arregla.
- Los closers sincronizados viven en `st_profiles` con `role='closer'`, `ghl_user_id` no nulo y `active !== false` (los perfiles viejos pueden tener active null = activo; el código existente siempre chequea `p.active === false`, seguir ese patrón).
- La API GHL de calendarios: `GET https://services.leadconnectorhq.com/calendars/?locationId={locationId}` con `Version: 2021-04-15` (misma versión que ya usa `ghlLeads` para events). Respuesta: `{calendars:[{id, name, teamMembers:[{userId,...}], ...}]}`.
</context>

<interfaces>
<!-- Contratos existentes en api/server.js que el ejecutor reutiliza tal cual -->

`sendJSON(res, status, obj)` / `readJSONBody(req)` → helpers de respuesta y body (líneas 88-114).

`svcHeaders(extra = {})` → headers service-role para PostgREST (bypassea RLS).

`ghlHeaders(token, version = '2021-07-28')` (línea 81) → headers para la API GHL; para calendars pasar `'2021-04-15'`.

`requireAdmin(req)` → `{ok, uid, org_id}` o `{ok:false, status, error}`. `requireMember(req)` → idem + role/name.

`getIntegration(orgId)` (línea 253) → fila completa de st_integrations o null (también null en error de red).

`refreshGhlToken(integration)` (línea 269) → access_token vigente; lanza Error si el refresh falla.

`getGhlCreds(orgId)` (líneas 318-327) — LA FUNCIÓN A EXTENDER:
```js
async function getGhlCreds(orgId) {
  const integration = await getIntegration(orgId);
  if (integration) {
    return { token: await refreshGhlToken(integration), locationId: integration.location_id };
  }
  if (GHL_PIT && GHL_LOCATION) {
    return { token: GHL_PIT, locationId: GHL_LOCATION };
  }
  return null;
}
```

`ghlLeads(req, res, member)` (líneas 334-389) — hoy: 501 si `!GHL_CALENDAR` (línea 342) y usa `GHL_CALENDAR` en la URL de events (línea 354). Cache `leadsCache` (Map orgId → {at, data}, 60s).

Router (líneas ~1277-1315): if-chain por método+path; las rutas admin llaman `await requireAdmin(req)` y devuelven `sendJSON(res, admin.status, {error})` si `!admin.ok`.

En index.html:
- `ghlCard()` (líneas 1035-1052): card "Integración HighLevel"; la rama `GHL_STATUS.connected` (líneas 1043-1046) renderiza "✅ Conectado a …" + botón Desconectar. Se renderiza dentro de `renderTeam()` (vista Configuraciones/Equipo).
- Patrón de carga lazy: `loadGhlStatus()` (líneas 1023-1034) — flag LOADING, fetch con `session.access_token`, y en `finally` re-llama `renderTeam()` si `state.view==='team'`. Replicar este patrón para los calendarios.
- `disconnectGhl` (líneas 1059-1071): en la rama ok resetea los estados GHL_* y re-renderiza.
- Helpers UI: `esc()` para escapar, `toast(msg)`, tokens CSS `var(--muted)`, `var(--surface)`, `var(--line)`, clases `.btn`, `.btn sm`, `.chip` (los select existentes usan `class="chip"`, línea 964).
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Migración 006 + endpoints de calendario + resolución por org en ghlLeads</name>
  <files>supabase/migrations/006_integration_calendar.sql, api/server.js</files>
  <action>
**1. Migración `supabase/migrations/006_integration_calendar.sql`** (archivo nuevo, seguir el estilo comentado de 003): dos `alter table public.st_integrations add column if not exists` — `calendar_id text` y `calendar_name text`. Comentario de cabecera: calendario de llamadas elegido por la org desde Configuraciones (Fase 2.3); nullable = sin configurar → fallback al env GHL_CALENDAR. Idempotente: correr dos veces no falla. NO tocar RLS ni permisos (la tabla sigue deny-all).

**2. `api/server.js` — extender `getGhlCreds`** para devolver también la integración y evitar la doble llamada a `getIntegration` que pide la spec: en la rama OAuth retornar `{ token, locationId: integration.location_id, integration }`; en la rama PIT retornar `{ token: GHL_PIT, locationId: GHL_LOCATION, integration: null }`. Actualizar el comentario de la función. Los callers existentes (`ghlLeads`, `salesGhl`) no se rompen (campo extra).

**3. Helper nuevo `listOrgCalendars(creds, orgId)`** (ubicarlo junto a ghlLeads, antes de los endpoints nuevos). Recibe las creds ya resueltas (con token vigente) y el org_id:
   a. Closers sincronizados: `GET SUPABASE_URL + '/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(orgId) + '&role=eq.closer&select=name,active,ghl_user_id'` con `svcHeaders()`. Status ≠ 200 o body no-array → lanzar Error (el caller responde 502/500 genérico). Filtrar en JS: `p.active !== false && p.ghl_user_id` (patrón existente: active null cuenta como activo). Construir Map `ghl_user_id → name`.
   b. Si el Map queda vacío → return `{ calendars: [], sinClosers: true }` SIN llamar a GHL (no gastar rate limit).
   c. Calendarios GHL: `GET GHL_BASE + '/calendars/?locationId=' + encodeURIComponent(creds.locationId)` con `ghlHeaders(creds.token, '2021-04-15')`. Status ≠ 2xx → lanzar Error. Body: `{calendars:[...]}` (si no es array, tratar como vacío).
   d. Filtrar: SOLO calendarios `c` con `c.id` donde `Array.isArray(c.teamMembers)` y algún `tm.userId` esté en el Map de closers. Mapear a `{ id: c.id, name: c.name || 'Sin nombre', closers: [nombres únicos de los closers matcheados, en el orden del teamMembers] }`.
   e. Return `{ calendars, sinClosers: false }`.

**4. `GET /api/ghl/calendars`** — handler `async function listGhlCalendars(req, res, admin)`:
   - `creds = await getGhlCreds(admin.org_id)` en try/catch → catch (refresh falló) responde 502 'No se pudo refrescar el acceso a GHL. Probá de nuevo.' (mismo copy que ghlLeads).
   - `!creds` → 409 `{ error: 'Conectá tu cuenta de HighLevel primero' }` (mismo copy que listGhlUsers).
   - `listOrgCalendars(creds, admin.org_id)` en try/catch → catch responde 502 'No se pudo hablar con HighLevel. Probá de nuevo.'.
   - Respuesta 200: `{ calendars, selected: (creds.integration && creds.integration.calendar_id) || null, selected_name: (creds.integration && creds.integration.calendar_name) || null }`; si `sinClosers`, agregar `hint: 'Importá primero a tus closers desde Equipo desde HighLevel'`.
   - Log estilo existente: `[api] GET /api/ghl/calendars admin=${admin.uid} org=${admin.org_id} n=${calendars.length} -> 200`. Cero tokens/secretos en logs ni en la respuesta.

**5. `POST /api/integrations/ghl/calendar`** — handler `async function setGhlCalendar(req, res, admin)`:
   - `readJSONBody` → `!parsed.ok` → 400 'JSON inválido'. `calendar_id` = string trimmeado del body (vacío/null/no-string → '').
   - **Desconfigurar** (`calendar_id === ''`): PATCH `st_integrations?org_id=eq.{org}` con `{ calendar_id: null, calendar_name: null, updated_at }` y `Prefer: return=minimal`; status ≠ 2xx → 500 'No se pudo guardar el calendario'. OK (aunque no hubiera fila, idempotente) → `leadsCache.delete(admin.org_id)` y `{ ok: true }`.
   - **Configurar**: `creds = await getGhlCreds(admin.org_id)` (mismos try/catch y 409/502 que el GET). Si `!creds.integration` → 409 'Conectá tu cuenta de HighLevel primero' (modo PIT no tiene fila donde persistir; el calendario de una instancia dedicada se maneja por env). Re-obtener la lista con `listOrgCalendars` (NUNCA confiar en el body: el filtro server-side es la validación). Buscar `cal` con `cal.id === calendar_id`; si no está → 400 `{ error: 'Ese calendario no está disponible' }`. PATCH `st_integrations?org_id=eq.{org}` con `{ calendar_id: cal.id, calendar_name: cal.name, updated_at }`; falla → 500 'No se pudo guardar el calendario'. OK → `leadsCache.delete(admin.org_id)` (los leads cacheados son del calendario anterior) + log + `{ ok: true, calendar_name: cal.name }`.

**6. `ghlLeads` — resolución del calendario por org** (reemplaza la línea 342 y el uso de GHL_CALENDAR en la línea 354): `const calendarId = (creds.integration && creds.integration.calendar_id) || GHL_CALENDAR;` — orden: calendario elegido por la org → env (fallback PIT/instancia dedicada). Si `!calendarId` → 501 `{ error: 'Elegí el calendario de llamadas en Configuraciones → Integración HighLevel' }`. Usar `calendarId` en la URL de events. Actualizar el comentario de cabecera de ghlLeads. Gracias al punto 2 NO se agrega ninguna llamada extra a getIntegration.

**7. Router**: registrar ambas rutas en el bloque de rutas GHL admin (después de `/api/ghl/users/import`), con el patrón exacto existente: `if (req.method === 'GET' && path === '/api/ghl/calendars')` → requireAdmin → listGhlCalendars; `if (req.method === 'POST' && path === '/api/integrations/ghl/calendar')` → requireAdmin → setGhlCalendar.

Cero secretos, cero IDs de tenants, comentarios en español rioplatense como el resto del archivo.
  </action>
  <verify>
    <automated>node --check /Users/alevogeler/maze-sales-tracker/api/server.js && cd /Users/alevogeler/maze-sales-tracker && (SUPABASE_URL=http://localhost:9999 SERVICE_ROLE_KEY=test ANON_KEY=test PORT=3999 node api/server.js &) && sleep 1 && curl -s http://localhost:3999/api/health | grep -q '"ok":true' && curl -s -o /dev/null -w '%{http_code}' http://localhost:3999/api/ghl/calendars | grep -q 401 && curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3999/api/integrations/ghl/calendar | grep -q 401 && kill %1 2>/dev/null; echo OK</automated>
  </verify>
  <done>`node --check` pasa; la API arranca con env dummy y sin env GHL; `/api/ghl/calendars` y `POST /api/integrations/ghl/calendar` existen y responden 401 sin sesión; la migración 006 agrega calendar_id/calendar_name idempotentes; `getGhlCreds` devuelve la integración junto con las creds; `ghlLeads` resuelve org → env → 501 con el mensaje nuevo; el POST re-valida el calendar_id contra la lista filtrada server-side y limpia leadsCache al guardar.</done>
</task>

<task type="auto">
  <name>Task 2: index.html — bloque "Calendario de llamadas" en la card de integración</name>
  <files>index.html</files>
  <action>
Dentro de la sección "Integración HighLevel" de `index.html`, agregar la configuración del calendario. Solo admin (ghlCard ya retorna '' si `!IS_ADMIN`) y SOLO en la rama `GHL_STATUS.connected`:

1. **Estado nuevo** junto a `GHL_STATUS` (línea ~1022): `let GHL_CALS=null, GHL_CALS_LOADING=false;` (null = todavía no consultado; objeto = respuesta del GET `{calendars, selected, selected_name, hint?}` o `{error:true}` si falló).

2. **`loadGhlCalendars()`** — replicar el patrón exacto de `loadGhlStatus()`: guard `if(!IS_ADMIN || GHL_CALS_LOADING) return;`, flag LOADING, `sb.auth.getSession()`, fetch `GET /api/ghl/calendars` con `Authorization: Bearer`, `GHL_CALS = (res.ok && data) ? data : {error:true, msg:(data&&data.error)||''}`, y en `finally` re-llamar `renderTeam()` si `state.view==='team'`.

3. **Render en la rama connected de `ghlCard()`** (después del párrafo "✅ Conectado…" y ANTES del botón Desconectar), un sub-bloque "Calendario de llamadas":
   - `GHL_CALS===null` → disparar `loadGhlCalendars()` y mostrar `<p style="color:var(--muted);font-size:13px">Cargando calendarios…</p>`.
   - `GHL_CALS.error` → texto muted "No se pudieron cargar los calendarios. Recargá la página para reintentar." (si `GHL_CALS.msg` existe, mostrarlo en su lugar — ej. el 409 de conexión).
   - `GHL_CALS.calendars` vacío → mostrar el hint en texto muted: `esc(GHL_CALS.hint || 'Importá primero a tus closers desde Equipo desde HighLevel')`.
   - Con calendarios: título/label del bloque ("Calendario de llamadas", estilo eyebrow chico o `<b>` con font-size 13px — coherente con la card), explicación muted corta ("De acá salen los leads con cita para asociar ventas."), y una fila flex con: `<select id="ghl-cal-select" class="chip">` con primera opción `value=""` → `— Sin configurar —` y una opción por calendario con `value="${esc(c.id)}"` y texto `${esc(c.name)}${c.closers.length ? ' · ' + esc(c.closers.join(', ')) : ''}`, marcando `selected` la que coincida con `GHL_CALS.selected` (o la vacía si es null); al lado un `<button class="btn sm" onclick="saveGhlCalendar()">Guardar</button>`. Usar solo tokens existentes (var(--surface), var(--line), var(--muted), .chip, .btn) — nada de colores hardcodeados, contraste correcto en ambos temas. Español tuteo como el resto de la UI.

4. **`window.saveGhlCalendar`**: leer `document.getElementById('ghl-cal-select').value`, sesión (`toast('Tu sesión venció, vuelve a entrar')` si no hay), `POST /api/integrations/ghl/calendar` con headers Bearer + `Content-Type: application/json` y body `JSON.stringify({calendar_id: valor || null})`. `res.ok` → actualizar `GHL_CALS.selected = valor || null` y `GHL_CALS.selected_name = data.calendar_name || null`, `toast(valor ? 'Calendario guardado' : 'Calendario sin configurar')`, `renderTeam()`. Error → `toast(data.error || 'No se pudo guardar el calendario')`. Envolver el fetch en try/catch → `toast('No se pudo conectar con el servidor')`.

5. **Reset al desconectar**: en la rama ok de `disconnectGhl` (línea ~1069), agregar `GHL_CALS=null;` junto a los otros resets (GHL_USERS, etc.). Conectar pasa por redirect OAuth con reload completo — no hace falta nada más.

NO tocar: `ghlTeamCard()`, `loadGhlStatus()`, el flujo de conectar/desconectar más allá del reset, ni el modal de venta (el consumo de `/api/ghl/leads` no cambia de contrato).
  </action>
  <verify>
    <automated>grep -q "Calendario de llamadas" /Users/alevogeler/maze-sales-tracker/index.html && grep -q "api/ghl/calendars" /Users/alevogeler/maze-sales-tracker/index.html && grep -q "integrations/ghl/calendar" /Users/alevogeler/maze-sales-tracker/index.html && grep -q "Sin configurar" /Users/alevogeler/maze-sales-tracker/index.html && echo OK</automated>
  </verify>
  <done>Con GHL conectado y siendo admin, la card muestra el bloque "Calendario de llamadas" con select poblado desde GET /api/ghl/calendars (formato `{name} · {closers}`), preselección de `selected`, opción "— Sin configurar —", botón Guardar que postea y toastea "Calendario guardado", hint muted cuando no hay calendarios, y `GHL_CALS` se resetea al desconectar. Sin conexión o sin admin, la card queda idéntica a la actual.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → mini-API | JWT del cliente; ambos endpoints nuevos exigen requireAdmin (rol validado server-side contra st_profiles, nunca claims del cliente) |
| mini-API → GHL | Bearer token OAuth/PIT; los tokens JAMÁS llegan al browser ni a los logs |
| mini-API → PostgREST | SERVICE_ROLE_KEY bypassea RLS; st_integrations sigue deny-all para authenticated/anon |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-uud-01 | Tampering | POST /api/integrations/ghl/calendar | mitigate | El calendar_id del body NUNCA se persiste directo: se re-obtiene la lista filtrada server-side (closers de la org) y se valida pertenencia; fuera de lista → 400. calendar_name sale de la respuesta de GHL, no del body |
| T-uud-02 | Information Disclosure | GET /api/ghl/calendars | mitigate | Respuesta solo con id/name/closers del calendario + selected; sin tokens, sin teamMembers crudos, sin datos de otras orgs (closers filtrados por org_id del JWT validado) |
| T-uud-03 | Elevation of Privilege | endpoints nuevos | mitigate | requireAdmin en ambos; org_id sale del perfil real del caller (service key), jamás del body/query |
| T-uud-04 | Denial of Service | listOrgCalendars → GHL | mitigate | Sin closers sincronizados se corta ANTES de llamar a GHL (no gasta rate limit); el POST reutiliza el mismo helper (1 llamada extra a GHL por guardado, aceptable) |
| T-uud-05 | Information Disclosure | index.html render de nombres | mitigate | Nombres de calendarios/closers (origen GHL) siempre pasados por esc() antes de inyectar en el template |
| T-uud-SC | Tampering | npm installs | accept | Sin dependencias nuevas: server.js sigue siendo Node nativo sin npm, index.html vanilla |
</threat_model>

<verification>
- `node --check api/server.js` sin errores; la API arranca con env dummy y SIN env GHL ("modo manual").
- `curl` sin Authorization: `GET /api/ghl/calendars` → 401, `POST /api/integrations/ghl/calendar` → 401, `/api/health` → ok (rutas registradas, auth primero).
- `grep -n "add column if not exists" supabase/migrations/006_integration_calendar.sql` → calendar_id y calendar_name presentes; el archivo no toca RLS.
- `grep -n "GHL_CALENDAR" api/server.js` → el env sigue existiendo SOLO como fallback dentro de ghlLeads (ya no es condición 501 directa).
- `grep -n "Ese calendario no está disponible" api/server.js` → validación server-side presente.
- `grep -n "leadsCache.delete" api/server.js` → el guardado invalida la cache de leads de la org.
- Cero secretos/IDs de tenants nuevos en el diff (repo público).
</verification>

<success_criteria>
- Migración 006 idempotente con calendar_id/calendar_name en st_integrations.
- GET /api/ghl/calendars devuelve solo calendarios con algún closer sincronizado de la org en teamMembers, con `closers` por nombre, más selected/selected_name; org sin closers → lista vacía + hint.
- POST /api/integrations/ghl/calendar valida contra la lista filtrada (400 si no está), persiste id+name, desconfigura con body vacío, e invalida leadsCache.
- ghlLeads: calendario de la org → env GHL_CALENDAR → 501 "Elegí el calendario de llamadas en Configuraciones → Integración HighLevel". Sin llamadas duplicadas a getIntegration.
- UI: bloque "Calendario de llamadas" en la card conectada (solo admin), select con "— Sin configurar —" + `{name} · {closers}`, preselección, Guardar con toast, hint cuando no hay calendarios, reset al desconectar.
</success_criteria>

<output>
Create `.planning/quick/260704-uud-fase-2-3-carcasa-ghl-calendario-de-llama/260704-uud-SUMMARY.md` when done.

## Post-merge (orquestador — el ejecutor NO hace SSH ni deploy)

1. Correr la migración `006_integration_calendar.sql` en el Supabase self-hosted.
2. Deploy a `sales-tracker-test`.
3. QA e2e:
   - Admin con GHL conectado → la card muestra "Calendario de llamadas"; el select lista SOLO calendarios con closers sincronizados (formato `{name} · {closers}`).
   - Elegir un calendario y Guardar → toast "Calendario guardado"; recargar → sigue preseleccionado.
   - Abrir el modal de venta → `/api/ghl/leads` trae citas del calendario elegido (no del env).
   - Org sin closers importados → hint "Importá primero a tus closers desde Equipo desde HighLevel".
   - Guardar "— Sin configurar —" → vuelve al fallback env (o 501 con el mensaje nuevo si no hay env).
   - Instancia PIT (Clara): `/api/ghl/leads` sigue funcionando por env `GHL_CALENDAR` sin tocar nada.
</output>
