---
phase: quick-260702-onz
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supabase/migrations/002_member_active.sql
  - api/server.js
  - api/Dockerfile
  - api/package.json
  - nginx.conf
  - docker-compose.yml
  - docker-compose.dev.yml
  - index.html
autonomous: true
requirements: [QUICK-260702-onz]
user_setup:
  - service: supabase-self-hosted
    why: "La mini-API necesita el service_role key para crear/banear auth users server-side"
    env_vars:
      - name: SUPABASE_URL
        source: "https://supabase.mazefunnels.io (URL base de Supabase self-hosted)"
      - name: SERVICE_ROLE_KEY
        source: "Supabase self-hosted — variable SERVICE_ROLE_KEY / JWT con role service_role"
      - name: ANON_KEY
        source: "Supabase self-hosted — anon key (la misma embebida en index.html)"
      - name: PORT
        source: "Opcional, default 3000"
    dashboard_config:
      - task: "Crear el .env untracked en el app_dir del VPS con las 4 vars (lo hace el orquestador, NO va al repo)"
        location: "VPS app_dir del proyecto"
      - task: "Aplicar la migración 002 vía docker exec psql (lo hace el orquestador)"
        location: "VPS contenedor de Postgres de Supabase"

must_haves:
  truths:
    - "El admin puede crear un miembro real con email+contraseña que puede loguearse"
    - "El admin puede dar de baja (soft) a un miembro: no aparece en el equipo y no puede entrar"
    - "Un caller no-admin recibe 403 al intentar crear o dar de baja miembros"
    - "Un miembro dado de baja (active=false) no aparece en la UI del equipo"
  artifacts:
    - path: "supabase/migrations/002_member_active.sql"
      provides: "Columna active en st_profiles (soft-delete)"
      contains: "add column if not exists active"
    - path: "api/server.js"
      provides: "Mini-API Node sin deps: POST/DELETE /api/members con auth admin"
      min_lines: 80
    - path: "api/Dockerfile"
      provides: "Imagen node:22-alpine que corre server.js"
      contains: "node:22-alpine"
    - path: "nginx.conf"
      provides: "Proxy /api/ hacia el servicio api"
      contains: "location /api/"
    - path: "docker-compose.yml"
      provides: "Servicio api en red default + nginx sumado a red default"
      contains: "build: ./api"
  key_links:
    - from: "index.html window.addMember"
      to: "/api/members"
      via: "fetch POST con Bearer access_token"
      pattern: "fetch\\('/api/members'"
    - from: "nginx.conf"
      to: "http://api:3000"
      via: "proxy_pass"
      pattern: "proxy_pass http://api:3000"
    - from: "api/server.js"
      to: "auth/v1/admin/users"
      via: "service_role fetch"
      pattern: "auth/v1/admin/users"
---

<objective>
Reemplazar el alta/baja de miembros solo-local por provisioning real server-side. Hoy `window.addMember` y `window.delMember` solo mutan el array en memoria: no crean auth users (imposible desde el browser, requiere service_role) y la "baja" no impide el login. Este plan agrega una mini-API Node (sin dependencias npm) que valida al admin y gestiona auth users + perfiles con la service key, más el soft-delete `active` y el cableado de nginx/compose y la UI.

Purpose: que el admin pueda dar de alta miembros que realmente pueden entrar, y dar de baja a alguien de forma que conserve sus datos históricos pero no pueda loguearse.
Output: migración 002, `api/` (server + Dockerfile), proxy nginx, servicio compose (dev+prod), y cambios de UI en index.html.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@supabase/migrations/001_sales_tracker.sql
@nginx.conf
@docker-compose.yml
@docker-compose.dev.yml

<interfaces>
<!-- Contratos que ya existen en el codebase; el executor los usa directo, sin explorar. -->

Cliente Supabase e identidad (index.html ~línea 342):
```
const SB_URL='https://supabase.mazefunnels.io';
const SB_ANON='<jwt anon embebido>';
const sb=window.supabase.createClient(SB_URL,SB_ANON,{...});
let ME=null, IS_ADMIN=false;   // ME = {id, org_id, role, name, ...}
```

Access token del usuario logueado (para el header Authorization):
```
const { data:{ session } } = await sb.auth.getSession();
const access_token = session.access_token;
```

st_profiles (migration 001): columns id (=auth.users.id), org_id, name,
role check in ('admin','setter','triage','closer'), commission, created_at.
RLS: solo el admin del mismo org puede insert/update/delete perfiles.

loadFromSupabase() (index.html ~línea 416) arma DB.members así:
```
members: profs.filter(p=>p.role!=='admin').sort(...).map(p=>({id,name,role,commission}))
```

addMember/delMember actuales (index.html ~línea 1019-1026):
```
window.addMember = () => { ... DB.members.push(m); save(); ... }   // solo local
window.delMember = (id) => { ... DB.members = DB.members.filter(...); ... }  // solo local
```

Form "Agregar miembro" actual (index.html ~línea 1004-1010): solo campos
#newName y #newRole. Botón onclick="addMember()".
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migración soft-delete + mini-API Node de provisioning</name>
  <files>supabase/migrations/002_member_active.sql, api/server.js, api/Dockerfile, api/package.json</files>
  <action>
Crear `supabase/migrations/002_member_active.sql` idempotente: `alter table public.st_profiles add column if not exists active boolean not null default true;` (una sola sentencia, con comentario de cabecera explicando que la baja es soft = active=false, nunca DELETE, porque st_entries.member_id tiene ON DELETE CASCADE y borrar el perfil perdería los datos históricos).

Crear la mini-API en `api/`:
- `api/Dockerfile`: base `node:22-alpine`, WORKDIR /app, COPY server.js (y package.json), EXPOSE 3000, CMD ["node","server.js"]. Sin `npm install` (no hay dependencias).
- `api/package.json`: mínimo, sin dependencias — `{ "name":"maze-sales-tracker-api", "version":"1.0.0", "private":true, "type":"module", "main":"server.js" }`.
- `api/server.js`: HTTP server con el módulo nativo `http` y `fetch` global (Node 22). Sin imports de terceros. Lee env vars `SUPABASE_URL`, `SERVICE_ROLE_KEY`, `ANON_KEY`, `PORT` (default 3000).

Middleware de auth aplicado a CADA request bajo /api/members:
1. Leer header `Authorization: Bearer <jwt>`. Si falta → 401 `{error:"Falta el token de sesión"}`.
2. Validar el JWT: `GET {SUPABASE_URL}/auth/v1/user` con headers `apikey: ANON_KEY` y el `Authorization` passthrough. Si no 200 → 401 `{error:"Sesión inválida"}`. Extraer `user.id` (uid).
3. Leer el perfil del caller con service key: `GET {SUPABASE_URL}/rest/v1/st_profiles?id=eq.{uid}&select=org_id,role` con headers `apikey: SERVICE_ROLE_KEY` y `Authorization: Bearer SERVICE_ROLE_KEY`. Exigir `role==='admin'`; si no → 403 `{error:"Solo el admin puede gestionar miembros"}`. Guardar `org_id` del admin.

Rutas:
- `POST /api/members` body `{name, role, email, password}`. Validar: name/email/password no vacíos, password length ≥ 8, role ∈ {setter,triage,closer}. Errores de validación → 400 con mensaje en español latino (tuteo). Flujo:
  a. Crear auth user: `POST {SUPABASE_URL}/auth/v1/admin/users` (service key) con `{email, password, email_confirm:true}`. Si el status indica email duplicado → 409 `{error:"Ya existe un usuario con ese email"}`.
  b. Insertar perfil: `POST {SUPABASE_URL}/rest/v1/st_profiles` (service key, header `Prefer: return=representation`) con `{id:<nuevo uid>, org_id:<del admin>, name, role, commission:0}`.
  c. Si el insert del perfil falla → ROLLBACK: `DELETE {SUPABASE_URL}/auth/v1/admin/users/{nuevo uid}` (service key) y devolver el error como 500 con mensaje claro. Si todo ok → 200 con el perfil creado.
- `DELETE /api/members/{id}`: extraer id de la URL. Verificar que el perfil target existe y pertenece al MISMO org que el admin (`GET st_profiles?id=eq.{id}&select=org_id`). Si no coincide / no existe → 404 `{error:"Ese miembro no pertenece a tu equipo"}`. Luego: `PATCH {SUPABASE_URL}/rest/v1/st_profiles?id=eq.{id}` con `{active:false}` (service key), y banear el auth user: `PUT {SUPABASE_URL}/auth/v1/admin/users/{id}` con `{ban_duration:"87600h"}`. Éxito → 200 `{ok:true}`.

Reglas transversales: todas las respuestas JSON con `Content-Type: application/json`; status HTTP correcto por caso; mensajes de error en español latino con tuteo (nunca voseo). Loguear a stdout cada operación (método, ruta, uid del admin, resultado) SIN incluir passwords. No configurar CORS (mismo origen vía nginx). Cualquier ruta no reconocida → 404 JSON. Parsear el body JSON con guardas (try/catch → 400 si es inválido).
  </action>
  <verify>
    <automated>cd /Users/alevogeler/maze-sales-tracker && node --check api/server.js && grep -q "add column if not exists active" supabase/migrations/002_member_active.sql && grep -q "node:22-alpine" api/Dockerfile && grep -q "auth/v1/admin/users" api/server.js && grep -q "ban_duration" api/server.js</automated>
  </verify>
  <done>server.js pasa node --check; migración tiene la columna active idempotente; Dockerfile usa node:22-alpine; server.js referencia el endpoint admin de auth y el ban_duration. Sin dependencias npm (package.json sin campo dependencies).</done>
</task>

<task type="auto">
  <name>Task 2: Cableado nginx + servicio api en docker-compose (dev y prod)</name>
  <files>nginx.conf, docker-compose.yml, docker-compose.dev.yml</files>
  <action>
En `nginx.conf`: mantener el `location /` existente tal cual y AGREGAR un bloque `location /api/ { proxy_pass http://api:3000; }` dentro del mismo `server {}`. Incluir headers de proxy razonables (`proxy_set_header Host $host;` y `proxy_set_header X-Forwarded-For $remote_addr;`). No cambiar nada más.

En `docker-compose.yml` (prod) y `docker-compose.dev.yml` (dev), agregar el servicio `api` y sumar la red `default` al servicio nginx existente:
- Servicio `api`: `build: ./api`, `restart: unless-stopped`, `env_file: .env`, y `networks: [default]`. NO ponerlo en `traefik-public` y NO agregarle labels de traefik (es interno, solo lo alcanza nginx por DNS).
- Al servicio nginx existente (`maze-sales-tracker` en prod, `maze-sales-tracker-dev` en dev): cambiar su `networks:` para que incluya AMBAS: `traefik-public` (la que ya tenía) y `default`. Sin esto, nginx no resuelve `api` por DNS y el proxy_pass falla.
- En la sección `networks:` de cada archivo, declarar la red `default` además de la `traefik-public: {external: true}` ya existente. `default` es la red interna del proyecto (no external); declararla explícitamente para que ambos servicios compartan la misma red interna.

Cada compose es un proyecto Compose distinto (dev vs prod), así que no hay colisión de nombres de servicio ni de red entre ambos. El `.env` es untracked y lo crea el orquestador en el VPS; no crearlo aquí.
  </action>
  <verify>
    <automated>cd /Users/alevogeler/maze-sales-tracker && grep -q "location /api/" nginx.conf && grep -q "proxy_pass http://api:3000" nginx.conf && python3 -c "import yaml; d1=yaml.safe_load(open('docker-compose.yml')); d2=yaml.safe_load(open('docker-compose.dev.yml')); assert 'api' in d1['services'] and 'api' in d2['services']; assert d1['services']['api']['build']=='./api'; assert 'default' in d1['services']['maze-sales-tracker']['networks'] and 'traefik-public' in d1['services']['maze-sales-tracker']['networks']; assert 'default' in d2['services']['maze-sales-tracker-dev']['networks']; print('ok')"</automated>
  </verify>
  <done>nginx.conf proxya /api/ a http://api:3000; ambos compose parsean como YAML válido, definen el servicio api con build ./api, y el servicio nginx correspondiente está en las redes traefik-public y default.</done>
</task>

<task type="auto">
  <name>Task 3: UI de alta/baja real en index.html contra /api/members</name>
  <files>index.html</files>
  <action>
Trabajar solo sobre index.html. No tocar textos existentes ni `pushToSupabase()`. Copy nuevo en español latino con tuteo (nunca voseo).

1. Form "Agregar miembro" (renderTeam, ~línea 1004-1010): además de Nombre (#newName) y Rol (#newRole), sumar dos campos: Email (`<input id="newEmail" type="email" placeholder="persona@email.com">`) y Contraseña temporal (`<input id="newPass" type="text" placeholder="mínimo 8 caracteres">`). Mantener el layout `grid2` y el botón `onclick="addMember()"`.

2. `window.addMember` (~línea 1019): convertir a async. Leer name, role, email, password de los inputs. Validaciones de cliente rápidas (name/email/password no vacíos, password ≥8) con toast si faltan. Obtener el token: `const { data:{ session } } = await sb.auth.getSession();` y usar `session.access_token`. Hacer `fetch('/api/members', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token}, body: JSON.stringify({name, role, email, password})})`. Parsear la respuesta JSON. Si `res.ok`: toast de éxito (ej: `name+' agregado al equipo'`), luego `await loadFromSupabase()` y `renderTeam()`. Si NO ok: toast con el mensaje del servidor (`data.error || 'No se pudo agregar'`) y NO mostrar toast falso de éxito ni mutar DB.members localmente.

3. `window.delMember` (~línea 1026): convertir a async. Mantener el `confirm()` pero con copy actualizado, ej: `'¿Dar de baja a esta persona? Sus datos históricos se conservan, pero ya no va a poder entrar a la app.'`. Si confirma: obtener el access_token igual que arriba y hacer `fetch('/api/members/'+id, {method:'DELETE', headers:{'Authorization':'Bearer '+session.access_token}})`. Si ok: toast de éxito, `await loadFromSupabase()` y `renderTeam()`. Si no ok: toast con `data.error`.

4. `loadFromSupabase()` (~línea 424): en el filtro de members, sumar la condición `active`. Cambiar `profs.filter(p=>p.role!=='admin')` por `profs.filter(p=>p.role!=='admin' && p.active!==false)` para excluir los miembros dados de baja. No cambiar nada más de esa función.
  </action>
  <verify>
    <automated>cd /Users/alevogeler/maze-sales-tracker && grep -q "id=\"newEmail\"" index.html && grep -q "id=\"newPass\"" index.html && grep -q "fetch('/api/members'" index.html && grep -q "fetch('/api/members/'+id" index.html && grep -q "p.active!==false" index.html && grep -q "getSession()" index.html</automated>
  </verify>
  <done>El form de agregar miembro tiene campos Email y Contraseña; addMember y delMember llaman a /api/members con Bearer token y actualizan la UI vía loadFromSupabase/renderTeam; loadFromSupabase excluye perfiles con active===false; sin toasts falsos de éxito en caso de error.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → mini-API (/api/) | Entrada no confiable: body JSON + Bearer JWT del usuario |
| mini-API → Supabase (GoTrue/PostgREST) | La API usa SERVICE_ROLE_KEY (bypassea RLS) — debe filtrar por org_id manualmente |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-onz-01 | Elevation of Privilege | POST/DELETE /api/members | mitigate | Validar JWT contra /auth/v1/user y exigir role='admin' del perfil real antes de cualquier operación |
| T-onz-02 | Information Disclosure | DELETE /api/members/{id} | mitigate | Verificar que el perfil target pertenece al mismo org_id del admin antes de patch/ban (evita baja cross-tenant) |
| T-onz-03 | Tampering | rollback de alta | mitigate | Si falla el insert del perfil, borrar el auth user creado para no dejar usuarios huérfanos que puedan loguearse sin perfil |
| T-onz-04 | Information Disclosure | logs stdout | mitigate | Loguear operaciones sin incluir passwords |
| T-onz-05 | Spoofing | Bearer token | mitigate | El token se valida server-side con la anon key contra GoTrue; no se confía en claims del cliente |
| T-onz-SC | Tampering | npm/pip/cargo installs | accept | La mini-API no instala paquetes (http nativo + fetch global, sin dependencias) — sin superficie de supply-chain |
</threat_model>

<verification>
- `node --check api/server.js` pasa.
- Ambos docker-compose parsean como YAML y declaran el servicio `api` + nginx en red `default`.
- nginx.conf proxya `/api/` a `http://api:3000`.
- index.html: form con Email/Contraseña, addMember/delMember contra /api/members con Bearer token, filtro `active!==false` en loadFromSupabase.
- (Manual del orquestador, fuera de este plan) aplicar migración 002 vía docker exec psql y crear el .env en el VPS.
</verification>

<success_criteria>
- El admin da de alta un miembro con email+contraseña que puede loguearse; el perfil aparece en el equipo.
- El admin da de baja a un miembro: active=false, baneado en auth, desaparece de la UI, sus datos históricos se conservan.
- Un caller no-admin recibe 403.
- No hay dependencias npm en la mini-API; nada se rompe en la app existente (pushToSupabase y textos previos intactos).
</success_criteria>

<output>
Create `.planning/quick/260702-onz-mini-api-de-provisioning-de-miembros-alt/260702-onz-SUMMARY.md` when done
</output>
