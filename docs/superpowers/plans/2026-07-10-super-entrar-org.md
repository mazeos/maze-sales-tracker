# Super-admin entra a cualquier org — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El super-admin puede entrar como admin total a cualquier organización desde la vista Plataforma, sin tener un perfil en ella.

**Architecture:** Dos piezas. (1) Migración RLS 018 que agrega políticas permisivas `_super` (aditivas, se combinan con OR) para que un super lea/edite cualquier org a nivel DB. (2) Frontend: botón "Entrar" por org + un switch client-side que cambia `ME.org_id`, recarga los datos y muestra un banner "Volver a tu equipo". El switch es efímero (un reload vuelve al equipo propio).

**Tech Stack:** Supabase Postgres (RLS) sobre la base compartida del VPS; `index.html` vanilla JS + supabase-js CDN. Sin framework de tests: verificación por `psql` (RLS) y Chrome MCP e2e (frontend).

## Global Constraints

- **Idempotencia:** toda migración usa `drop policy if exists ... ; create policy ...`. Correrla 2 veces no falla.
- **No-regresión de seguridad:** un usuario no-super debe quedar EXACTAMENTE igual que hoy (no gana visibilidad de ninguna otra org). Es el criterio de aceptación crítico.
- **No tocar `st_integrations`** (tokens OAuth; sigue deny-all / server-side).
- **Base compartida:** la migración se aplica en `supabase-db` del VPS (`supabase.mazefunnels.io`) e impacta a todos los tenants, pero solo agrega permisos a los emails de `st_super_admins` (hoy solo `alejandro@mazefunnels.com`).
- **Deploy solo a pruebas** (`sales-tracker-test` / rama `feature/super-entrar-org`). NO promover a main/prod en esta sesión.
- **Idioma UI:** castellano rioplatense.
- **Contraste:** cualquier texto nuevo ≥4.5:1 en tema claro y oscuro.

---

### Task 1: Migración 018 — RLS cross-org para super-admins

**Files:**
- Create: `supabase/migrations/018_super_cross_org.sql`

**Interfaces:**
- Consumes: `public.st_is_super()` (existe desde 014) — devuelve `true` si el email del JWT está en `st_super_admins`.
- Produces: políticas `st_<tabla>_super` en las 8 tablas de datos. Habilitan al super a leer/escribir cualquier org, que es lo que la Task 2 (frontend) asume.

- [ ] **Step 1: Escribir la migración**

Crear `supabase/migrations/018_super_cross_org.sql` con este contenido exacto:

```sql
-- ============================================================
-- Maze Sales Tracker IA — Super-admins operan en CUALQUIER org
-- Políticas permisivas aditivas: en Postgres varias policies
-- permisivas para el mismo comando se combinan con OR, así que
-- esto NO afecta a los no-super (sus policies siguen intactas) y
-- solo agrega acceso a quien pasa st_is_super(). Idempotente.
-- st_integrations NO se toca (tokens; deny-all / service-role).
-- ============================================================

-- Lectura + escritura (for all) en las tablas que la app edita:
drop policy if exists st_orgs_super on public.st_orgs;
create policy st_orgs_super on public.st_orgs
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_prof_super on public.st_profiles;
create policy st_prof_super on public.st_profiles
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_ent_super on public.st_entries;
create policy st_ent_super on public.st_entries
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_goal_super on public.st_goals;
create policy st_goal_super on public.st_goals
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_sale_super on public.st_sales;
create policy st_sale_super on public.st_sales
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_cuo_super on public.st_cuotas;
create policy st_cuo_super on public.st_cuotas
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_kcfg_super on public.st_kpi_config;
create policy st_kcfg_super on public.st_kpi_config
  for all using (public.st_is_super()) with check (public.st_is_super());

-- Solo lectura (la escritura de shadow sigue siendo service-role):
drop policy if exists st_shadow_super on public.st_shadow_metrics;
create policy st_shadow_super on public.st_shadow_metrics
  for select using (public.st_is_super());

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Copiar la migración al VPS y aplicarla**

Desde el Mac (el repo del VPS se sirve por HTTPS público, pero para aplicar la migración pasamos el .sql por SSH — más directo que esperar un pull):

```bash
scp -o StrictHostKeyChecking=no \
  supabase/migrations/018_super_cross_org.sql \
  root@187.77.228.99:/root/018_super_cross_org.sql
ssh -o StrictHostKeyChecking=no root@187.77.228.99 \
  'docker exec -e PGPASSWORD=$(grep POSTGRES_PASSWORD /root/supabase/docker/.env|cut -d= -f2) -i supabase-db psql -U postgres -d postgres < /root/018_super_cross_org.sql'
```

Expected: 8 líneas `CREATE POLICY` (y `DROP POLICY` / `NOTICE` sin error) + `NOTIFY`.

- [ ] **Step 3: Verificar idempotencia**

Correr el mismo comando de aplicación una segunda vez.
Expected: mismo output, sin errores (los `drop policy if exists` absorben la re-creación).

- [ ] **Step 4: Verificar acceso del SUPER (lee org ajena)**

En el VPS, abrir psql y simular el JWT del super:

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 \
  "docker exec -e PGPASSWORD=\$(grep POSTGRES_PASSWORD /root/supabase/docker/.env|cut -d= -f2) -i supabase-db psql -U postgres -d postgres" <<'SQL'
-- Cuántas orgs existen en total (como service role / postgres):
select count(*) as total_orgs from public.st_orgs;
-- Ahora como el SUPER, vía RLS:
set local role authenticated;
set local request.jwt.claims = '{"email":"alejandro@mazefunnels.com","sub":"00000000-0000-0000-0000-000000000000"}';
select count(*) as orgs_visibles_super from public.st_orgs;
select count(*) as entries_visibles_super from public.st_entries;
reset role;
SQL
```

Expected: `orgs_visibles_super` == `total_orgs` (ve TODAS) y `entries_visibles_super` > 0 abarcando varias orgs. El `sub` puede ser cualquier uuid: `st_is_super()` mira el email, no el sub.

- [ ] **Step 5: Verificar NO-regresión (un no-super NO ve orgs ajenas)**

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 \
  "docker exec -e PGPASSWORD=\$(grep POSTGRES_PASSWORD /root/supabase/docker/.env|cut -d= -f2) -i supabase-db psql -U postgres -d postgres" <<'SQL'
-- Tomar un perfil real de un cliente (no-super) y su user_id:
select p.user_id, p.org_id, o.name
  from public.st_profiles p join public.st_orgs o on o.id=p.org_id
  where p.role<>'admin' and p.active is not false
  limit 1;
SQL
```

Copiar el `user_id` devuelto y correr:

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 \
  "docker exec -e PGPASSWORD=\$(grep POSTGRES_PASSWORD /root/supabase/docker/.env|cut -d= -f2) -i supabase-db psql -U postgres -d postgres" <<'SQL'
set local role authenticated;
-- REEMPLAZAR <USER_ID> por el user_id del paso anterior y usar un email NO-super:
set local request.jwt.claims = '{"email":"cliente-no-super@ejemplo.com","sub":"<USER_ID>"}';
select count(*) as orgs_visibles_nosuper from public.st_orgs;
reset role;
SQL
```

Expected: `orgs_visibles_nosuper` == 1 (solo su propia org). Si diera >1 la migración rompió el aislamiento → detener y revisar.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/018_super_cross_org.sql
git commit -m "feat(rls): migración 018 — super-admins operan en cualquier org

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Frontend — botón "Entrar", switch de super y banner

**Files:**
- Modify: `index.html` (estado global de plataforma ~línea 1522; `orgsCard()` ~línea 1585; nuevas funciones cerca del bloque Plataforma ~línea 2040)

**Interfaces:**
- Consumes: `ME` (`{id, role, name, org_id}`), `IS_SUPER`, `IS_ADMIN`, `ORGS` (array de `{id, name, members_active, ghl_connected, ghl_location_name, admins}`), `loadFromSupabase()`, `DB.team.name`, `state`, `go()`, `esc()`, `toast()`, `renderPlatform()`.
- Produces: `SUPER_HOME` (global), `enterOrgAsSuper(i)`, `exitSuperView()`, `renderSuperBanner()`.

- [ ] **Step 1: Agregar el estado `SUPER_HOME`**

En `index.html`, junto a las globals de plataforma (línea ~1522, donde está `let ORGS=null, ...`), agregar en una línea nueva debajo:

```js
let SUPER_HOME=null; // {id,role,name,org_id} del equipo propio mientras el super "entra" a otra org; null = estás en tu equipo
```

- [ ] **Step 2: Agregar el botón "Entrar" en la fila de cada org**

En `orgsCard()`, reemplazar el bloque que arma la fila `tr` (el que hoy es):

```js
      let tr=`<tr>
      <td style="text-align:left">${esc(o.name||'—')}</td>
      <td>${+o.members_active||0}</td>
      <td style="text-align:left">${o.ghl_connected?esc(o.ghl_location_name||'Conectado'):'—'}</td>
      <td style="text-align:left">${(o.admins&&o.admins.length)?o.admins.map(a=>esc(a)).join(', '):'—'}</td>
      <td><button class="btn ghost sm" onclick="toggleOrgPanel(${i})">${o.id===PLAT_M_ORG?'Cerrar':'Gestionar'}</button></td>
    </tr>`;
```

por:

```js
      const isHere=o.id===ME.org_id;
      let tr=`<tr>
      <td style="text-align:left">${esc(o.name||'—')}</td>
      <td>${+o.members_active||0}</td>
      <td style="text-align:left">${o.ghl_connected?esc(o.ghl_location_name||'Conectado'):'—'}</td>
      <td style="text-align:left">${(o.admins&&o.admins.length)?o.admins.map(a=>esc(a)).join(', '):'—'}</td>
      <td style="white-space:nowrap">
        ${isHere?'<span class="tag ok" style="font-size:11px">Estás acá</span>':`<button class="btn ghost sm" onclick="enterOrgAsSuper(${i})">Entrar</button>`}
        <button class="btn ghost sm" onclick="toggleOrgPanel(${i})">${o.id===PLAT_M_ORG?'Cerrar':'Gestionar'}</button>
      </td>
    </tr>`;
```

- [ ] **Step 3: Agregar `enterOrgAsSuper`, `exitSuperView` y `renderSuperBanner`**

Insertar estas tres funciones justo después de `renderPlatform()` (cierre en línea ~2061):

```js
// ---------- Entrar a una org como super-admin (switch client-side) ----------
// Cambia la org activa en el browser y recarga sus datos. La RLS (policies
// _super, migración 018) permite leer/escribir cualquier org. Efímero: un
// reload reconstruye ME desde el perfil propio y SUPER_HOME vuelve a null.
window.enterOrgAsSuper=async(i)=>{
  if(!IS_SUPER) return;
  const o=ORGS&&ORGS[i]; if(!o||o.id===ME.org_id) return;
  if(!SUPER_HOME) SUPER_HOME={...ME}; // guardar el equipo propio la 1ra vez
  ME={id:ME.id, role:'admin', name:ME.name, org_id:o.id}; IS_ADMIN=true;
  await loadFromSupabase();
  state.capMember=DB.members[0]&&DB.members[0].id; state.tblMember=state.capMember;
  renderSuperBanner();
  go('dashboard');
  toast('Entraste a '+(o.name||'la organización'));
};
window.exitSuperView=async()=>{
  if(!SUPER_HOME) return;
  ME={...SUPER_HOME}; SUPER_HOME=null; IS_ADMIN = ME.role==='admin' || IS_SUPER;
  await loadFromSupabase();
  state.capMember=DB.members[0]&&DB.members[0].id; state.tblMember=state.capMember;
  renderSuperBanner();
  go('dashboard');
};
function renderSuperBanner(){
  let b=document.getElementById('superBanner');
  if(!SUPER_HOME){ if(b) b.remove(); document.body.classList.remove('has-super-banner'); return; }
  if(!b){ b=document.createElement('div'); b.id='superBanner'; document.body.appendChild(b); }
  b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:400;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 14px;background:#C5FF49;color:#0e0e10;font-size:13px;font-weight:600;box-shadow:0 2px 12px rgba(0,0,0,.25)';
  b.innerHTML=`<span>👁 Viendo <b>${esc(DB.team.name||'—')}</b> como super-admin</span>`+
    `<button onclick="exitSuperView()" style="background:#0e0e10;color:#C5FF49;border:0;border-radius:8px;padding:5px 12px;font-weight:600;cursor:pointer;font-size:12.5px">Volver a tu equipo</button>`;
  document.body.classList.add('has-super-banner');
}
```

- [ ] **Step 4: Empujar el layout cuando el banner está visible**

Para que el banner fijo no tape el topbar, agregar esta regla en el `<style>` del `<head>` (buscar el bloque de estilos y añadir una línea):

```css
body.has-super-banner .app{padding-top:38px}
```

- [ ] **Step 5: Verificación estática (sin deploy todavía)**

Confirmar que no se rompió la sintaxis del archivo:

```bash
node --check index.html 2>/dev/null || node -e "const h=require('fs').readFileSync('index.html','utf8'); const m=h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/); new Function(m[1]); console.log('JS del index: OK');"
```

Expected: `JS del index: OK` (o sin error). Si `node --check` no aplica a HTML, el segundo comando extrae el `<script>` principal y valida que parsea.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(platform): botón Entrar + banner para que el super entre a cualquier org

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Deploy a pruebas + QA e2e

**Files:** (ninguno — deploy y verificación)

**Interfaces:**
- Consumes: Task 1 (migración aplicada) + Task 2 (código commiteado en `feature/super-entrar-org`).

- [ ] **Step 1: Push de la rama**

```bash
git push -u origin feature/super-entrar-org
```

- [ ] **Step 2: Desplegar la rama al contenedor de pruebas**

`sales-tracker-test` sirve el clon en `/docker/maze-sales-tracker-dev`. Poner la rama feature y recrear el contenedor web (el bind-mount de `index.html` es por inode → `restart` no alcanza, hace falta `--force-recreate`):

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'cd /docker/maze-sales-tracker-dev && git fetch origin && git checkout feature/super-entrar-org && git pull origin feature/super-entrar-org && docker compose up -d --force-recreate web'
```

Expected: el contenedor `web` se recrea. Esperar ~3s antes de verificar.

- [ ] **Step 3: QA e2e con Chrome MCP — entrar a una org**

Cargar los tools de Chrome (`ToolSearch` con el set core) y:
1. `navigate` a `https://sales-tracker-test.mazefunnels.io`
2. Login como `alejandro@mazefunnels.com` (pass `Maze-CallIQ-2026!`).
3. Ir a **Plataforma** (ícono del rail).
4. En la lista de orgs, en la fila de **Camino Digital**, clic en **Entrar**.

Expected: cae en el dashboard de Camino Digital con **cifras reales** (no vacío); aparece el banner lima arriba: `👁 Viendo Camino Digital como super-admin`.

- [ ] **Step 4: QA e2e — el banner persiste entre vistas y el switch funciona**

1. Navegar a **Tabla** y **Ventas** dentro de la org: el banner sigue visible y los datos son de Camino Digital.
2. Clic en **Volver a tu equipo**.

Expected: vuelve a **Maze-Pruebas** (sus datos), el banner desaparece.

- [ ] **Step 5: QA e2e — efímero ante reload**

1. Entrar de nuevo a una org (repetir Step 3 hasta ver el banner).
2. Recargar la página (F5 / `navigate` a la misma URL).

Expected: vuelve al equipo propio, sin banner (el switch no persiste — comportamiento esperado en v1).

- [ ] **Step 6: QA e2e — no-regresión**

1. Logout. Login como un miembro **no-super** de Clara (ej. un setter de Camino Digital; usar una cuenta existente del equipo de Clara).
2. Observar el rail y las orgs.

Expected: **no** aparece el ítem **Plataforma**; solo ve su propio equipo. Ningún acceso a orgs ajenas. (Confirma en el frontend lo que el Step 5 de la Task 1 confirmó en la DB.)

- [ ] **Step 7: Reporte final**

Resumir el resultado del QA (qué se probó, qué pasó) para que Ale lo revise. NO promover a main/prod: eso es parte del release grande pendiente `develop→main`.

---

## Notas de cierre

- Al terminar, la rama `feature/super-entrar-org` queda lista para PR → `develop`. El PR lo abre/mergea Ale (o se hace en una sesión de review).
- Recordar actualizar la memoria del proyecto (`project_maze_sales_tracker`) con: el hallazgo de la RLS (no existía cross-org para super), la migración 018, y el estado de la feature.
