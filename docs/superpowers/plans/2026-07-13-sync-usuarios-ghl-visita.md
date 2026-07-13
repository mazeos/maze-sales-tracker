# Sincronizar usuarios de HighLevel estando de visita — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Un super-admin en modo visita puede abrir "Equipo desde HighLevel" en la org que está visitando, ver los usuarios de la subcuenta GHL de ese cliente e importarlos como miembros de esa org.

**Architecture:** Los dos endpoints de equipo GHL (`GET /api/ghl/users`, `POST /api/ghl/users/import`) pasan a resolver la org con `effectiveOrg(auth, requested)` — la helper que ya existe en `api/server.js:286` y que solo respeta el override si `auth.is_super === true`. El frontend deja de ocultar `ghlTeamCard()` en modo visita y manda la org visitada con los helpers `superOrgQS()` / `superOrgBody()` que ya existen en `index.html`.

**Tech Stack:** Node sin deps (`api/server.js`), `index.html` vanilla JS. No hay suite de tests automatizados en el repo: la verificación es por `curl` con JWT reales (backend), chequeo de sintaxis del `<script>` (frontend) y click-through de Ale (e2e).

**Spec:** `docs/superpowers/specs/2026-07-13-sync-usuarios-ghl-en-visita-design.md`

## Global Constraints

- **Seguridad (bloqueante):** el override SOLO surte efecto si `auth.is_super === true`. Un no-super que mande `org_id` de otra org lo ve **IGNORADO** (opera sobre su propia org). Si en la verificación un no-super lee datos ajenos, **detener el trabajo**.
- **`is_super` es el gate, no el `org_id`:** el `org_id` solo selecciona sobre qué org (existente) operar; nunca autoriza por sí mismo.
- **Base Supabase compartida** por todos los tenants (Clara corre en prod). Deploy SOLO a `sales-tracker-test.mazefunnels.io` (`/docker/maze-sales-tracker-dev`). **NO promover a main/prod.**
- **Sigue oculto en modo visita** (no re-habilitar): `ghlCard()` (conectar/desconectar OAuth), alta manual de miembro y botón "Quitar". Solo se re-habilita `ghlTeamCard()`.
- Idioma de la UI: castellano rioplatense.
- Sin dependencias nuevas.

**Datos reales para verificar (prod, base compartida):**

| Org | `org_id` | `location_id` GHL |
|---|---|---|
| Maze — Pruebas (org madre del super) | `ec8d930b-1f49-4aa4-98cc-4d14afc653b7` | `siM5ZYQ90OgKoshnqLeC` |
| Camino Digital (Clara) | `7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7` | `EwHiiqjOSOdzpl909IDY` |

---

### Task 1: Backend — override de org en `GET /api/ghl/users`

**Files:**
- Modify: `api/server.js` (`listGhlUsers`, ~1528–1685; routing, ~2966–2970)

**Interfaces:**
- Consumes: `effectiveOrg(auth, requestedOrgId)` (ya existe, línea 286); `requireAdmin(req)` → `{ok, uid, auth_uid, org_id, is_super}` (`is_super` ya lo expone `checkAdminToken`).
- Produces: `listGhlUsers(req, res, admin, url)` — **cambia la firma**: ahora recibe `url`. Task 3 depende de que el endpoint acepte `?org_id=`.

- [ ] **Step 1: Cambiar la firma de `listGhlUsers` y computar la org efectiva**

En `api/server.js`, línea ~1528. Hoy:
```js
async function listGhlUsers(req, res, admin) {
  const integration = await getIntegration(admin.org_id);
```
Cambiar a:
```js
async function listGhlUsers(req, res, admin, url) {
  const orgId = effectiveOrg(admin, url.searchParams.get('org_id'));
  const integration = await getIntegration(orgId);
```

- [ ] **Step 2: Reemplazar TODOS los `admin.org_id` restantes del handler por `orgId`**

Dentro de `listGhlUsers` quedan estos usos (líneas aproximadas — buscar `admin.org_id` en el cuerpo de la función y reemplazar **todos**):

- ~1544: el select de perfiles —
  `'/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(admin.org_id)` → `encodeURIComponent(orgId)`
- ~1585, ~1589, ~1596: logs de auto-link (`org=${admin.org_id}` → `org=${orgId}`)
- ~1634, ~1638, ~1649: logs de baja de huérfanos manuales
- ~1663, ~1667, ~1677: logs de baja de desvinculados

Los logs importan: si quedan con `admin.org_id`, la traza dice la org madre del super mientras la escritura ocurre en la org visitada — y esa traza es lo que se usa para auditar bajas.

Verificación mecánica de que no quedó ninguno (el rango es el cuerpo del handler):
```bash
cd /Users/alevogeler/maze-sales-tracker && sed -n '1528,1685p' api/server.js | grep -c "admin.org_id"
```
Expected: `0`.

- [ ] **Step 3: Pasarle `url` al handler desde el routing**

En el bloque de routing, línea ~2966 (`url` ya está parseada en ese scope, igual que en `captureGhl`):
```js
    if (req.method === 'GET' && path === '/api/ghl/users') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return listGhlUsers(req, res, admin, url);
    }
```

- [ ] **Step 4: Chequeo de sintaxis**

```bash
cd /Users/alevogeler/maze-sales-tracker && node --check api/server.js && echo "server.js: OK"
```
Expected: `server.js: OK`.

- [ ] **Step 5: Commit**

```bash
cd /Users/alevogeler/maze-sales-tracker && git add api/server.js && git commit -m "feat(api): org override en GET /api/ghl/users

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend — override de org en `POST /api/ghl/users/import`

**Files:**
- Modify: `api/server.js` (`importGhlUser`, ~1692–1934)

**Interfaces:**
- Consumes: `effectiveOrg(auth, requestedOrgId)`; el body ya parseado (`body.ghl_user_id`, `body.role`).
- Produces: `importGhlUser` acepta `body.org_id`. La firma NO cambia (el body ya se lee dentro del handler).

**Por qué es la tarea delicada:** este handler escribe el `org_id` del perfil nuevo. Si se escapa un solo `admin.org_id`, el usuario de Clara termina como miembro de la org madre del super — silenciosamente, sin error.

- [ ] **Step 1: Computar la org efectiva desde el body**

En `api/server.js`, línea ~1696. Hoy:
```js
  const body = parsed.data || {};
  const ghlUserId = typeof body.ghl_user_id === 'string' ? body.ghl_user_id.trim() : '';
  const role = typeof body.role === 'string' ? body.role.trim() : '';
```
Agregar la org efectiva junto con los otros campos del body:
```js
  const body = parsed.data || {};
  const orgId = effectiveOrg(admin, body.org_id);
  const ghlUserId = typeof body.ghl_user_id === 'string' ? body.ghl_user_id.trim() : '';
  const role = typeof body.role === 'string' ? body.role.trim() : '';
```

- [ ] **Step 2: Reemplazar los 6 usos de `admin.org_id` por `orgId`**

Todos dentro de `importGhlUser`. Los seis, con su línea aproximada y su rol:

| Línea | Uso | Qué rompe si se olvida |
|---|---|---|
| ~1702 | `getIntegration(admin.org_id)` | Lista los usuarios de la subcuenta GHL equivocada |
| ~1723 | select de perfiles `?org_id=eq.` | Decide reactivar/vincular/crear contra el equipo equivocado |
| ~1818 | filtro multi-cuenta `&org_id=eq.` | Busca el perfil del login en la org equivocada |
| ~1835 | INSERT de membresía nueva: `org_id: admin.org_id` | **Crea el miembro en la org equivocada** |
| ~1885 | INSERT de adopción: `org_id: admin.org_id` | **Crea el miembro en la org equivocada** |
| ~1898 | fallback de la respuesta: `org_id: admin.org_id` | La UI muestra la org equivocada |

Los `console.log` de este handler usan `admin.uid` (no `admin.org_id`), así que quedan como están.

Verificación mecánica (rango = cuerpo del handler):
```bash
cd /Users/alevogeler/maze-sales-tracker && sed -n '1692,1934p' api/server.js | grep -c "admin.org_id"
```
Expected: `0`.

- [ ] **Step 3: Chequeo de sintaxis**

```bash
cd /Users/alevogeler/maze-sales-tracker && node --check api/server.js && echo "server.js: OK"
```
Expected: `server.js: OK`.

- [ ] **Step 4: Commit**

```bash
cd /Users/alevogeler/maze-sales-tracker && git add api/server.js && git commit -m "feat(api): org override en POST /api/ghl/users/import

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Backend — deploy a dev y verificación de seguridad

**Files:** (ninguno)

**Interfaces:**
- Consumes: los endpoints con override de Task 1 y Task 2.

Esta tarea es el gate de seguridad. **No se avanza al frontend si falla.**

- [ ] **Step 1: Push y deploy del backend a dev**

`api` se **buildea** (no es bind-mount), hay que recrear el contenedor:
```bash
cd /Users/alevogeler/maze-sales-tracker && git push -u origin feature/sync-usuarios-ghl-visita
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'cd /docker/maze-sales-tracker-dev && git fetch origin && git checkout feature/sync-usuarios-ghl-visita && git pull origin feature/sync-usuarios-ghl-visita --quiet && docker compose -f docker-compose.dev.yml up -d --build --force-recreate api 2>&1 | tail -4'
```

- [ ] **Step 2: Obtener un JWT de super-admin**

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'ANON=$(grep -E "^ANON_KEY=" /root/supabase/docker/.env|cut -d= -f2); curl -s -X POST "https://supabase.mazefunnels.io/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" -d "{\"email\":\"alejandro@mazefunnels.com\",\"password\":\"Maze-CallIQ-2026!\"}"' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])"
```
Guardar la salida como `TOKEN_SUPER`.

- [ ] **Step 3: Verificar el override para el SUPER (lee la org ajena)**

```bash
# CON override → subcuenta de Clara (EwHiiqjOSOdzpl909IDY)
curl -s "https://sales-tracker-test.mazefunnels.io/api/ghl/users?org_id=7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7" -H "Authorization: Bearer $TOKEN_SUPER" | python3 -c "import sys,json; d=json.load(sys.stdin); print('access_code:', d.get('access_code')); print('users:', [u['name'] for u in d.get('users',[])])"

# SIN override → subcuenta de la org madre (siM5ZYQ90OgKoshnqLeC)
curl -s "https://sales-tracker-test.mazefunnels.io/api/ghl/users" -H "Authorization: Bearer $TOKEN_SUPER" | python3 -c "import sys,json; d=json.load(sys.stdin); print('access_code:', d.get('access_code')); print('users:', [u['name'] for u in d.get('users',[])])"
```
Expected: el primero devuelve `access_code: EwHiiqjOSOdzpl909IDY` y el equipo de Clara (Maria Clara Perez, Valeria Damico, etc.). El segundo devuelve `access_code: siM5ZYQ90OgKoshnqLeC` y el equipo de Maze. **Distintos → el override funciona.**

- [ ] **Step 4: Verificar la NO-REGRESIÓN (un no-super ignora el override) — GATE BLOQUEANTE**

Hace falta un JWT de un miembro **no-super** que además sea admin de su org (el endpoint exige `requireAdmin`). No hay ninguno hoy en la base, así que se crea uno temporal y se borra al terminar.

Crear el auth user + su perfil admin en la org madre (`ec8d930b-...`), con service key:
```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'SVC=$(grep -E "^SERVICE_ROLE_KEY=" /root/supabase/docker/.env|cut -d= -f2); ANON=$(grep -E "^ANON_KEY=" /root/supabase/docker/.env|cut -d= -f2);
UID=$(curl -s -X POST "https://supabase.mazefunnels.io/auth/v1/admin/users" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json" -d "{\"email\":\"qa-nosuper@mazefunnels.io\",\"password\":\"QaNoSuper-2026!\",\"email_confirm\":true}" | python3 -c "import sys,json; print(json.load(sys.stdin)[\"id\"])");
echo "uid=$UID";
curl -s -X POST "https://supabase.mazefunnels.io/rest/v1/st_profiles" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "{\"id\":\"$UID\",\"user_id\":\"$UID\",\"org_id\":\"ec8d930b-1f49-4aa4-98cc-4d14afc653b7\",\"name\":\"QA No Super\",\"role\":\"admin\",\"commission\":0}";
curl -s -X POST "https://supabase.mazefunnels.io/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" -d "{\"email\":\"qa-nosuper@mazefunnels.io\",\"password\":\"QaNoSuper-2026!\"}" | python3 -c "import sys,json; print(\"TOKEN_NOSUPER=\"+json.load(sys.stdin)[\"access_token\"])"'
```

**Importante:** el email `qa-nosuper@mazefunnels.io` NO puede estar en la allowlist `SUPER_ADMINS` (verificar con `grep SUPER_ADMINS api/server.js` o la env del contenedor) — si lo estuviera, la prueba daría un falso verde.

Al terminar el Step, borrar el perfil y el auth user:
```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'SVC=$(grep -E "^SERVICE_ROLE_KEY=" /root/supabase/docker/.env|cut -d= -f2);
curl -s -X DELETE "https://supabase.mazefunnels.io/rest/v1/st_profiles?id=eq.<UID>" -H "apikey: $SVC" -H "Authorization: Bearer $SVC";
curl -s -X DELETE "https://supabase.mazefunnels.io/auth/v1/admin/users/<UID>" -H "apikey: $SVC" -H "Authorization: Bearer $SVC"'
```

```bash
curl -s "https://sales-tracker-test.mazefunnels.io/api/ghl/users?org_id=7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7" -H "Authorization: Bearer $TOKEN_NOSUPER" | python3 -c "import sys,json; d=json.load(sys.stdin); print('access_code:', d.get('access_code'))"
```
Expected: `access_code: siM5ZYQ90OgKoshnqLeC` — el de **su propia** org, ignorando el override.

**Si devuelve `EwHiiqjOSOdzpl909IDY` (la org ajena), la seguridad está rota: DETENER, no seguir con el frontend, reportar.**

- [ ] **Step 5: Verificar que el import escribe en la org correcta**

Elegir un usuario de la subcuenta de Clara con `status: "nuevo"` del Step 3 (si no hay ninguno, saltear este step y dejarlo para el e2e de Ale — no inventar usuarios en GHL).

```bash
curl -s -X POST "https://sales-tracker-test.mazefunnels.io/api/ghl/users/import" -H "Authorization: Bearer $TOKEN_SUPER" -H "Content-Type: application/json" -d '{"ghl_user_id":"<GHL_USER_ID_NUEVO>","role":"setter","org_id":"7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7"}'
```
Luego confirmar en la base que el perfil quedó en Camino Digital:
```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'SVC=$(grep -E "^SERVICE_ROLE_KEY=" /root/supabase/docker/.env|cut -d= -f2); curl -s "https://supabase.mazefunnels.io/rest/v1/st_profiles?ghl_user_id=eq.<GHL_USER_ID_NUEVO>&select=name,org_id,role,active" -H "apikey: $SVC" -H "Authorization: Bearer $SVC"'
```
Expected: `org_id` = `7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7` (Camino Digital). **Si sale `ec8d930b-...` (la org madre), Task 2 dejó un `admin.org_id` sin reemplazar.**

---

### Task 4: Frontend — mostrar la tarjeta en visita y mandar la org

**Files:**
- Modify: `index.html` (`loadGhlUsers` ~1402–1429; `importGhlUser` ~1430–1445; render de Configuraciones ~2203)

**Interfaces:**
- Consumes: `superOrgQS()` y `superOrgBody(obj)` (ya existen, definidas cerca de `enterOrgAsSuper`/`renderSuperBanner`); `SUPER_HOME`, `ME.org_id`, `IS_ADMIN`, `GHL_STATUS`.

- [ ] **Step 1: Mostrar `ghlTeamCard()` en modo visita**

En `index.html`, línea ~2203. Hoy:
```js
    ${visiting ? '' : `${ghlCard()}${ghlTeamCard()}`}${IS_ADMIN ? calibracionCard() : ''}` + footer();
```
Cambiar a (la tarjeta de conexión OAuth `ghlCard()` **sigue oculta** en visita; solo se muestra la de equipo):
```js
    ${visiting ? ghlTeamCard() : `${ghlCard()}${ghlTeamCard()}`}${IS_ADMIN ? calibracionCard() : ''}` + footer();
```

`ghlTeamCard()` ya devuelve `''` si `!IS_ADMIN || !GHL_STATUS || !GHL_STATUS.connected`, y `GHL_STATUS` en modo visita ya trae el estado de la org visitada (`loadGhlStatus` recibió el override en la rama anterior). No hace falta ninguna guarda extra.

- [ ] **Step 2: Ajustar el hint de visita (ya no promete algo falso)**

En `index.html`, línea ~2183, el `visitingHint` hoy dice que la gestión de HighLevel se hace desde Plataforma → Gestionar. Con la tarjeta visible, eso ya no aplica al equipo. Cambiar el texto a:
```js
  const visitingHint=`<div class="section"><div class="eyebrow">Agregar miembro</div>
      <p style="color:var(--muted);font-size:13px;margin:0">Estás de visita en este equipo. El equipo se sincroniza desde HighLevel — importá miembros desde "Equipo desde HighLevel". El alta y la baja manual se hacen desde Plataforma → Gestionar.</p>
    </div>`;
```

- [ ] **Step 3: `loadGhlUsers` manda la org visitada**

En `index.html`, línea ~1410. Hoy:
```js
    res=await fetch('/api/ghl/users',{headers:{'Authorization':'Bearer '+session.access_token}});
```
`superOrgQS()` devuelve un string que empieza con `&`, así que hace falta un query string previo:
```js
    res=await fetch('/api/ghl/users?_=1'+superOrgQS(),{headers:{'Authorization':'Bearer '+session.access_token}});
```

- [ ] **Step 4: `importGhlUser` manda la org visitada**

En `index.html`, línea ~1438. Hoy:
```js
    res=await fetch('/api/ghl/users/import',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},body:JSON.stringify({ghl_user_id:ghlUserId, role})});
```
Cambiar el body:
```js
    res=await fetch('/api/ghl/users/import',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},body:JSON.stringify(superOrgBody({ghl_user_id:ghlUserId, role}))});
```

- [ ] **Step 5: Chequeo de sintaxis del JS del index**

```bash
cd /Users/alevogeler/maze-sales-tracker && node -e "const h=require('fs').readFileSync('index.html','utf8'); const m=h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/); new Function(m[1]); console.log('JS del index: OK');"
```
Expected: `JS del index: OK`.

- [ ] **Step 6: Commit**

```bash
cd /Users/alevogeler/maze-sales-tracker && git add index.html && git commit -m "feat(platform): sincronizar el equipo de HighLevel estando de visita en otra org

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Deploy del frontend y guion de QA

**Files:** (ninguno)

- [ ] **Step 1: Push y deploy del frontend a dev**

```bash
cd /Users/alevogeler/maze-sales-tracker && git push
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'cd /docker/maze-sales-tracker-dev && git pull origin feature/sync-usuarios-ghl-visita --quiet && docker compose -f docker-compose.dev.yml up -d --force-recreate maze-sales-tracker-dev 2>&1 | tail -3'
```

- [ ] **Step 2: Smoke test por curl**

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'echo -n "superOrgQS en /api/ghl/users: "; curl -s https://sales-tracker-test.mazefunnels.io | grep -c "api/ghl/users?_=1"'
```
Expected: `1`.

- [ ] **Step 3: Entregar el guion de QA a Ale (click-through visual, lo hace él)**

Escribir en el resumen final este guion exacto, sobre `https://sales-tracker-test.mazefunnels.io`:

1. Entrar como super → Plataforma → **Entrar** en Camino Digital.
2. Ir a **Configuraciones**. Debe aparecer la tarjeta **Equipo desde HighLevel** (y NO la tarjeta de conexión OAuth ni el alta manual).
3. El **código de acceso** que muestra la tarjeta tiene que ser `EwHiiqjOSOdzpl909IDY` (el de Clara), NO `siM5ZYQ90OgKoshnqLeC`.
4. **"Cargar usuarios de HighLevel"** → lista el equipo de Clara (Maria Clara Perez, Valeria Damico, Adrian Mendoza…), no el de Maze.
5. Importar un usuario nuevo con su rol → aparece en **Miembros del equipo** de Camino Digital.
6. **"Volver a tu equipo"** → Configuraciones vuelve a mostrar la tarjeta de conexión OAuth y la lista de usuarios de Maze.

**Advertencia que va sí o sí en el resumen:** abrir esa lista dispara la reconciliación total sobre el equipo del cliente — auto-vincula por email y **da de baja** (`active=false` + ban) a los perfiles no-`admin` que no estén en la subcuenta GHL. Está aprobado, pero Ale tiene que saber que el primer click puede bajar gente en la org de Clara.

---

## Notas de cierre

- La rama `feature/sync-usuarios-ghl-visita` sale de `feature/super-entrar-org` (depende de `effectiveOrg`), que **todavía no está mergeada a `develop`**. El PR de esta rama va contra `feature/super-entrar-org`, o se mergea primero la base.
- No promover a main/prod sin el QA de Ale.
