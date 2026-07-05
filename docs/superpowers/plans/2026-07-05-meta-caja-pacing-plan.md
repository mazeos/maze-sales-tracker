# Meta de caja mensual con pacing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El admin fija una meta mensual de plata cobrada (front+back) en Metas y la vista Caja muestra progreso + pacing.

**Architecture:** Cero migraciones — fila `period='month'` en `st_goals` (unique org+period y RLS ya existen). Frontend: carga/persistencia de `DB.goals.month`, card en Metas, bloque de pacing en Caja siempre sobre el mes calendario en curso.

**Tech Stack:** vanilla JS en `index.html`, Supabase (PostgREST) existente.

**Spec:** `docs/superpowers/specs/2026-07-05-meta-caja-pacing-design.md`

## Global Constraints

- Repo `/docker/maze-sales-tracker-dev`, rama `develop`, `git status` limpio antes de editar `index.html`.
- Validar JS con extracción de `<script>` + `node --check` antes de subir.
- Copy castellano latino; TZ de la org vía `todayStr()`; contraste como el resto (tokens existentes).
- Sin meta fijada (0/vacía) → el bloque de Caja NO aparece.

---

### Task 1: Datos + card "Meta de caja del mes" en Metas

**Files:**
- Modify: `/docker/maze-sales-tracker-dev/index.html` — `loadFromSupabase` (~461), `pushToSupabase` (~454), `renderGoals` (~2050), handler junto a `setGoal`

**Interfaces:**
- Produces: `DB.goals.month` (objeto `{caja: N}`), `window.setGoalMonth(k,v)`. Task 2 lee `DB.goals.month.caja`.

- [ ] **Step 1: Cargar ambas filas de metas**

Reemplazar en `loadFromSupabase`:

```js
  const goalRows=(await sb.from('st_goals').select('*').eq('org_id',ME.org_id).in('period',['week','month'])).data||[];
```

Y en el objeto `DB`:

```js
      entries:{}, goals:{week:((goalRows.find(g=>g.period==='week')||{}).goals)||{}, month:((goalRows.find(g=>g.period==='month')||{}).goals)||{}},
```

- [ ] **Step 2: Persistir la fila month**

En `pushToSupabase`, después del upsert de `week`:

```js
    await sb.from('st_goals').upsert({org_id:DB.team.id,period:'month',goals:DB.goals.month||{}},{onConflict:'org_id,period'});
```

- [ ] **Step 3: Card en Metas + handler**

En `renderGoals`, después del `</div>` de `.cap-wrap`, dentro del template:

```js
    <div class="cap-wrap" style="margin-top:18px">
      <div class="eyebrow" style="margin-bottom:10px">Meta de caja del mes ${info('Plata cobrada total del mes: cash y reservas de ventas nuevas + cuotas cobradas. El progreso y el ritmo se ven en la vista Caja.')}</div>
      <div class="grid2">
        <div class="field"><label>Caja del mes ($)</label><input class="inp" type="number" min="0" value="${gm.caja||''}" onchange="setGoalMonth('caja',this.value)" ${ro?'disabled':''}></div>
      </div>
    </div>
```

Con `const gm=DB.goals.month||{};` al inicio de `renderGoals`, y junto a `setGoal`:

```js
window.setGoalMonth=(k,v)=>{ if(!IS_ADMIN) return; if(!DB.goals.month) DB.goals.month={}; const n=+v||0; if(n) DB.goals.month[k]=n; else delete DB.goals.month[k]; save(); toast('Meta guardada'); };
```

- [ ] **Step 4: Validar sintaxis, subir, commit**

```bash
# node --check; scp; luego
ssh root@187.77.228.99 "cd /docker/maze-sales-tracker-dev && git add index.html && git commit -m 'feat(meta-caja): meta mensual de caja en Metas (st_goals period=month)'"
```

---

### Task 2: Bloque de pacing en la vista Caja

**Files:**
- Modify: `/docker/maze-sales-tracker-dev/index.html` — `renderCaja()` (bloque nuevo arriba de los mini-cards) + helper junto a `comisionesBlock`

**Interfaces:**
- Consumes: `DB.goals.month.caja` (Task 1), `DB.sales`, `DB.cuotas`, `range()`, `todayStr()`, `parseD()`, `MONTHS`, `moneyFull()`, clases `cuo-est`/`paga`/`venc`.

- [ ] **Step 1: Helper `metaCajaBlock()` + inserción**

Helper (junto a `comisionesBlock`):

```js
// Pacing de la meta de caja: SIEMPRE sobre el mes calendario en curso,
// sin importar el selector de período de la vista (la meta es mensual).
function metaCajaBlock(){
  const meta=+((DB.goals.month||{}).caja)||0;
  if(!meta) return '';
  const rm=range('month', parseD(todayStr()));
  const inM=(d)=>d>=rm.start&&d<=rm.end;
  const front=DB.sales.filter(s=>inM(s.date)).reduce((a,s)=>a+(+s.cash||0)+(+s.reserva||0),0);
  const back=(DB.cuotas||[]).filter(c=>c.status==='pagada'&&c.paid_date&&inM(c.paid_date)).reduce((a,c)=>a+(+c.paid_amount||0),0);
  const cobrado=front+back;
  const today=parseD(todayStr());
  const diasMes=new Date(today.getFullYear(),today.getMonth()+1,0).getDate();
  const rest=diasMes-today.getDate();
  const pctReal=cobrado/meta*100;
  const pct=Math.min(100,Math.round(pctReal));
  const pctMes=today.getDate()/diasMes*100;
  const done=cobrado>=meta;
  const chip=done?`<span class="cuo-est paga">Meta cumplida 🎉</span>`:(pctReal>=pctMes?`<span class="cuo-est paga">Adelantado</span>`:`<span class="cuo-est venc">Atrasado</span>`);
  const ritmo=done?'':` · necesitás ${moneyFull(Math.ceil((meta-cobrado)/Math.max(rest,1)))}/día`;
  return `<div class="section"><div class="eyebrow">Meta de caja · ${MONTHS[today.getMonth()]} ${today.getFullYear()} ${info('Cobrado del mes (front + back) contra la meta fijada en Metas. Adelantado/Atrasado compara tu % cobrado con el % del mes ya transcurrido.')}</div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
      <b style="font-size:18px">${moneyFull(cobrado)}</b><span style="color:var(--muted)">de ${moneyFull(meta)} · ${pct}%${done?'':` · quedan ${rest} días`}${ritmo}</span>${chip}
    </div>
    <div style="height:10px;border-radius:20px;background:rgba(127,127,127,.18);overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent,#C5FF49)"></div></div>
  </div>`;
}
```

Inserción en `renderCaja`, entre `${adminNotice()}` y el `<div class="cards-mini section">`:

```js
    ${metaCajaBlock()}
```

- [ ] **Step 2: Validar sintaxis, subir, commit**

```bash
ssh root@187.77.228.99 "cd /docker/maze-sales-tracker-dev && git add index.html && git commit -m 'feat(meta-caja): barra de pacing del mes en la vista Caja'"
```

- [ ] **Step 3: QA e2e en dev (navegador)**

1. Metas: fijar "Caja del mes ($)" = 10000 → toast; recargar página → persiste
2. Caja: aparece el bloque con cobrado del mes / 10000, %, días restantes, ritmo $/día y chip Adelantado/Atrasado (validar el número contra cálculo a mano)
3. Cobrar una cuota → el progreso sube
4. Borrar la meta (vaciar el input) → el bloque desaparece de Caja
5. Como no-admin: input disabled; consola sin errores de la app
