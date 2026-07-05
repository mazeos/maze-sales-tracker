# Tracker de cuotas por cobrar + Caja — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rastrear las cuotas pendientes de cada venta (caja del back) y mostrar una vista "Caja" con cash del front, cobros del back, total en la calle y proyección.

**Architecture:** Tabla `st_cuotas` en el Supabase compartido del VPS, con un trigger sobre `st_sales` que genera/regenera el plan de pagos mensual. El frontend (single-file `index.html`, supabase-js directo + RLS) suma una vista "Caja" con acciones de cobro solo-admin y link white-label al contacto GHL.

**Tech Stack:** Postgres (Supabase self-hosted, contenedor `supabase-db`), plpgsql, vanilla JS en `index.html`, nginx + docker compose en el VPS.

**Spec:** `docs/superpowers/specs/2026-07-05-cuotas-caja-design.md`

## Global Constraints

- Todo el trabajo ocurre en el VPS (`ssh root@187.77.228.99`), repo `/docker/maze-sales-tracker-dev`, rama `develop`. No hay copia local.
- **UNA sola base compartida**: dev, prod multi-tenant y Clara apuntan al mismo Supabase (`supabase.mazefunnels.io`, tablas `st_*` en schema `public`). Toda migración impacta a los tres al aplicarse. Los tests SQL van SIEMPRE dentro de `begin; … rollback;`.
- Migraciones idempotentes (patrón existente: `create … if not exists`, `drop policy if exists` + `create policy`, `create or replace function`).
- RLS patrón `st_`: SELECT toda la org (`org_id = public.st_my_org()`); escritura solo admin (`public.st_is_admin()`).
- "Cantidad de pagos" (`st_sales.cuotas`) **incluye** el pago hecho al cierre cuando entró cash.
- "Vencida" NUNCA se guarda: se deriva (`due_date < hoy` y no pagada).
- Links a GHL siempre `https://app.mazefunnels.com/...`, jamás `gohighlevel.com`.
- Copy de UI en castellano latino. Sin dependencias npm nuevas.
- Frontend dev se sirve por bind-mount readonly (`sales-tracker-test.mazefunnels.io`): guardar `index.html` alcanza, sin rebuild.
- No hay framework de tests: SQL se verifica con bloques `do $$ … assert … $$` transaccionales; frontend con verificación manual en el navegador.
- Commits frecuentes en `develop`, mensajes en español, formato `feat(caja): …` / `chore(db): …`.

---

### Task 1: Migración 008 — tabla `st_cuotas` + RLS

**Files:**
- Create: `/docker/maze-sales-tracker-dev/supabase/migrations/008_cuotas.sql`

**Interfaces:**
- Produces: tabla `public.st_cuotas` con columnas `id uuid PK`, `org_id uuid`, `sale_id uuid`, `numero int`, `monto numeric`, `due_date date`, `status text ('pendiente'|'pagada')`, `paid_date date`, `paid_amount numeric`, `created_at timestamptz`. Tasks 2–5 dependen de estos nombres exactos.

- [ ] **Step 1: Escribir la migración**

Contenido completo de `supabase/migrations/008_cuotas.sql`:

```sql
-- ============================================================
-- Maze Sales Tracker IA — Cuotas por cobrar (caja del back)
-- Una fila por cuota del plan de pagos de una venta.
-- "Vencida" NO se guarda: se deriva (due_date < hoy y status pendiente).
-- Idempotente: se puede correr varias veces sin romper.
-- ============================================================

create table if not exists public.st_cuotas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  sale_id uuid not null references public.st_sales(id) on delete cascade,
  numero int not null,
  monto numeric not null default 0,
  due_date date not null,
  status text not null default 'pendiente' check (status in ('pendiente','pagada')),
  paid_date date,
  paid_amount numeric,
  created_at timestamptz default now()
);
create index if not exists st_cuotas_org on public.st_cuotas(org_id);
create index if not exists st_cuotas_sale on public.st_cuotas(sale_id);
create index if not exists st_cuotas_org_status_due on public.st_cuotas(org_id, status, due_date);

-- RLS: toda la org las ve; solo el admin escribe (cobra/edita/borra)
alter table public.st_cuotas enable row level security;
drop policy if exists st_cuo_sel on public.st_cuotas;
create policy st_cuo_sel on public.st_cuotas for select using (org_id = public.st_my_org());
drop policy if exists st_cuo_ins on public.st_cuotas;
create policy st_cuo_ins on public.st_cuotas for insert with check (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_cuo_upd on public.st_cuotas;
create policy st_cuo_upd on public.st_cuotas for update using (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_cuo_del on public.st_cuotas;
create policy st_cuo_del on public.st_cuotas for delete using (org_id = public.st_my_org() and public.st_is_admin());
```

- [ ] **Step 2: Aplicar la migración a la base compartida**

```bash
docker exec -i supabase-db psql -U postgres -d postgres < /docker/maze-sales-tracker-dev/supabase/migrations/008_cuotas.sql
```

Expected: `CREATE TABLE`, `CREATE INDEX` ×3, `ALTER TABLE`, `DROP POLICY`/`CREATE POLICY` ×4, sin errores.

- [ ] **Step 3: Verificar tabla y políticas**

```bash
docker exec supabase-db psql -U postgres -d postgres -tc \
  "select count(*) from information_schema.columns where table_name='st_cuotas';"
docker exec supabase-db psql -U postgres -d postgres -tc \
  "select count(*) from pg_policies where tablename='st_cuotas';"
```

Expected: `10` (columnas) y `4` (políticas).

- [ ] **Step 4: Commit**

```bash
cd /docker/maze-sales-tracker-dev
git add supabase/migrations/008_cuotas.sql
git commit -m "feat(caja): tabla st_cuotas con RLS (cuotas por cobrar)"
```

---

### Task 2: Migración 009 — generación automática del plan (función + trigger)

**Files:**
- Create: `/docker/maze-sales-tracker-dev/supabase/migrations/009_cuotas_trigger.sql`

**Interfaces:**
- Consumes: tabla `public.st_cuotas` (Task 1) y tabla existente `public.st_sales` (columnas `facturado`, `cash`, `reserva`, `cuotas`, `sale_date`, `org_id`, `id`).
- Produces: `public.st_regen_cuotas(p_sale public.st_sales) returns void` — regenera el plan de una venta preservando las pagadas. La usan el trigger `st_sales_gen_cuotas` (esta task) y el backfill (Task 3).

**Reglas de negocio (del spec, exactas):**
- `resto = facturado − cash − reserva − Σ paid_amount de las cuotas pagadas`. Si `resto ≤ 0` → cero cuotas pendientes.
- `pagos_al_cierre = 1 si cash > 0, sino 0` (la "cantidad de pagos" incluye el primero).
- `n_pendientes = cuotas − pagos_al_cierre − (cantidad de pagadas)`. Si hay resto pero `n_pendientes < 1` → se genera **1** cuota por el resto (la plata en la calle nunca queda invisible).
- Cuotas mensuales iguales; la **última absorbe el redondeo** (la suma da el resto exacto).
- Cuota pendiente i vence `sale_date + (pagadas + i) meses`; su `numero = pagos_al_cierre + pagadas + i`.
- Al regenerar (update de la venta) se borran SOLO las `pendiente`; las `pagada` jamás se tocan.

- [ ] **Step 1: Escribir la migración**

Contenido completo de `supabase/migrations/009_cuotas_trigger.sql`:

```sql
-- ============================================================
-- Maze Sales Tracker IA — Generación automática del plan de cuotas
-- security definer: la dispara cualquier creador de venta (closer),
-- pero escribe st_cuotas como owner (la RLS de escritura es solo-admin).
-- Idempotente.
-- ============================================================

create or replace function public.st_regen_cuotas(p_sale public.st_sales)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_paid_count int;
  v_paid_sum   numeric;
  v_pagos_cierre int;
  v_n     int;
  v_resto numeric;
  v_monto numeric;
  v_i     int;
begin
  -- Las pagadas jamás se tocan; las pendientes se regeneran desde cero.
  delete from public.st_cuotas where sale_id = p_sale.id and status = 'pendiente';

  select count(*), coalesce(sum(paid_amount), 0)
    into v_paid_count, v_paid_sum
    from public.st_cuotas
   where sale_id = p_sale.id and status = 'pagada';

  v_resto := coalesce(p_sale.facturado, 0) - coalesce(p_sale.cash, 0)
             - coalesce(p_sale.reserva, 0) - v_paid_sum;
  if v_resto <= 0 then return; end if;

  -- "Cantidad de pagos" incluye el pago hecho al cierre (si entró cash).
  v_pagos_cierre := case when coalesce(p_sale.cash, 0) > 0 then 1 else 0 end;
  v_n := coalesce(p_sale.cuotas, 1) - v_pagos_cierre - v_paid_count;
  -- Hay resto pero el nro de pagos no deja cuotas -> una sola por el resto.
  if v_n < 1 then v_n := 1; end if;

  for v_i in 1..v_n loop
    v_monto := case when v_i = v_n
                 then v_resto - round(v_resto / v_n, 2) * (v_n - 1)
                 else round(v_resto / v_n, 2)
               end;
    insert into public.st_cuotas (org_id, sale_id, numero, monto, due_date)
    values (
      p_sale.org_id,
      p_sale.id,
      v_pagos_cierre + v_paid_count + v_i,
      v_monto,
      (p_sale.sale_date + make_interval(months => v_paid_count + v_i))::date
    );
  end loop;
end $$;

create or replace function public.st_cuotas_trg()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.st_regen_cuotas(new);
  return new;
end $$;

drop trigger if exists st_sales_gen_cuotas on public.st_sales;
create trigger st_sales_gen_cuotas
  after insert or update of facturado, cash, reserva, cuotas, sale_date
  on public.st_sales
  for each row execute function public.st_cuotas_trg();
```

- [ ] **Step 2: Aplicar la migración**

```bash
docker exec -i supabase-db psql -U postgres -d postgres < /docker/maze-sales-tracker-dev/supabase/migrations/009_cuotas_trigger.sql
```

Expected: `CREATE FUNCTION` ×2, `DROP TRIGGER`, `CREATE TRIGGER`, sin errores.

- [ ] **Step 3: Test transaccional (se revierte solo — NO deja datos)**

Guardar como `/tmp/test_cuotas.sql` y correr. Cubre: generación en insert, redondeo, regeneración en update preservando pagadas, venta sin resto, cascade en delete.

```sql
begin;

-- Fixture aislado (org de prueba, se revierte al final)
insert into public.st_orgs (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '__test_cuotas__');

-- Caso 1: $3000, cash $1000, 3 pagos -> 2 cuotas de $1000, meses 1 y 2
insert into public.st_sales (id, org_id, sale_date, cliente, facturado, cash, cuotas, reserva)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        '2026-07-05', 'Test Uno', 3000, 1000, 3, 0);

do $$
declare n int; s numeric; d1 date; n1 int;
begin
  select count(*), sum(monto) into n, s from st_cuotas where sale_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  assert n = 2, 'caso1: esperaba 2 cuotas, hay ' || n;
  assert s = 2000, 'caso1: esperaba $2000, hay ' || s;
  select min(due_date), min(numero) into d1, n1 from st_cuotas where sale_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  assert d1 = '2026-08-05', 'caso1: primera vence ' || d1;
  assert n1 = 2, 'caso1: primera cuota debía ser la nro 2 (la 1 fue el cash), es ' || n1;
end $$;

-- Caso 2: redondeo — $1000, sin cash, 3 pagos -> 333.33 + 333.33 + 333.34
insert into public.st_sales (id, org_id, sale_date, cliente, facturado, cash, cuotas, reserva)
values ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
        '2026-07-05', 'Test Dos', 1000, 0, 3, 0);

do $$
declare n int; s numeric; mx numeric;
begin
  select count(*), sum(monto), max(monto) into n, s, mx from st_cuotas where sale_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  assert n = 3, 'caso2: esperaba 3 cuotas, hay ' || n;
  assert s = 1000, 'caso2: la suma debía ser exacta $1000, es ' || s;
  assert mx = 333.34, 'caso2: la última debía absorber el redondeo (333.34), max es ' || mx;
end $$;

-- Caso 3: pagar una cuota y editar la venta -> la pagada NO se toca
update st_cuotas set status = 'pagada', paid_amount = 1000, paid_date = '2026-08-05'
 where sale_id = 'bbbbbbbb-0000-0000-0000-000000000001' and numero = 2;
update st_sales set facturado = 4000 where id = 'bbbbbbbb-0000-0000-0000-000000000001';

do $$
declare pag int; pend int; s numeric;
begin
  select count(*) filter (where status='pagada'), count(*) filter (where status='pendiente'),
         coalesce(sum(monto) filter (where status='pendiente'),0)
    into pag, pend, s from st_cuotas where sale_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  assert pag = 1, 'caso3: la pagada tenía que sobrevivir';
  -- resto = 4000 - 1000(cash) - 0 - 1000(pagada) = 2000; n = 3 - 1(cierre) - 1(pagada) = 1
  assert pend = 1, 'caso3: esperaba 1 pendiente, hay ' || pend;
  assert s = 2000, 'caso3: la pendiente debía ser $2000, es ' || s;
end $$;

-- Caso 4: sin resto -> cero cuotas
insert into public.st_sales (id, org_id, sale_date, cliente, facturado, cash, cuotas, reserva)
values ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
        '2026-07-05', 'Test Tres', 2000, 2000, 1, 0);

do $$
declare n int;
begin
  select count(*) into n from st_cuotas where sale_id = 'bbbbbbbb-0000-0000-0000-000000000003';
  assert n = 0, 'caso4: pago único no genera cuotas, hay ' || n;
end $$;

-- Caso 5: borrar la venta borra sus cuotas (cascade)
delete from st_sales where id = 'bbbbbbbb-0000-0000-0000-000000000002';
do $$
declare n int;
begin
  select count(*) into n from st_cuotas where sale_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  assert n = 0, 'caso5: cascade no borró las cuotas';
end $$;

select 'TODOS LOS CASOS OK' as resultado;
rollback;
```

```bash
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < /tmp/test_cuotas.sql
```

Expected: `TODOS LOS CASOS OK` y `ROLLBACK` al final. Si un assert falla, psql corta con el mensaje del caso.

- [ ] **Step 4: Verificar que no quedó residuo del test**

```bash
docker exec supabase-db psql -U postgres -d postgres -tc \
  "select count(*) from st_orgs where name='__test_cuotas__';"
```

Expected: `0`.

- [ ] **Step 5: Commit**

```bash
cd /docker/maze-sales-tracker-dev
git add supabase/migrations/009_cuotas_trigger.sql
git commit -m "feat(caja): trigger de generación automática del plan de cuotas"
```

---

### Task 3: Migración 010 — backfill de ventas existentes

**Files:**
- Create: `/docker/maze-sales-tracker-dev/supabase/migrations/010_cuotas_backfill.sql`

**Interfaces:**
- Consumes: `public.st_regen_cuotas(public.st_sales)` (Task 2).

- [ ] **Step 1: Escribir la migración**

Contenido completo de `supabase/migrations/010_cuotas_backfill.sql`:

```sql
-- ============================================================
-- Maze Sales Tracker IA — Backfill de cuotas para ventas existentes
-- Genera el plan SOLO para ventas que aún no tienen ninguna cuota.
-- Idempotente: en la segunda corrida no encuentra candidatas.
-- Las cuotas con fecha pasada quedarán "vencidas" para conciliar.
-- ============================================================

select public.st_regen_cuotas(s)
  from public.st_sales s
 where not exists (select 1 from public.st_cuotas c where c.sale_id = s.id);
```

- [ ] **Step 2: Dry-run — ver qué generaría ANTES de tocar nada**

```bash
docker exec supabase-db psql -U postgres -d postgres -c "
begin;
select public.st_regen_cuotas(s) from public.st_sales s
 where not exists (select 1 from public.st_cuotas c where c.sale_id = s.id);
select o.name as org, count(*) as cuotas, sum(c.monto) as en_la_calle,
       count(*) filter (where c.due_date < current_date) as vencidas
  from public.st_cuotas c join public.st_orgs o on o.id = c.org_id
 group by 1 order by 1;
rollback;"
```

Expected: tabla resumen por org (Clara y las demás). **Sanity check obligatorio antes de seguir:** para cada org, `en_la_calle` tiene que coincidir con `select sum(greatest(facturado - cash - reserva, 0)) from st_sales` de esa org. Si algo no cierra, frenar y revisar los datos de esa venta — no aplicar.

- [ ] **Step 3: Aplicar el backfill de verdad**

```bash
docker exec -i supabase-db psql -U postgres -d postgres < /docker/maze-sales-tracker-dev/supabase/migrations/010_cuotas_backfill.sql
```

Expected: `SELECT <n>` (n = ventas procesadas).

- [ ] **Step 4: Verificar consistencia post-backfill**

```bash
docker exec supabase-db psql -U postgres -d postgres -c "
select 'cuotas' as fuente, coalesce(sum(monto),0) as total from st_cuotas where status='pendiente'
union all
select 'ventas', coalesce(sum(greatest(facturado - cash - reserva, 0)),0) from st_sales;"
```

Expected: los dos totales **iguales**.

- [ ] **Step 5: Commit**

```bash
cd /docker/maze-sales-tracker-dev
git add supabase/migrations/010_cuotas_backfill.sql
git commit -m "feat(caja): backfill idempotente de cuotas para ventas existentes"
```

---

### Task 4: Frontend — datos + navegación + vista Caja (lectura)

**Files:**
- Modify: `/docker/maze-sales-tracker-dev/index.html` (nav ~línea 359, `loadFromSupabase` ~455, dispatcher `render()` ~595, CSS ~215, funciones nuevas antes de `// ---------- util ----------`)

**Interfaces:**
- Consumes: `st_cuotas` vía supabase-js; helpers existentes `range()`, `periodControls()`, `topbar()`, `mini()`, `money()`, `esc()`, `info()`, `adminNotice()`, `footer()`, `todayStr()`, `parseD()`, `dstr()`, `MONTHS`, `IS_ADMIN`, `ME`, `state`, `VIEW`.
- Produces: `DB.cuotas` (array `{id, sale_id, numero, monto, due_date, status, paid_date, paid_amount}`), `DB.sales[i].ghl` (contact id), `renderCaja()`, `moneyFull(n)`, `cuotaEstado(c)`, `GHL_LOC`. Task 5 depende de estos nombres.

- [ ] **Step 1: Cargar cuotas y ghl_contact_id en `loadFromSupabase`**

En `loadFromSupabase()`, agregar la query de cuotas junto a la de sales:

```js
  const sales=(await sb.from('st_sales').select('*').eq('org_id',ME.org_id)).data||[];
  const cuotas=(await sb.from('st_cuotas').select('*').eq('org_id',ME.org_id)).data||[];
```

Y en el objeto `DB=...`, mapear `ghl` en sales y agregar `cuotas`:

```js
      sales:sales.map(s=>({id:s.id,date:s.sale_date,cliente:s.cliente,programa:s.programa,metodo:s.metodo,facturado:+s.facturado,cash:+s.cash,cuotas:s.cuotas,reserva:+s.reserva,closer:s.closer_id,triage:s.triage_id,setter:s.setter_id,fuente:s.fuente,ghl:s.ghl_contact_id})),
      cuotas:cuotas.map(c=>({id:c.id,sale_id:c.sale_id,numero:c.numero,monto:+c.monto,due_date:c.due_date,status:c.status,paid_date:c.paid_date,paid_amount:c.paid_amount==null?null:+c.paid_amount}))};
```

(La clave `cuotas:` reemplaza el cierre `};` de la asignación actual — cuidado con la coma después de `...fuente:s.fuente,ghl:s.ghl_contact_id}))`.)

- [ ] **Step 2: Ícono de navegación**

Después del nav-i de `data-view="sales"` (~línea 359), insertar:

```html
    <div class="nav-i" data-view="caja" title="Caja"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 11h18M16 15.5h2"/><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7"/></svg><span class="tt">Caja</span></div>
```

- [ ] **Step 3: Registrar la vista en el router**

En `render()`, después de `else if(state.view==='sales') renderSales();`:

```js
  else if(state.view==='caja') renderCaja();
```

- [ ] **Step 4: CSS de estados**

En el bloque `<style>`, junto a `.section` (~línea 215), agregar:

```css
  .cuo-est{font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;background:rgba(127,127,127,.14);color:var(--muted);white-space:nowrap}
  .cuo-est.venc{background:rgba(255,77,77,.14);color:#ff6b6b}
  .cuo-est.paga{background:rgba(74,222,128,.14);color:#4ade80}
```

- [ ] **Step 5: Vista Caja + helpers + location GHL**

Insertar antes de `// ---------- util ----------`:

```js
// ---------- Caja (cash del front + cuotas del back) ----------
let GHL_LOC=null, GHL_LOC_ASKED=false;
// El endpoint es solo-admin; para no-admins no hay link (la vista es solo-lectura).
async function loadGhlLocation(){
  if(GHL_LOC_ASKED||!IS_ADMIN) return;
  GHL_LOC_ASKED=true;
  try{
    const {data:{session}}=await sb.auth.getSession(); if(!session) return;
    const r=await fetch('/api/integrations/ghl',{headers:{'Authorization':'Bearer '+session.access_token}});
    if(!r.ok) return;
    const j=await r.json();
    if(j&&j.location_id){ GHL_LOC=j.location_id; if(state.view==='caja') renderCaja(); }
  }catch(e){}
}
function moneyFull(n){ return '$'+(+n||0).toLocaleString('es'); }
function cuotaEstado(c){ if(c.status==='pagada') return 'pagada'; return c.due_date<todayStr()?'vencida':'pendiente'; }
function renderCaja(){
  const cuotas=DB.cuotas||[];
  const r=range(state.ptype, parseD(state.ref));
  const inR=(d)=>d>=r.start&&d<=r.end;
  const front=DB.sales.filter(s=>inR(s.date)).reduce((a,s)=>a+(+s.cash||0)+(+s.reserva||0),0);
  const back=cuotas.filter(c=>c.status==='pagada'&&c.paid_date&&inR(c.paid_date)).reduce((a,c)=>a+(+c.paid_amount||0),0);
  const calle=cuotas.filter(c=>c.status!=='pagada').reduce((a,c)=>a+(+c.monto||0),0);
  const today=parseD(todayStr());
  let proj='';
  for(let k=0;k<3;k++){
    const m0=new Date(today.getFullYear(),today.getMonth()+k,1), m1=new Date(today.getFullYear(),today.getMonth()+k+1,0);
    const a=dstr(m0), b=dstr(m1);
    const tot=cuotas.filter(c=>c.status!=='pagada'&&c.due_date>=a&&c.due_date<=b).reduce((x,c)=>x+(+c.monto||0),0);
    proj+=mini(MONTHS[m0.getMonth()]+' '+m0.getFullYear(), moneyFull(tot));
  }
  const saleOf=(id)=>DB.sales.find(s=>s.id===id)||{};
  const q=(state.cajaQ||'').toLowerCase(), f=state.cajaF||'abiertas';
  let list=cuotas.map(c=>({...c,est:cuotaEstado(c),sale:saleOf(c.sale_id)}));
  if(f==='abiertas') list=list.filter(c=>c.est!=='pagada');
  else if(f!=='todas') list=list.filter(c=>c.est===f);
  if(q) list=list.filter(c=>String(c.sale.cliente||'').toLowerCase().includes(q));
  list.sort((a,b)=>a.due_date<b.due_date?-1:1);
  const EST={pendiente:'<span class="cuo-est">Pendiente</span>',vencida:'<span class="cuo-est venc">Vencida</span>',pagada:'<span class="cuo-est paga">Pagada</span>'};
  let rows='';
  list.forEach(c=>{
    const s=c.sale;
    const ghlBtn=(s.ghl&&GHL_LOC)
      ?`<a class="btn ghost sm" href="https://app.mazefunnels.com/v2/location/${esc(GHL_LOC)}/contacts/detail/${esc(s.ghl)}" target="_blank" rel="noopener" title="Abrir contacto en GHL">💬</a>`
      :(s.ghl?'':`<span style="color:var(--muted);font-size:11px">sin contacto GHL</span>`);
    const acts=(IS_ADMIN&&c.status!=='pagada')
      ?`<button class="btn sm" onclick="openCobrarModal('${c.id}')">Cobrar</button> <button class="btn ghost sm" onclick="openEditCuotaModal('${c.id}')" title="Editar monto o fecha">✎</button>`
      :(c.status==='pagada'?`<span style="color:var(--muted);font-size:11px">${c.paid_date||''}</span>`:'');
    rows+=`<tr><td style="text-align:left">${esc(s.cliente||'—')}</td><td style="text-align:left">${esc(s.programa||'—')}</td><td>${c.numero}/${Math.max(+s.cuotas||0,c.numero)}</td><td>${moneyFull(c.status==='pagada'?c.paid_amount:c.monto)}</td><td>${c.due_date}</td><td>${EST[c.est]}</td><td>${ghlBtn}</td><td>${acts}</td></tr>`;
  });
  if(!rows) rows=`<tr><td colspan="8" class="empty">No hay cuotas en este filtro.</td></tr>`;
  const FL={abiertas:'Abiertas',pendiente:'Pendientes',vencida:'Vencidas',pagada:'Pagadas',todas:'Todas'};
  const filtros=Object.keys(FL).map(x=>`<button class="chip" style="${f===x?'border-color:var(--accent,#C5FF49);color:var(--accent,#C5FF49)':''}" onclick="setCajaF('${x}')">${FL[x]}</button>`).join('');
  VIEW.innerHTML = topbar(periodControls()) + `<div class="eyebrow">Caja</div><h2 class="view">Cash del front, cuotas del back</h2>
    ${adminNotice()}
    <div class="cards-mini section">
      ${mini('Caja front '+info('Cash collected + reservas de las ventas del período (por fecha de venta).'),moneyFull(front))}
      ${mini('Caja back '+info('Cuotas cobradas en el período (por fecha real de cobro).'),moneyFull(back))}
      ${mini('Total período',moneyFull(front+back))}
      ${mini('En la calle '+info('Todo lo pendiente de cobro, de todos los tiempos: cuotas pendientes + vencidas.'),moneyFull(calle))}
    </div>
    <div class="section"><div class="eyebrow">Proyección de cobros ${info('Lo que debería entrar según las cuotas agendadas, mes por mes.')}</div>
      <div class="cards-mini">${proj}</div></div>
    <div class="section"><div class="eyebrow">Cuotas</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
        ${filtros}
        <input class="inp" style="max-width:220px;margin-left:auto" placeholder="Buscar cliente…" value="${esc(state.cajaQ||'')}" oninput="setCajaQ(this.value)">
      </div>
      <div class="rollup"><table>
        <thead><tr><th style="text-align:left">Cliente</th><th style="text-align:left">Programa</th><th>Cuota</th><th>Monto</th><th>Vence</th><th>Estado</th><th>GHL</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>` + footer();
  loadGhlLocation();
}
window.setCajaF=(x)=>{ state.cajaF=x; renderCaja(); };
let _cq; window.setCajaQ=(v)=>{ state.cajaQ=v; clearTimeout(_cq); _cq=setTimeout(renderCaja,250); };
```

Nota: `openCobrarModal`/`openEditCuotaModal` se definen en Task 5; hasta entonces los botones existen pero no responden — verificar la vista en modo lectura primero.

- [ ] **Step 6: Verificar en el navegador (dev)**

Abrir `https://sales-tracker-test.mazefunnels.io` logueado como admin de la org de prueba:
1. Aparece el ícono "Caja" en el nav → la vista carga sin errores de consola
2. Los 4 mini-cards muestran montos coherentes con las ventas existentes
3. La proyección muestra 3 meses
4. La tabla lista las cuotas del backfill, vencidas en rojo, orden por vencimiento
5. Filtros y buscador funcionan; el selector de período cambia front/back
6. Con la integración GHL conectada, el botón 💬 abre `app.mazefunnels.com/v2/location/{loc}/contacts/detail/{id}`
7. Logueado como miembro no-admin: la vista se ve, sin botones Cobrar/✎, con el aviso 🔒

- [ ] **Step 7: Commit**

```bash
cd /docker/maze-sales-tracker-dev
git add index.html
git commit -m "feat(caja): vista Caja — front/back por período, en la calle, proyección y tabla de cuotas"
```

---

### Task 5: Frontend — acciones Cobrar y Editar (modales, solo admin)

**Files:**
- Modify: `/docker/maze-sales-tracker-dev/index.html` (después del bloque de Task 5 de `renderCaja`, patrón de modal = `openPasswordModal` línea ~1292)

**Interfaces:**
- Consumes: `DB.cuotas`, `DB.sales`, `moneyFull()`, `todayStr()`, `save()`, `toast()`, `renderCaja()`, clase CSS `drill-overlay`/`drill`/`drill-x`/`drill-head`/`drill-def`.
- Produces: `window.openCobrarModal(id)`, `window.openEditCuotaModal(id)`, `window.closeCuotaModal()` (los usa Task 4).

- [ ] **Step 1: Escribir los modales y sus submits**

Insertar inmediatamente después de `window.setCajaQ=...`:

```js
window.closeCuotaModal=()=>{ const ov=document.getElementById('cuoOv'); if(ov) ov.style.display='none'; };
function cuotaOverlay(){
  let ov=document.getElementById('cuoOv');
  if(!ov){
    ov=document.createElement('div'); ov.id='cuoOv'; ov.className='drill-overlay';
    ov.addEventListener('click',e=>{ if(e.target===ov) closeCuotaModal(); });
    document.body.appendChild(ov);
  }
  return ov;
}
window.openCobrarModal=(id)=>{
  const c=(DB.cuotas||[]).find(x=>x.id===id); if(!c) return;
  const s=DB.sales.find(x=>x.id===c.sale_id)||{};
  const ov=cuotaOverlay();
  ov.innerHTML=`<div class="drill" style="max-width:380px">
    <button class="drill-x" onclick="closeCuotaModal()">✕</button>
    <div class="drill-head"><div><div class="eyebrow">Cobrar cuota</div><h3>${esc(s.cliente||'—')} · cuota ${c.numero}</h3></div></div>
    <p class="drill-def">Agendada: ${moneyFull(c.monto)} · vence ${c.due_date}. Si entró un monto distinto, corregilo acá: la caja registra lo que entró de verdad.</p>
    <form onsubmit="return submitCobro(event,'${c.id}')">
      <div class="field"><label>Monto que entró ($)</label><input class="inp" id="cu_amount" type="number" step="0.01" min="0.01" value="${+c.monto}" required></div>
      <div class="field" style="margin:10px 0 16px"><label>Fecha del cobro</label><input class="inp" id="cu_date" type="date" value="${todayStr()}" required></div>
      <div style="display:flex;gap:9px;justify-content:flex-end">
        <button class="btn ghost sm" type="button" onclick="closeCuotaModal()">Cancelar</button>
        <button class="btn sm" type="submit" id="cu_btn">Registrar cobro</button>
      </div>
    </form></div>`;
  ov.style.display='flex';
  document.getElementById('cu_amount').focus();
};
window.submitCobro=async(ev,id)=>{
  ev.preventDefault();
  const amount=+document.getElementById('cu_amount').value||0;
  const date=document.getElementById('cu_date').value;
  if(amount<=0||!date){ toast('Monto y fecha son obligatorios'); return false; }
  const btn=document.getElementById('cu_btn'); if(btn){ btn.disabled=true; btn.textContent='Guardando…'; }
  const {error}=await sb.from('st_cuotas').update({status:'pagada',paid_amount:amount,paid_date:date}).eq('id',id);
  if(error){ toast('No se pudo (permiso)'); if(btn){ btn.disabled=false; btn.textContent='Registrar cobro'; } return false; }
  const c=(DB.cuotas||[]).find(x=>x.id===id); if(c){ c.status='pagada'; c.paid_amount=amount; c.paid_date=date; }
  save(); closeCuotaModal(); toast('Cobro registrado 💰'); renderCaja();
  return false;
};
window.openEditCuotaModal=(id)=>{
  const c=(DB.cuotas||[]).find(x=>x.id===id); if(!c) return;
  const s=DB.sales.find(x=>x.id===c.sale_id)||{};
  const ov=cuotaOverlay();
  ov.innerHTML=`<div class="drill" style="max-width:380px">
    <button class="drill-x" onclick="closeCuotaModal()">✕</button>
    <div class="drill-head"><div><div class="eyebrow">Editar cuota</div><h3>${esc(s.cliente||'—')} · cuota ${c.numero}</h3></div></div>
    <p class="drill-def">Ajustá el acuerdo real con el cliente: monto o fecha de vencimiento.</p>
    <form onsubmit="return submitEditCuota(event,'${c.id}')">
      <div class="field"><label>Monto ($)</label><input class="inp" id="ce_amount" type="number" step="0.01" min="0.01" value="${+c.monto}" required></div>
      <div class="field" style="margin:10px 0 16px"><label>Vence</label><input class="inp" id="ce_date" type="date" value="${c.due_date}" required></div>
      <div style="display:flex;gap:9px;justify-content:flex-end">
        <button class="btn ghost sm" type="button" onclick="closeCuotaModal()">Cancelar</button>
        <button class="btn sm" type="submit" id="ce_btn">Guardar</button>
      </div>
    </form></div>`;
  ov.style.display='flex';
};
window.submitEditCuota=async(ev,id)=>{
  ev.preventDefault();
  const monto=+document.getElementById('ce_amount').value||0;
  const due=document.getElementById('ce_date').value;
  if(monto<=0||!due){ toast('Monto y fecha son obligatorios'); return false; }
  const btn=document.getElementById('ce_btn'); if(btn){ btn.disabled=true; btn.textContent='Guardando…'; }
  const {error}=await sb.from('st_cuotas').update({monto,due_date:due}).eq('id',id);
  if(error){ toast('No se pudo (permiso)'); if(btn){ btn.disabled=false; btn.textContent='Guardar'; } return false; }
  const c=(DB.cuotas||[]).find(x=>x.id===id); if(c){ c.monto=monto; c.due_date=due; }
  save(); closeCuotaModal(); toast('Cuota actualizada'); renderCaja();
  return false;
};
```

- [ ] **Step 2: Verificar en el navegador (dev, como admin)**

1. "Cobrar" abre el modal con el monto agendado y hoy como fecha → confirmar → la fila pasa a Pagada, la caja back del período sube por `paid_amount`, "En la calle" baja
2. Cobrar con un monto distinto al agendado → la caja back refleja el monto real
3. "✎" edita monto/fecha → la tabla y la proyección se actualizan
4. Recargar la página → los cambios persisten (vienen de Supabase)
5. Como no-admin: `sb.from('st_cuotas').update(...)` desde consola devuelve error de RLS (0 filas afectadas)

- [ ] **Step 3: Commit**

```bash
cd /docker/maze-sales-tracker-dev
git add index.html
git commit -m "feat(caja): cobrar y editar cuotas (modales solo-admin)"
```

---

### Task 6: QA integral en dev

**Files:** ninguno (verificación).

- [ ] **Step 1: Flujo completo con venta nueva**

En `sales-tracker-test.mazefunnels.io`, org de prueba, como admin:
1. Registrar venta: facturado 3000, cash 1000, cantidad de pagos 3, sin reserva
2. Ir a Caja → aparecen 2 cuotas de $1.000 (números 2/3 y 3/3), vencen mes +1 y +2
3. Cobrar la primera → back sube $1.000, en la calle queda $1.000
4. Editar la venta NO aplica (no hay edición de ventas en la UI) — en su lugar: borrar la venta de prueba desde Ventas → sus cuotas desaparecen de Caja (cascade)

- [ ] **Step 2: Venta con reserva**

1. Registrar venta: facturado 2000, cash 0, reserva sí $500, cantidad de pagos 2
2. Caja → 2 cuotas de $750 (resto 1500; sin cash no se descuenta pago al cierre)
3. Borrar la venta de prueba

- [ ] **Step 3: Chequeo de consola y móvil**

1. Consola del navegador sin errores en toda la sesión
2. Vista Caja usable en viewport móvil (Chrome DevTools, 390px): cards apilan, tabla scrollea horizontal dentro de `.rollup`

- [ ] **Step 4: Verificación cruzada de datos**

```bash
docker exec supabase-db psql -U postgres -d postgres -c "
select 'cuotas' as fuente, coalesce(sum(monto),0) as total from st_cuotas where status='pendiente'
union all
select 'ventas', coalesce(sum(greatest(facturado - cash - reserva, 0)),0)
  from st_sales s where not exists
    (select 1 from st_cuotas c where c.sale_id=s.id and c.status='pagada');"
```

Expected: totales iguales (las ventas con cuotas ya pagadas se excluyen de la comparación simple).

---

### Task 7: Deploy a producción (multi-tenant + Clara)

**Files:** ninguno nuevo (git + docker en el VPS). Las migraciones ya corrieron en la base compartida (Tasks 1–3): este task solo publica el frontend.

- [ ] **Step 1: Push de develop**

```bash
cd /docker/maze-sales-tracker-dev
git push origin develop
```

- [ ] **Step 2: Deploy al tracker de Clara (sigue develop)**

```bash
cd /docker/clara-sales-tracker && git pull origin develop
```

El `index.html` está bind-mounteado: el cambio queda vivo al instante. Verificar `tracker.caminodigitalllc.com` → vista Caja visible con las cuotas del backfill de la org de Clara.

- [ ] **Step 3: PR develop → main y deploy del prod multi-tenant**

```bash
cd /docker/maze-sales-tracker-dev
gh pr create --base main --head develop --title "Caja: tracker de cuotas por cobrar (front/back)" --body "Tabla st_cuotas + trigger + backfill + vista Caja. Spec: docs/superpowers/specs/2026-07-05-cuotas-caja-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
# tras aprobar/mergear el PR:
cd /docker/maze-sales-tracker && git pull origin main
```

Verificar el dominio del prod multi-tenant → vista Caja visible.

- [ ] **Step 4: Avisar a Clara**

Alejandro le avisa a Clara (o se manda por el canal habitual de soporte en Slack) que:
- Hay sección nueva "Caja" con sus cuotas por cobrar
- Le van a aparecer cuotas **vencidas** de ventas viejas: tiene que conciliarlas (marcar cobradas las que ya entraron)

- [ ] **Step 5: Actualizar STATE.md del proyecto**

Registrar en `.planning/STATE.md` (Quick Tasks Completed / Last activity) que se completó la feature Caja + cuotas, con fecha.

```bash
cd /docker/maze-sales-tracker-dev
git add .planning/STATE.md && git commit -m "chore(gsd): registrar feature Caja/cuotas completada"
git push origin develop
```
