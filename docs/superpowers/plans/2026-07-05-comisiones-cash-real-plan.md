# Comisiones sobre cash real — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toggle por org para que la comisión del closer se calcule sobre lo cobrado de verdad (front de sus ventas + cuotas cobradas) en vez del contador manual.

**Architecture:** Columna `commission_base` en `st_orgs` ('contador' default | 'cobrado'). El frontend calcula front+back por closer desde `DB.sales`/`DB.cuotas` ya cargados; switch solo-admin en Configuraciones; bloque de desglose en la vista Caja.

**Tech Stack:** Postgres (contenedor `supabase-db`), vanilla JS en `index.html`.

**Spec:** `docs/superpowers/specs/2026-07-05-comisiones-cash-real-design.md`

## Global Constraints

- Trabajo en el VPS, repo `/docker/maze-sales-tracker-dev`, rama `develop`. Antes de editar `index.html`: `git status` limpio (coordinar con otras sesiones).
- Base compartida dev/prod/Clara: migraciones idempotentes, default `'contador'` = comportamiento actual intacto para todos.
- Sintaxis JS: validar con extracción de `<script>` + `node --check` antes de subir.
- Copy en castellano latino. Sin dependencias nuevas.
- Deploy dev: el bind-mount de `index.html` es por inode → tras subir el archivo, verificar con `curl`; si el contenedor sirve viejo, `docker compose -f docker-compose.dev.yml up -d --force-recreate maze-sales-tracker-dev`.

---

### Task 1: Migración 011 — `commission_base` en st_orgs

**Files:**
- Create: `/docker/maze-sales-tracker-dev/supabase/migrations/011_commission_base.sql`

**Interfaces:**
- Produces: columna `public.st_orgs.commission_base text` con valores `'contador'|'cobrado'`, default `'contador'`. Task 2 la mapea a `DB.team.commission_base`.

- [ ] **Step 1: Escribir la migración**

```sql
-- ============================================================
-- Maze Sales Tracker IA — Base de cálculo de comisiones por org
-- 'contador' (default, comportamiento histórico: % sobre el contador
-- manual de cash) | 'cobrado' (% sobre front + cuotas cobradas).
-- Idempotente.
-- ============================================================

alter table public.st_orgs add column if not exists commission_base text not null default 'contador';

do $$ begin
  alter table public.st_orgs add constraint st_orgs_commission_base_chk
    check (commission_base in ('contador','cobrado'));
exception when duplicate_object then null; end $$;
```

- [ ] **Step 2: Aplicar y verificar**

```bash
docker exec -i supabase-db psql -U postgres -d postgres < /docker/maze-sales-tracker-dev/supabase/migrations/011_commission_base.sql
docker exec supabase-db psql -U postgres -d postgres -tc "select commission_base from st_orgs limit 3;"
```

Expected: `ALTER TABLE`, `DO`; el select devuelve `contador` para las orgs existentes.

- [ ] **Step 3: Commit**

```bash
cd /docker/maze-sales-tracker-dev
git add supabase/migrations/011_commission_base.sql
git commit -m "feat(comisiones): columna commission_base por org (contador|cobrado)"
```

---

### Task 2: Frontend — carga, cálculo y switch en Configuraciones

**Files:**
- Modify: `/docker/maze-sales-tracker-dev/index.html` — `loadFromSupabase` (~460), `pushToSupabase` (~449), `closerPayout` (~1040), drill-down comisión (~838), card Agencia en `renderTeam` (~1943)

**Interfaces:**
- Consumes: `DB.sales` (con `closer`, `date`, `cash`, `reserva`), `DB.cuotas` (con `sale_id`, `status`, `paid_date`, `paid_amount`), `range()`, `money()`.
- Produces: `DB.team.commission_base` ('contador'|'cobrado'), `closerPayoutBase(memberId, start, end)` → `{front, back, base}`, `window.setCommissionBase(v)`. Task 3 usa `closerPayoutBase`.

- [ ] **Step 1: Mapear y persistir `commission_base`**

En `loadFromSupabase`, en el objeto `team`:

```js
  DB={team:{id:org.id,name:org.name,mode:org.team_mode,tz:org.tz,commission_base:org.commission_base||'contador'},
```

En `pushToSupabase`, el update de st_orgs:

```js
    await sb.from('st_orgs').update({name:DB.team.name,team_mode:DB.team.mode,tz:DB.team.tz,commission_base:DB.team.commission_base||'contador'}).eq('id',DB.team.id);
```

- [ ] **Step 2: Cálculo `closerPayoutBase` + `closerPayout` según modo**

Reemplazar la función `closerPayout` existente por:

```js
// Base "cobrado": front = cash+reserva de SUS ventas del rango (por fecha de venta);
// back = cuotas de sus ventas COBRADAS en el rango (por fecha real de cobro, monto real).
function closerPayoutBase(memberId, start, end){
  const front=DB.sales.filter(s=>s.closer===memberId && s.date>=start && s.date<=end)
    .reduce((a,s)=>a+(+s.cash||0)+(+s.reserva||0),0);
  const mySales=new Set(DB.sales.filter(s=>s.closer===memberId).map(s=>s.id));
  const back=(DB.cuotas||[]).filter(c=>c.status==='pagada' && c.paid_date && c.paid_date>=start && c.paid_date<=end && mySales.has(c.sale_id))
    .reduce((a,c)=>a+(+c.paid_amount||0),0);
  return {front, back, base:front+back};
}
function closerPayout(m){
  const r=range('month', parseD(todayStr()));
  if((DB.team.commission_base||'contador')==='cobrado'){
    return Math.round((m.commission||0)/100 * closerPayoutBase(m.id, r.start, r.end).base);
  }
  const s=sumMember(m.id, r.start, r.end);
  return Math.round((m.commission||0)/100 * (s.cash_nuevo||0));
}
```

- [ ] **Step 3: Switch en la card Agencia (solo admin)**

En `renderTeam`, dentro del `grid2` de la card Agencia, después del field de Zona horaria:

```js
        <div class="field"><label>Base de comisiones ${info('Contador: % sobre el cash que carga el closer en Cargar día. Cobrado: % sobre lo que entró de verdad — cash y reservas de sus ventas más cuotas cobradas (por fecha de cobro).')}</label>
          <select class="inp" onchange="setCommissionBase(this.value)" ${ro?'disabled':''}>
            <option value="contador" ${ (DB.team.commission_base||'contador')==='contador'?'selected':''}>Contador manual (como siempre)</option>
            <option value="cobrado" ${ (DB.team.commission_base||'contador')==='cobrado'?'selected':''}>Sobre lo cobrado (ventas + cuotas)</option>
          </select></div>
```

Y junto a los otros handlers de Configuraciones (`setTz`, etc.):

```js
window.setCommissionBase=(v)=>{ if(!IS_ADMIN) return; DB.team.commission_base=(v==='cobrado')?'cobrado':'contador'; save(); toast('Base de comisiones guardada'); renderTeam(); };
```

- [ ] **Step 4: Drill-down de comisión respeta el modo**

Reemplazar el bloque del drill-down (~838) que arma "A cobrar (comisión N%)":

```js
  if(spec.memberId){ const m=DB.members.find(x=>x.id===spec.memberId); if(m && m.role==='closer' && m.commission){
    let baseVal, baseHtml;
    if((DB.team.commission_base||'contador')==='cobrado'){
      const b=closerPayoutBase(m.id,P.start,P.end); baseVal=b.base;
      baseHtml=`<span class="ftok"><b>${money(b.front)}</b>front</span><span class="fop">+</span><span class="ftok"><b>${money(b.back)}</b>back</span>`;
    } else {
      const s=sumMember(m.id,P.start,P.end); baseVal=s.cash_nuevo||0;
      baseHtml=`<span class="ftok"><b>${money(baseVal)}</b>cash</span>`;
    }
    const pay=Math.round(m.commission/100*baseVal);
    body+=`<div class="dsec"><div class="dh">A cobrar (comisión ${m.commission}%)</div><div class="formula">${baseHtml}<span class="fop">×</span><span class="ftok"><b>${m.commission}%</b></span><span class="fop">=</span><span class="ftok tot"><b>${money(pay)}</b></span></div></div>`;
  } }
```

- [ ] **Step 5: Validar sintaxis, subir, commit**

```bash
# local: extraer <script> y node --check; luego
scp index.html root@187.77.228.99:/docker/maze-sales-tracker-dev/index.html
ssh root@187.77.228.99 "cd /docker/maze-sales-tracker-dev && git add index.html && git commit -m 'feat(comisiones): toggle por org y cálculo sobre lo cobrado (front+back)'"
```

- [ ] **Step 6: Verificar en dev (navegador, como admin)**

1. Configuraciones muestra "Base de comisiones"; cambiarla a "Sobre lo cobrado" → toast + "A cobrar este mes" recalcula
2. Volver a "Contador manual" → vuelve el número anterior
3. Como no-admin el select está disabled

---

### Task 3: Bloque "Comisiones del período" en la vista Caja

**Files:**
- Modify: `/docker/maze-sales-tracker-dev/index.html` — `renderCaja()` (después del bloque Proyección)

**Interfaces:**
- Consumes: `closerPayoutBase(memberId, start, end)` (Task 2), `membersByRole('closer')`, `moneyFull()`, rango `r` ya calculado en `renderCaja`.

- [ ] **Step 1: Insertar el bloque en `renderCaja`**

Después del `</div></div>` del bloque Proyección y antes del bloque Cuotas, dentro del template:

```js
    ${comisionesBlock(r)}
```

Y la función (junto a los helpers de Caja):

```js
// Solo con la base 'cobrado': desglose por closer del período visible.
function comisionesBlock(r){
  if((DB.team.commission_base||'contador')!=='cobrado') return '';
  const closers=membersByRole('closer').filter(m=>(+m.commission||0)>0);
  if(!closers.length) return '';
  let rows='';
  closers.forEach(m=>{
    const b=closerPayoutBase(m.id, r.start, r.end);
    rows+=`<tr><td style="text-align:left">${esc(m.name)}</td><td>${moneyFull(b.front)}</td><td>${moneyFull(b.back)}</td><td>${m.commission}%</td><td><b>${moneyFull(Math.round(m.commission/100*b.base))}</b></td></tr>`;
  });
  return `<div class="section"><div class="eyebrow">Comisiones del período ${info('Base "cobrado": front (cash+reservas de sus ventas) + back (cuotas cobradas, por fecha de cobro) × su % de comisión.')}</div>
    <div class="rollup"><table>
      <thead><tr><th style="text-align:left">Closer</th><th>Front</th><th>Back</th><th>%</th><th>A cobrar</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
}
```

- [ ] **Step 2: Validar sintaxis, subir, commit**

```bash
# node --check como en Task 2; scp; luego
ssh root@187.77.228.99 "cd /docker/maze-sales-tracker-dev && git add index.html && git commit -m 'feat(comisiones): bloque Comisiones del período en la vista Caja'"
```

- [ ] **Step 3: QA e2e en dev (navegador)**

1. Con toggle "cobrado" y un closer con % > 0: el bloque aparece en Caja con front/back/total del período seleccionado
2. Registrar venta de prueba con closer y cuotas → cobrar una cuota → el back del closer sube en el período del cobro
3. Cambiar el selector de período → el bloque recalcula
4. Toggle "contador" → el bloque desaparece
5. Borrar la venta de prueba; consola sin errores de la app
