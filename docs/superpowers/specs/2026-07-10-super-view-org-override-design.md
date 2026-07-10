# Modo visita como admin total real (org override en la mini-API) — Diseño

**Fecha:** 2026-07-10
**Rama:** `feature/super-entrar-org` (continúa el trabajo del switch de super)
**Estado:** aprobado el enfoque por Ale (fix de raíz), pendiente review del spec

## Problema

El switch "entrar a una org como super" es client-side (cambia `ME.org_id` en el browser). Las lecturas/escrituras vía supabase-js van bien a la org visitada (respaldadas por la RLS `_super`, migración 018). Pero **toda acción que pasa por la mini-API** (`fetch('/api/...')`) resuelve la org server-side desde el perfil activo del super (`resolveActiveProfile` → `st_user_state`) = su **org madre**. En modo visita, esos controles operan sobre la org equivocada:

| Control (front) | Endpoint | Efecto en visita hoy |
|---|---|---|
| ⚡ Autocompletar (Cargar día) — `autofillGhl` | `GET /api/capture/ghl` | 404 silencioso |
| ⚡ Traer de HighLevel (Tabla) — `backfillTable` | `GET /api/capture/ghl` | 404 silencioso |
| "Correr ahora" calibración — `runShadow` | `POST /api/shadow/run` | **pisa `st_shadow_metrics` de la org madre** (Critical) |
| Leads con cita (Ventas) — `loadGhlLeads` | `GET /api/ghl/leads` | lee leads de la org madre |
| Registrar venta GHL (Ventas) — `addSale` | `POST /api/sales/ghl` | crea opp/tag en el GHL de la org madre (Critical) |
| Estado GHL — `loadGhlStatus`/`loadGhlLocation` | `GET /api/integrations/ghl` | estado de la org madre |

**Causa raíz única:** la mini-API no conoce el switch. Esconder controles de a uno es whack-a-mole.

## Enfoque elegido (decisión de Ale)

**Org override validado por `is_super`.** Los endpoints operativos aceptan un `org_id` explícito; si el caller es super, operan sobre esa org; si no, lo ignoran (usan su propia org). Es el mismo patrón que ya usan los endpoints de Plataforma (`/api/orgs/:id/*`, gateados por `requireSuperAdmin`). Resultado: modo visita = admin total real (autocarga, calibración, ventas del cliente funcionan).

## Sección 1 — Backend (`api/server.js`)

### Helper de resolución
```js
// Org efectiva: un super-admin puede apuntar a otra org pasando ?org_id=/body.org_id;
// cualquier otro caller queda atado a su propia org (el override se ignora).
function effectiveOrg(auth, requestedOrgId) {
  return (auth.is_super && requestedOrgId) ? String(requestedOrgId) : auth.org_id;
}
```
- `checkAdminToken` hoy no expone `is_super` en su retorno; agregarlo (ya lo calcula internamente, línea ~250-258) para que `requireAdmin` lo tenga. `requireMember` ya devuelve `is_super` (línea 286).

### Endpoints que toman override
Leer el `org_id` solicitado (query `?org_id=` en GET, `body.org_id` en POST) y pasarlo por `effectiveOrg(auth, requested)` antes de usar la org:

1. `GET /api/capture/ghl` (usa `requireMember`) — `captureGhl`: reemplazar `member.org_id` por `effectiveOrg(member, req.query.org_id)`. Ojo: el filtro del perfil target (`&org_id=eq.{...}`, hoy línea ~615/captureGhl) debe usar la org efectiva, para que el `member_id` de la org visitada matchee.
2. `POST /api/shadow/run` (usa `requireAdmin`) — `shadowRun`/`runShadowForOrg(org, date)`: usar `effectiveOrg(admin, body.org_id)`.
3. `GET /api/ghl/leads` — usar org efectiva (afecta `getGhlCreds`/`leadsCache` por org).
4. `POST /api/sales/ghl` — usar org efectiva para la integración GHL y el insert.
5. `GET /api/integrations/ghl` — devolver el estado de la org efectiva.
6. `GET /api/ghl/calendars` — org efectiva (por si se usa fuera de la tarjeta oculta).

### Seguridad
- El override SOLO tiene efecto si `auth.is_super`. Un no-super que mande `org_id` de otra org lo ve ignorado → su propia org. Mantener este invariante es el criterio crítico (equivale a la no-regresión de la migración 018).
- No confiar en el `org_id` para autorizar: `is_super` es el gate; el `org_id` solo selecciona sobre qué org (existente) operar.

## Sección 2 — Frontend (`index.html`)

### Helper de override
```js
// En modo visita, apuntar las requests a la mini-API a la org visitada.
function superOrgQS(){ return SUPER_HOME ? ('&org_id='+encodeURIComponent(ME.org_id)) : ''; }
function superOrgBody(o){ return SUPER_HOME ? {...o, org_id:ME.org_id} : o; }
```
Aplicar en los call-sites operativos: `autofillGhl` (957), `backfillTable` (1100), `runShadow` (2286, body), `loadGhlLeads` (2437), `addSale` → `/api/sales/ghl` (2477, body), `loadGhlStatus` (1170), `loadGhlLocation` (2500). (Los de Plataforma ya mandan su propio `orgId` y no se tocan.)

### Qué queda OCULTO en modo visita (se mantiene del fix `4f87574`)
Gestión de **identidad y conexión** de la org, que se hace desde **Plataforma → Gestionar** o entrando propiamente al equipo — NO se re-habilita:
- Alta / baja de miembro (`addMember`/`delMember`).
- Tarjeta HighLevel: conectar/desconectar, calendarios, importar usuarios (`ghlCard`/`ghlTeamCard`).

Razón: son operaciones de configuración de la cuenta, no de trabajo diario; duplicarlas en visita agrega superficie de error sin valor.

### Qué se HABILITA en modo visita (con el override)
Trabajo diario del cliente: ⚡ Autocompletar (Cargar día), ⚡ Traer de HighLevel (Tabla), "Correr ahora" (calibración), módulo Ventas (leads + registrar venta). Para que estos sepan si el cliente tiene GHL, `loadGhlStatus` con override trae el estado de la org visitada.

## Testing

1. **Backend (psql/curl con JWT):**
   - Super con `?org_id=<org ajena>` en `GET /api/capture/ghl` → responde datos de la org ajena (no 404).
   - Super sin override → su propia org (sin cambios).
   - **No-super** con `?org_id=<org ajena>` → ignora el override, responde su propia org (criterio crítico).
2. **Frontend e2e (Chrome, como super en `sales-tracker-test`):**
   - Entrar a una org cliente → Cargar día → ⚡ Autocompletar trae datos del cliente (no 404).
   - Calibración "Correr ahora" → corre sobre la org visitada (verificar en `st_shadow_metrics` que escribió con el `org_id` visitado, NO Maze).
   - Ventas → leads son del cliente; registrar una venta de prueba crea la opp en el GHL del cliente.
   - Volver a tu equipo → todo vuelve a Maze.
3. **No-regresión:** un admin normal (no-super) de un cliente opera igual que hoy; el override no le hace nada.

## Fuera de alcance (YAGNI)
- Re-habilitar alta de miembro / conexión GHL en visita (queda en Gestionar).
- Persistencia del switch ante reload (sigue efímero).

## Deploy
- Continúa en `feature/super-entrar-org`. Deploy dev: `ssh ... 'cd /docker/maze-sales-tracker-dev && git pull && docker compose -f docker-compose.dev.yml up -d --force-recreate maze-sales-tracker-dev api'` (recrear TAMBIÉN `api` porque cambió `server.js`; el `api` se **buildea**, no es bind-mount). NO promover a main/prod.
