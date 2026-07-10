# Modo visita como admin total (org override) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Un super-admin en "modo visita" opera sobre la org que está viendo también en las acciones que pasan por la mini-API (autocarga, calibración, ventas), no sobre su org madre.

**Architecture:** Los endpoints operativos aceptan un `org_id` explícito; una helper `effectiveOrg(auth, requested)` lo usa solo si el caller es super (si no, ignora el override y usa la org propia). El frontend, en modo visita (`SUPER_HOME!==null`), agrega la org visitada a esas requests. Mismo patrón que ya usan los endpoints de Plataforma.

**Tech Stack:** Node sin deps (`api/server.js`), `index.html` vanilla JS. Verificación: `curl` con JWT (backend) + chequeo de sintaxis + Chrome e2e (frontend).

## Global Constraints

- **No-regresión / seguridad:** el override SOLO surte efecto si `auth.is_super === true`. Un no-super que mande `org_id` de otra org lo ve IGNORADO (usa su propia org). Criterio de aceptación crítico.
- **`is_super` es el gate, no el `org_id`:** el `org_id` solo selecciona sobre qué org (existente) operar; nunca autoriza por sí mismo.
- Base compartida por todos los tenants (Clara en prod). Deploy solo a `sales-tracker-test`. NO promover a main/prod.
- Mantener ocultos en modo visita (del commit `4f87574`): alta/baja de miembro y tarjeta HighLevel (conectar/importar). NO se re-habilitan.
- Idioma UI: castellano rioplatense.

---

### Task 1: Backend — helper `effectiveOrg` + override en endpoints operativos

**Files:**
- Modify: `api/server.js`

**Interfaces:**
- Consumes: `requireMember` (devuelve `{..., org_id, is_super}`), `checkAdminToken`/`requireAdmin` (hoy devuelve `{ok, uid, auth_uid, org_id}` SIN is_super), `SUPER_ADMINS`.
- Produces: `effectiveOrg(auth, requestedOrgId)`; endpoints operativos que respetan `org_id` para supers.

- [ ] **Step 1: Exponer `is_super` en `checkAdminToken`**

En `api/server.js`, el `return` de `checkAdminToken` (línea ~263) hoy es:
```js
  return { ok: true, uid: prof.id, auth_uid: usr.uid, org_id: prof.org_id };
```
Cambiarlo a (la variable `isSuper` ya existe en el scope de la función, línea ~250):
```js
  return { ok: true, uid: prof.id, auth_uid: usr.uid, org_id: prof.org_id, is_super: isSuper };
```

- [ ] **Step 2: Agregar la helper `effectiveOrg`**

Justo después de `requireMember` (línea ~287), agregar:
```js
// Org efectiva para acciones de la mini-API. Un super-admin puede apuntar a
// otra org pasando ?org_id= (GET) o body.org_id (POST); cualquier otro caller
// queda atado a su propia org (el override se ignora). is_super es el gate:
// el org_id solo elige sobre qué org operar, nunca autoriza.
function effectiveOrg(auth, requestedOrgId) {
  return (auth && auth.is_super && requestedOrgId) ? String(requestedOrgId) : auth.org_id;
}
```

- [ ] **Step 3: Aplicar el override en los 6 handlers operativos**

En cada handler, computar la org efectiva al inicio y reemplazar TODOS los usos de `member.org_id` / `admin.org_id` por esa variable local. El `requested` sale de la query en GET (`url.searchParams.get('org_id')`) o del body ya parseado en POST (`body.org_id`, leído igual que los otros campos del body en ese handler).

Ejemplo completo — `captureGhl(req, res, member, url)` (línea ~609). Al inicio del handler:
```js
  const orgId = effectiveOrg(member, url.searchParams.get('org_id'));
```
y usar `orgId` en lugar de `member.org_id` en el resto del handler (incluido el filtro del perfil target `&org_id=eq.${orgId}`).

Aplicar el MISMO patrón a los otros cinco (leé cada handler, buscá `member.org_id`/`admin.org_id`, reemplazá por la org efectiva):

| Handler (línea aprox.) | Auth | `requested` viene de |
|---|---|---|
| `ghlLeads` (~526/routing 2989) | `member` | `url.searchParams.get('org_id')` — pasar `url` al handler si no lo recibe |
| `captureGhl` (~609) | `member` | `url.searchParams.get('org_id')` (ya recibe `url`) |
| `shadowRun` (~787) | `admin` | `body.org_id` (leer del body, igual que `date`) |
| `salesGhl` (~1041) | `member` | `body.org_id` |
| `/api/integrations/ghl` GET (routing ~2952) | según el handler | `url.searchParams.get('org_id')` |
| `/api/ghl/calendars` GET (routing) | según el handler | `url.searchParams.get('org_id')` |

Para `ghlLeads` y los GET del routing que no reciban `url`, pasarles `url` desde el bloque de routing (que ya tiene `url` parseada), igual que `captureGhl`.

- [ ] **Step 4: Deploy del backend a dev (necesario para verificar por curl)**

`api` se **buildea** (no es bind-mount), hay que recrearlo:
```bash
cd /Users/alevogeler/maze-sales-tracker && git add api/server.js && git commit -m "feat(api): org override validado por is_super en endpoints operativos

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" && git push
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'cd /docker/maze-sales-tracker-dev && git pull origin feature/super-entrar-org --quiet && docker compose -f docker-compose.dev.yml up -d --build --force-recreate api 2>&1 | tail -4'
```

- [ ] **Step 5: Verificar override para SUPER (lee org ajena)**

Necesitás un JWT de super. Obtenerlo desde el VPS con las creds del super (email `alejandro@mazefunnels.com`, pass `Maze-CallIQ-2026!`) contra GoTrue:
```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'ANON=$(grep -E "^ANON_KEY=" /root/supabase/docker/.env|cut -d= -f2); curl -s -X POST "https://supabase.mazefunnels.io/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" -d "{\"email\":\"alejandro@mazefunnels.com\",\"password\":\"Maze-CallIQ-2026!\"}" | head -c 200'
```
Copiar el `access_token`. Con él, pegarle a `/api/integrations/ghl` de una org ajena (Camino Digital / Clara — buscar su `org_id` en `st_orgs`) y sin override:
```bash
# con override (org de Clara):
curl -s "https://sales-tracker-test.mazefunnels.io/api/integrations/ghl?org_id=<ORG_CLARA>" -H "Authorization: Bearer <TOKEN_SUPER>"
# sin override (org madre del super):
curl -s "https://sales-tracker-test.mazefunnels.io/api/integrations/ghl" -H "Authorization: Bearer <TOKEN_SUPER>"
```
Expected: con override devuelve el estado GHL de la org de Clara; sin override, el de la org madre. Distintos → el override funciona para el super.

- [ ] **Step 6: Verificar NO-regresión (un no-super ignora el override)**

Obtener un JWT de un miembro no-super de una org (ej. un setter de Camino Digital; si no tenés la pass, creá uno temporal o usá una cuenta de prueba conocida). Pegarle con `?org_id=<otra org>`:
```bash
curl -s "https://sales-tracker-test.mazefunnels.io/api/integrations/ghl?org_id=<ORG_AJENA>" -H "Authorization: Bearer <TOKEN_NOSUPER>"
```
Expected: responde el estado de SU propia org (ignora el override), NO el de la org ajena. Si devolviera datos de la org ajena, la seguridad está rota → detener.

- [ ] **Step 7: Commit** (si Step 4 no lo dejó commiteado por separado, asegurar que `api/server.js` está commiteado)

---

### Task 2: Frontend — mandar la org visitada en las requests operativas

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `SUPER_HOME`, `ME.org_id`, `encodeURIComponent`.
- Produces: `superOrgQS()`, `superOrgBody(obj)`; call-sites operativos que mandan la org visitada en modo visita.

- [ ] **Step 1: Agregar los helpers**

Cerca de `enterOrgAsSuper`/`renderSuperBanner` (bloque del switch de super), agregar:
```js
// En modo visita, apuntar las requests a la mini-API a la org visitada.
function superOrgQS(){ return SUPER_HOME ? ('&org_id='+encodeURIComponent(ME.org_id)) : ''; }
function superOrgBody(o){ return SUPER_HOME ? Object.assign({}, o, {org_id:ME.org_id}) : o; }
```

- [ ] **Step 2: Aplicar en los call-sites GET (query string)**

En cada uno de estos `fetch`, agregar `+superOrgQS()` al final del query string (antes de las comillas de cierre de la URL):
- `autofillGhl` (~957): `fetch('/api/capture/ghl?'+q.toString()+superOrgQS(), ...)`
- `backfillTable` (~1100): `fetch('/api/capture/ghl?'+q+superOrgQS(), ...)`
- `loadGhlStatus` (~1170): `fetch('/api/integrations/ghl?_=1'+superOrgQS(), ...)` — si la URL no tiene query, agregar uno (`?_=1`) para que `+superOrgQS()` (que empieza con `&`) sea válido. Alternativamente `'/api/integrations/ghl'+(SUPER_HOME?('?org_id='+encodeURIComponent(ME.org_id)):'')`.
- `loadGhlLeads` (~2437): `fetch('/api/ghl/leads?_=1'+superOrgQS(), ...)` (mismo cuidado con el `?`).
- `loadGhlLocation` (~2500): igual que `loadGhlStatus`.

Usá el criterio del archivo; lo importante es que en modo visita la request lleve `org_id=<org visitada>` y fuera de visita quede idéntica a hoy.

- [ ] **Step 3: Aplicar en los call-sites POST (body)**

- `runShadow` (~2286): el body hoy es `JSON.stringify({})` → `JSON.stringify(superOrgBody({}))`.
- `addSale` → `/api/sales/ghl` (~2477): envolver el body con `superOrgBody(...)`.

- [ ] **Step 4: Verificación de sintaxis**
```bash
cd /Users/alevogeler/maze-sales-tracker && node -e "const h=require('fs').readFileSync('index.html','utf8'); const m=h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/); new Function(m[1]); console.log('JS del index: OK');"
```
Expected: `JS del index: OK`.

- [ ] **Step 5: Commit**
```bash
git add index.html && git commit -m "feat(platform): modo visita manda la org visitada a la mini-API

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Deploy frontend + QA

**Files:** (ninguno)

- [ ] **Step 1: Push + deploy del frontend a dev**
```bash
git push
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'cd /docker/maze-sales-tracker-dev && git pull origin feature/super-entrar-org --quiet && docker compose -f docker-compose.dev.yml up -d --force-recreate maze-sales-tracker-dev 2>&1 | tail -3'
```

- [ ] **Step 2: Smoke test por curl**
```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'echo -n "superOrgQS en test: "; curl -s https://sales-tracker-test.mazefunnels.io | grep -c "superOrgQS"'
```
Expected: ≥1.

- [ ] **Step 3: QA e2e (queda para Ale — click-through visual)**

Documentar para Ale el guion de QA: entrar a Camino Digital como super → Cargar día → ⚡ Autocompletar trae datos del cliente (no 404) → calibración "Correr ahora" corre sobre la org visitada (chequear en `st_shadow_metrics` que el `org_id` escrito es el de Clara, NO Maze) → Ventas muestra leads del cliente → Volver a tu equipo. El click-through lo hace Ale en su navegador.

---

## Notas de cierre
- Deja la rama `feature/super-entrar-org` completa (switch + RLS + override) lista para PR → `develop`, pendiente del QA visual de Ale.
- Actualizar memoria del proyecto con el estado final.
