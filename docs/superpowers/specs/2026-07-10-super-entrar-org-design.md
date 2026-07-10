# Super-admin entra a cualquier organización — Diseño

**Fecha:** 2026-07-10
**Rama:** `feature/super-entrar-org`
**Estado:** aprobado por Ale, listo para plan

## Problema

El super-admin (hoy solo `alejandro@mazefunnels.com`) debe poder **entrar como admin a cualquier organización** desde la vista Plataforma, sin necesitar un perfil creado en cada una. Hoy no puede: el selector de equipo (`MY_PROFILES` en `boot()`) solo lista orgs donde tiene un perfil activo, así que no puede "pararse" en una org ajena.

## Hallazgo crítico (corrige una suposición previa)

Se creía que "la RLS con `st_is_super()` ya permite leer cualquier org". **Es falso.** Verificado en el código:

- **Ninguna** política `SELECT` de las tablas de datos usa `st_is_super()`. Todas filtran por `org_id = st_my_org()`.
- `st_my_org()` deriva del **perfil activo** (`st_user_state` → `st_profiles`). El super no tiene perfil en orgs ajenas → `st_my_org()` siempre es su org madre.
- Lo único que `st_is_super()` habilita hoy es que `st_is_admin()` devuelva `true`, lo cual solo aplica **dentro** de una org donde ya sos miembro (permisos de admin aunque el rol sea menor). **No cruza orgs.**

**Consecuencia:** un switch client-side puro (cambiar `ME.org_id` en el browser) chocaría con la RLS y traería 0 filas. La solución requiere arreglar la RLS en la base — que es donde vive el modelo de permisos — además del frontend.

## Enfoque elegido

**Switch client-side como super** (no magic-link / no impersonación de miembro): el super mantiene su identidad de super-admin y opera con permisos de admin total en la org destino. Respaldado por policies RLS `_super` a nivel DB.

Descartado: reusar el magic-link "Entrar como" un miembro (te loguea COMO otro usuario y perdés la identidad de super — sirve para "ver lo que ve el cliente", no para "entrar como super").

## Sección 1 — Backend: migración 018 (RLS)

Por cada tabla de datos que la app lee/escribe, agregar **una política permisiva nueva** `_super`, sin tocar las existentes. En Postgres las políticas permisivas se combinan con OR → cambio puro aditivo e idempotente.

Patrón general (lectura + escritura):

```sql
create policy st_<tabla>_super on public.st_<tabla>
  for all using (public.st_is_super()) with check (public.st_is_super());
```

Tablas con `for all` (lee + edita): `st_orgs`, `st_profiles`, `st_entries`, `st_goals`, `st_sales`, `st_cuotas`, `st_kpi_config`.

Tabla solo lectura para el super (la escritura sigue siendo service-role, como hoy): `st_shadow_metrics` → `for select using (public.st_is_super())`.

**NO se toca `st_integrations`** — contiene tokens OAuth, sigue deny-all / acceso server-side vía mini-API. El super ve el estado de GHL de la org por la mini-API (que ya valida `is_super`), no por RLS.

Requisitos de la migración:
- Idempotente (`drop policy if exists ... ; create policy ...` por cada una).
- Refrescar PostgREST al final (`NOTIFY pgrst, 'reload schema'`).
- Se aplica en la base compartida del VPS (`supabase.mazefunnels.io`), impacta a todos los tenants pero **solo agrega permisos a los emails de `st_super_admins`** (hoy solo Ale). Un no-super queda idéntico a hoy.

### Verificación de seguridad (parte del testing)
Probar con `SET request.jwt.claims` en psql:
- **Super** (email en `st_super_admins`): `SELECT` sobre `st_entries` de una org ajena → devuelve filas; `INSERT`/`UPDATE` en org ajena → OK.
- **No-super** (email cualquiera): `SELECT` sobre org ajena → **0 filas** (sin cambios vs. hoy). Este es el caso crítico anti-regresión.

## Sección 2 — Frontend (`index.html`)

### Estado nuevo
- `let SUPER_HOME = null;` — guarda el `ME` original (`{id, role, name, org_id}`) mientras el super está "viendo" otra org. `null` = estás en tu propio equipo.

### Botón "Entrar" en la lista de orgs
En `orgsCard()`, en la fila de cada org (`ORGS.map`), agregar un botón junto a "Gestionar":
```
<button class="btn ghost sm" onclick="enterOrgAsSuper(${i})">Entrar</button>
```
No mostrar "Entrar" para la org en la que ya estás parado (comparar `ORGS[i].id === ME.org_id`).

### `enterOrgAsSuper(i)`
1. `const o = ORGS[i];`
2. Si `SUPER_HOME === null`, guardar `SUPER_HOME = {...ME};` (solo la primera vez, para no perder la org madre al saltar entre orgs).
3. `ME = {id: ME.id, role: 'admin', name: ME.name, org_id: o.id};` — `IS_ADMIN` ya es `true` por `IS_SUPER`. `ME.id` se mantiene (loadFromSupabase no lo usa; `save()` escribe `member_id` de un miembro real; con la migración la RLS lo deja escribir).
4. `await loadFromSupabase();`
5. `state.capMember = DB.members[0] && DB.members[0].id; state.tblMember = state.capMember;`
6. `renderSuperBanner(); go('dashboard');`

### `exitSuperView()`
1. `if(!SUPER_HOME) return;`
2. `ME = SUPER_HOME; SUPER_HOME = null;`
3. `await loadFromSupabase();`
4. `state.capMember = DB.members[0] && DB.members[0].id; state.tblMember = state.capMember;`
5. `renderSuperBanner(); go('dashboard');`

### Banner global
Elemento fijo fuera de `VIEW` (para que se vea en todas las vistas), tipo `#superBanner`, mostrado/ocultado por `renderSuperBanner()`:
- Visible solo cuando `SUPER_HOME !== null`.
- Texto: `👁 Viendo <nombre org> como super-admin` + botón `Volver a tu equipo` (`onclick="exitSuperView()"`).
- Estilo coherente con el tema (usa tokens existentes; contraste ≥4.5 en claro y oscuro).

### Persistencia
**Efímero.** Un reload (F5) reconstruye `ME` desde el perfil madre en `boot()` y `SUPER_HOME` vuelve a `null` → estás en tu equipo. No se persiste en v1 (documentado como decisión; persistir sería un add futuro, y es frágil porque `IS_SUPER` se resuelve async best-effort tras el primer `loadFromSupabase`).

## Testing

1. **RLS (psql, base del VPS):** los 2 casos de la verificación de seguridad de arriba (super lee/escribe org ajena; no-super sigue en 0 filas). Idempotencia (correr la migración 2 veces sin error).
2. **Frontend e2e (Chrome MCP, como `alejandro@mazefunnels.com` en `sales-tracker-test`):**
   - Plataforma → "Entrar" en Camino Digital → ve datos reales de Clara (dashboard con cifras, no vacío).
   - Banner visible con el nombre correcto; navegar entre vistas mantiene el banner.
   - "Volver a tu equipo" → vuelve a Maze-Pruebas, banner desaparece.
   - F5 en modo super-view → vuelve a su equipo (efímero verificado).
   - No-regresión: un usuario normal (setter de Clara) no ve botón Plataforma ni orgs ajenas.

## Fuera de alcance (YAGNI)
- Persistencia del switch ante reload.
- Impersonar a un miembro concreto (ya existe el magic-link "Entrar como").
- Cualquier cambio en `st_integrations` / tokens.

## Deploy
- Rama `feature/super-entrar-org` → PR a `develop` → desplegar a `sales-tracker-test`.
- Migración 018 aplicada en la base compartida del VPS (`docker exec supabase-db psql`).
- **NO** promover a main/prod en esta sesión (parte del release grande pendiente develop→main).
