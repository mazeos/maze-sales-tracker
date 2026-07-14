# Desglose de contactos en la Vista Tabla + tooltips — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Desde la Vista Tabla, poder clickear una celda y ver qué contactos de HighLevel componen ese número (con link a su ficha), y que cada métrica explique en su tooltip cómo se mide exactamente.

**Architecture:** `computeMemberKpis` (`api/metrics.js`) ya devuelve `{values, contacts}` con el `contactId` real de GHL, pero `captureGhl` (`api/server.js`) descarta `contacts`. Se unifica el camino del closer con el motor, se persisten los contactos en `st_shadow_metrics` (columna `contacts`, migración 017, clave `member_id+metric_date+kpi`), y la Vista Tabla los lee por RLS y los muestra al clickear un punto en la celda.

**Tech Stack:** Node sin deps (`api/server.js`, `api/metrics.js`), `index.html` vanilla JS. Sin suite de tests automatizados: la verificación es `node --check`, chequeo de sintaxis del `<script>`, y curl contra dev con datos reales.

**Spec:** `docs/superpowers/specs/2026-07-14-desglose-contactos-y-tooltips-design.md`

## Global Constraints

- **Base Supabase compartida** por todos los tenants (Clara corre en prod). Deploy SOLO a `sales-tracker-test.mazefunnels.io` (`/docker/maze-sales-tracker-dev`, `docker compose -f docker-compose.dev.yml`). **NO promover a main/prod.** El `api` se buildea: `--build --force-recreate`.
- **`st_shadow_metrics` es solo-service-role-escribe** (migración 012). El backend la escribe con service key; el frontend solo la LEE por RLS.
- **El upsert NUNCA pisa `manual_value`.** Esa columna la escribe el worker nocturno y es la base del cálculo de match de la calibración. Solo se tocan `auto_value`, `contacts`, `computed_at`.
- **No-regresión del closer (bloqueante):** tras unificar con el motor, `llamadas`, `asistencias` y `no_shows` deben dar **exactamente los mismos números** que antes para el mismo día y closer.
- **No se toca la edición de la celda:** el `<input type="number">` sigue editable con un clic y `tblEdit` sigue guardando igual. El punto es un elemento aparte.
- Sin dependencias nuevas. Idioma de la UI: castellano rioplatense.
- El deep-link a GHL es white-label: `https://app.mazefunnels.com/v2/location/{loc}/contacts/detail/{id}` — **nunca** `app.gohighlevel.com`.

**Datos reales para verificar:**

| Org | `org_id` | `location_id` GHL |
|---|---|---|
| Camino Digital (Clara) | `7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7` | `EwHiiqjOSOdzpl909IDY` |
| Maze — Pruebas | `ec8d930b-1f49-4aa4-98cc-4d14afc653b7` | `siM5ZYQ90OgKoshnqLeC` |

Miembro con datos reales de setter en julio 2026: "Andy setter" (Camino Digital). Closers de Camino Digital: "Maria Clara Perez", "Valeria Damico".

---

### Task 1: Backend — unificar el closer con el motor y persistir los contactos

**Files:**
- Modify: `api/server.js` (`captureGhl`, ~609–722)

**Interfaces:**
- Consumes: `computeMemberKpis({ghlBase, token, locationId, calendarId, tz, date, member, salesRows, cuotasRows, bookingDomains, agendaCalendarIds})` → `{values: {kpi: number}, contacts: {kpi: [{id, name, count?}]}}` (`api/metrics.js`). `effectiveOrg`, `svcHeaders`, `svcGet`.
- Produces: `captureGhl` devuelve `{date, member_id, role, metrics, contacts}` y persiste en `st_shadow_metrics`.

**Contexto:** hoy `captureGhl` arma `metrics` por tres vías: (a) closer → trae eventos del calendario **con lógica propia duplicada** (~654–689), (b) closer → cierres/cash desde `st_sales` (~691–706), (c) setter/triage → `computeMemberKpis` (~708–720). El motor ya cubre las tres. Se reemplazan (a) y (b) por el motor.

- [ ] **Step 1: Leer `salesRows` y `cuotasRows` para pasárselos al motor**

`computeMemberKpis` calcula `cierres`/`cash_nuevo`/`reservas`/`revenue` desde `salesRows`, y `cash_cuotas` desde `cuotasRows` (`api/metrics.js:79-89`). Hoy `captureGhl` le pasa `salesRows: []` y `cuotasRows: []` al setter, y para el closer lee las ventas por separado con un `select=cash` incompleto.

Leé el motor (`api/metrics.js:79-89`) para saber **qué columnas exactas necesita** de cada tabla (`closer_id`, `sale_date`, `cash`, `reserva`, `facturado`, `id`; y de cuotas: `sale_id`, `status`, `paid_date`, `paid_amount`). Reemplazá el bloque de cierres/cash (~691–706) por una lectura que traiga esas columnas:

```js
  // Ventas y cuotas del tracker (fuente de verdad interna) — se las damos al motor,
  // que calcula cierres/cash/reservas/revenue/cash_cuotas con la misma regla del modo sombra.
  let salesRows = [], cuotasRows = [];
  if (prof.role === 'closer') {
    salesRows = await svcGet('st_sales?org_id=eq.' + encodeURIComponent(orgId)
      + '&select=id,closer_id,sale_date,cash,reserva,facturado');
    const ids = salesRows.map((s) => s.id);
    if (ids.length) {
      cuotasRows = await svcGet('st_cuotas?sale_id=in.(' + ids.map(encodeURIComponent).join(',') + ')'
        + '&select=sale_id,status,paid_date,paid_amount');
    }
  }
```

Verificá contra el motor que los nombres de columna coinciden EXACTAMENTE con lo que lee (`s.closer_id`, `s.sale_date`, `c.paid_date`…). Si alguno difiere, usá el del motor — él manda.

- [ ] **Step 2: Reemplazar el bloque de citas del closer por el motor**

Borrá el bloque `if (prof.role === 'closer' && prof.ghl_user_id) { ... }` que trae los eventos a mano (~654–689) y el bloque de cierres/cash que reemplazaste en el Step 1. Cambiá la condición del motor para que corra **para todos los roles con `ghl_user_id`**:

```js
  // Un solo motor para todos los roles: el mismo del modo sombra. Devuelve los KPIs
  // del día y el desglose de contactos que compone cada uno.
  const metrics = {};
  let contacts = {};
  if (prof.ghl_user_id) {
    const cfgRows = await svcGet('st_kpi_config?org_id=eq.' + encodeURIComponent(orgId) + '&kpi=eq._config&select=config');
    const bookingDomains = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.booking_domains) || [];
    const agendaCalendarIds = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.agenda_calendar_ids) || [];
    let result;
    try {
      result = await computeMemberKpis({
        ghlBase: GHL_BASE, token: creds.token, locationId: creds.locationId,
        calendarId, tz, date,
        member: { id: targetId, role: prof.role, ghl_user_id: prof.ghl_user_id },
        salesRows, cuotasRows, bookingDomains, agendaCalendarIds,
      });
    } catch {
      return sendJSON(res, 502, { error: 'No se pudieron calcular los KPIs de GHL' });
    }
    for (const [k, v] of Object.entries(result.values || {})) {
      metrics[k] = { value: v, source: 'ghl' };
    }
    contacts = result.contacts || {};
  }
```

Ojo con la guarda de calendario (~611): hoy `captureGhl` devuelve 501 si el closer no tiene `calendarId`. Mantenela: el motor necesita el calendario para las citas del closer.

- [ ] **Step 3: Persistir en `st_shadow_metrics` sin pisar `manual_value`**

Después de armar `metrics` y `contacts`, agregá el upsert. Una fila por KPI con valor. **Clave:** `on_conflict=member_id,metric_date,kpi` y `Prefer: resolution=merge-duplicates` — y el body **NO debe incluir `manual_value`**, para que un upsert no lo borre.

```js
  // Persistir lo calculado en st_shadow_metrics: así el desglose de contactos queda
  // guardado y la Vista Tabla no tiene que volver a pegarle a GHL para mostrarlo.
  // NO se toca manual_value: esa columna la escribe el worker nocturno del modo sombra.
  const shadowRows = Object.entries(metrics)
    .filter(([, m]) => m.source === 'ghl' || m.source === 'ventas')
    .map(([kpi, m]) => ({
      org_id: orgId, member_id: targetId, metric_date: date, kpi,
      auto_value: +m.value || 0,
      contacts: Array.isArray(contacts[kpi]) && contacts[kpi].length ? contacts[kpi] : null,
      computed_at: new Date().toISOString(),
    }));
  if (shadowRows.length) {
    try {
      await fetch(SUPABASE_URL + '/rest/v1/st_shadow_metrics?on_conflict=member_id,metric_date,kpi', {
        method: 'POST',
        headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(shadowRows),
      });
    } catch {
      console.error(`[api] GET /api/capture/ghl org=${orgId} shadow_upsert_fail date=${date} member=${targetId}`);
      /* best-effort: los números igual se devuelven; solo se pierde el desglose guardado */
    }
  }
```

**Verificá el comportamiento real del merge:** con `resolution=merge-duplicates`, PostgREST hace `ON CONFLICT DO UPDATE` y **solo actualiza las columnas presentes en el body**. Como `manual_value` no está en el body, no se toca. Confirmalo en la verificación del Step 6 — es el punto crítico de esta tarea.

- [ ] **Step 4: Devolver los contactos en la respuesta**

```js
  return sendJSON(res, 200, { date, member_id: targetId, role: prof.role, metrics, contacts });
```

- [ ] **Step 5: Chequeo de sintaxis**

```bash
cd /Users/alevogeler/maze-sales-tracker && node --check api/server.js && echo "server.js: OK"
```
Expected: `server.js: OK`.

- [ ] **Step 6: Commit**

```bash
cd /Users/alevogeler/maze-sales-tracker && git add api/server.js && git commit -m "feat(capture): un solo motor para todos los roles + persistir el desglose de contactos

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend — deploy a dev y verificación de no-regresión del closer

**Files:** (ninguno)

Esta tarea es el gate de la unificación. **No se avanza al frontend si los números del closer cambiaron.**

- [ ] **Step 1: Capturar los números del closer ANTES del deploy**

El código viejo todavía corre en dev. Obtené un JWT de super (`alejandro@mazefunnels.com` / `Maze-CallIQ-2026!` contra `https://supabase.mazefunnels.io/auth/v1/token?grant_type=password`, header `apikey: $ANON` — el ANON_KEY sale de `/root/supabase/docker/.env` en el VPS).

Buscá un closer de Camino Digital con citas reales (Maria Clara Perez o Valeria Damico — sacá su `member_id` de `st_profiles`) y un día con actividad. Llamá al endpoint viejo y **guardá la salida**:

```bash
curl -s "https://sales-tracker-test.mazefunnels.io/api/capture/ghl?date=<FECHA>&member_id=<CLOSER_ID>&org_id=7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7" -H "Authorization: Bearer $TOKEN_SUPER"
```
Anotá `llamadas`, `asistencias`, `no_shows`, `cierres`, `cash_nuevo`. Si el día elegido devuelve todo en 0, probá otro día — un 0==0 no prueba nada.

- [ ] **Step 2: Deploy del backend a dev**

```bash
cd /Users/alevogeler/maze-sales-tracker && git push -u origin feature/desglose-contactos-tabla
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'cd /docker/maze-sales-tracker-dev && git fetch origin && git checkout feature/desglose-contactos-tabla && git pull origin feature/desglose-contactos-tabla --quiet && docker compose -f docker-compose.dev.yml up -d --build --force-recreate api 2>&1 | tail -4'
```

- [ ] **Step 3: Verificar NO-REGRESIÓN del closer (GATE BLOQUEANTE)**

Repetí el mismo curl del Step 1, mismo día y mismo closer.

Expected: `llamadas`, `asistencias` y `no_shows` **idénticos** a los del Step 1. Es esperable que ahora aparezcan métricas NUEVAS (`segundas`, `cancelados`, `reservas`, `revenue`, `cash_cuotas`) — eso es la mejora buscada. Lo que NO puede pasar es que las tres viejas cambien de valor.

**Si cambiaron: DETENÉ.** No sigas con el frontend. Investigá la diferencia entre la lógica vieja (`captureGhl`, en el commit anterior) y `kpisCitas` (`api/metrics.js:32-51`) y reportá cuál es la divergencia y cuál de las dos es correcta.

- [ ] **Step 4: Verificar que los contactos vienen en la respuesta**

Con un setter con datos reales (Andy setter, Camino Digital, un día de julio con actividad):

```bash
curl -s "https://sales-tracker-test.mazefunnels.io/api/capture/ghl?date=<FECHA>&member_id=<ANDY_ID>&org_id=7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7" -H "Authorization: Bearer $TOKEN_SUPER" | python3 -m json.tool | head -40
```
Expected: la respuesta trae una clave `contacts` con arrays `[{id, name}]` por KPI.

- [ ] **Step 5: Verificar la persistencia Y que `manual_value` sobrevive (CRÍTICO)**

Primero, elegí una fila de `st_shadow_metrics` que YA tenga `manual_value` no-null y anotá su valor:

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'SVC=$(grep -E "^SERVICE_ROLE_KEY=" /root/supabase/docker/.env|cut -d= -f2); curl -s "https://supabase.mazefunnels.io/rest/v1/st_shadow_metrics?manual_value=not.is.null&select=member_id,metric_date,kpi,auto_value,manual_value&limit=3" -H "apikey: $SVC" -H "Authorization: Bearer $SVC"'
```

Llamá a `/api/capture/ghl` para ESE member_id y ESA fecha. Después releé la fila:

Expected: `contacts` poblado, `auto_value` actualizado, y **`manual_value` con el MISMO valor que antes** (no null, no pisado). Si `manual_value` se borró, el upsert está mal armado → arreglalo antes de seguir.

---

### Task 3: Frontend — el punto en la celda y el panel de contactos

**Files:**
- Modify: `index.html` (`renderTable` ~1023–1062; nuevo loader; CSS)

**Interfaces:**
- Consumes: `sb.from('st_shadow_metrics')` (lectura por RLS, patrón de `loadShadow` ~2293), `ORG_EPOCH` (guardia de época), `GHL_LOC` (location_id, poblado por `loadGhlLocation`), `state.tblMember`, `dayList`, `esc()`, `DB.entries`.
- Produces: `TBL_CONTACTS` (índice `` `${kpi}|${fecha}` `` → `[{id,name,count?}]`), `loadTblContacts()`, `toggleCellContacts(id)`.

- [ ] **Step 1: Loader de los contactos del mes visible**

Cerca de `renderTable`, agregá la global y el loader. Seguí el patrón EXACTO de `loadShadow` (`index.html:2293-2306`), incluida la **guardia de época** (`const epoch=ORG_EPOCH` antes del primer `await`, y descartar si cambió) — sin eso, cambiar de org con una carga en vuelo mezcla datos entre tenants.

```js
// Desglose de contactos por (kpi, día) del miembro y mes visibles en la Vista Tabla.
// Sale de st_shadow_metrics (lo persiste /api/capture/ghl al traer de HighLevel).
let TBL_CONTACTS={}, TBL_CONTACTS_KEY=null;
async function loadTblContacts(memberId, desde, hasta){
  const ck=`${memberId}|${desde}`;
  if(TBL_CONTACTS_KEY===ck) return; // ya cargado para este miembro+mes
  const epoch=ORG_EPOCH;
  const { data } = await sb.from('st_shadow_metrics')
    .select('metric_date,kpi,contacts')
    .eq('org_id',ME.org_id).eq('member_id',memberId)
    .gte('metric_date',desde).lte('metric_date',hasta);
  if(epoch!==ORG_EPOCH) return; // la org cambió mientras esperábamos: son datos de la org vieja
  const idx={};
  (data||[]).forEach(r=>{ if(Array.isArray(r.contacts) && r.contacts.length) idx[`${r.kpi}|${r.metric_date}`]=r.contacts; });
  TBL_CONTACTS=idx; TBL_CONTACTS_KEY=ck;
  if(state.view==='table') renderTable();
}
```

Invocalo desde `renderTable()` con el miembro y el rango del mes visible (`dayList[0]` y el último de `dayList`). Como `renderTable` es síncrona, llamalo sin `await` (el loader re-renderiza cuando termina) — igual que hace `ghlCard()` con `loadGhlStatus()`.

**Invalidá `TBL_CONTACTS_KEY=null` al entrar/salir de modo visita**, junto al resto de las globales que se resetean en `enterOrgAsSuper()`/`exitSuperView()` — si no, verías los contactos del miembro de la org anterior.

- [ ] **Step 2: El punto en la celda**

En `renderTable`, la celda hoy es (línea ~1045):
```js
        cells+=`<td class="${isT?'today':''}"><input class="cell" type="number" min="0" value="${v||''}" data-k="${mt.k}" data-d="${ds}" onchange="tblEdit(this)" ${canEdit?'':'readonly'}></td>`;
```
Cambiala para que, cuando haya contactos para ese `(kpi, día)`, agregue el punto y el panel. El `<td>` pasa a `position:relative` (para anclar el punto y el panel):

```js
        const cs=TBL_CONTACTS[`${mt.k}|${ds}`];
        const cid=`tc_${mt.k}_${ds}`;
        const dot=cs?`<span class="cell-dot" onclick="toggleCellContacts('${cid}')" data-tip="${cs.length} contacto${cs.length>1?'s':''} de HighLevel — clic para ver"></span>`:'';
        const panel=cs?cellContactsPanel(cid, mt.label, ds, cs):'';
        cells+=`<td class="${isT?'today':''} cell-td"><input class="cell" type="number" min="0" value="${v||''}" data-k="${mt.k}" data-d="${ds}" onchange="tblEdit(this)" ${canEdit?'':'readonly'}>${dot}${panel}</td>`;
```

- [ ] **Step 3: El panel de contactos**

Reusá el patrón de `recapHoy()` (`index.html:2325-2331`): lista de contactos con `nombre ×N` y deep-link white-label; si `GHL_LOC` no cargó, el nombre va sin link (nunca un link roto).

```js
// Panel de contactos de una celda. Mismo patrón que el recap del panel de calibración.
function cellContactsPanel(id, label, ds, cs){
  const filas=cs.map((c,i)=>{
    const txt=`${esc(c.name||'(sin nombre)')}${c.count?` <span style="color:var(--muted)">×${c.count}</span>`:''}`;
    const row=`display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;font-size:13px${i?';border-top:1px solid var(--line)':''}`;
    return GHL_LOC
      ? `<a href="https://app.mazefunnels.com/v2/location/${esc(GHL_LOC)}/contacts/detail/${esc(c.id)}" target="_blank" rel="noopener" style="${row};text-decoration:none;color:inherit"><span>${txt}</span><span style="opacity:.5">🔗</span></a>`
      : `<div style="${row};color:var(--muted)"><span>${txt}</span></div>`;
  }).join('');
  const total=cs.reduce((a,c)=>a+(c.count||1),0);
  return `<div id="${id}" class="cell-panel" style="display:none">
    <div class="cell-panel-h">${esc(label)} · ${esc(ds)} · ${total} <span style="opacity:.6">(${cs.length} contacto${cs.length>1?'s':''})</span></div>
    ${filas}</div>`;
}
window.toggleCellContacts=(id)=>{
  document.querySelectorAll('.cell-panel').forEach(p=>{ if(p.id!==id) p.style.display='none'; }); // uno a la vez
  const el=document.getElementById(id); if(el) el.style.display=el.style.display==='none'?'block':'none';
};
```

- [ ] **Step 4: CSS del punto y del panel**

Agregá cerca del resto de estilos de la tabla. El panel es flotante (`position:absolute`) para no romper el layout de la tabla, y va por encima (`z-index`):

```css
  .cell-td{position:relative}
  .cell-dot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--lime);cursor:pointer;opacity:.65}
  .cell-dot:hover{opacity:1;transform:scale(1.35)}
  .cell-panel{position:absolute;top:100%;right:0;z-index:60;min-width:240px;max-width:320px;max-height:280px;overflow-y:auto;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;box-shadow:0 12px 34px rgba(0,0,0,.5);text-align:left}
  .cell-panel-h{padding:8px 12px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface-2)}
```
Usá el nombre real de la variable CSS del color lima del tema (buscá `--lime` o equivalente en el `:root` del archivo; si se llama distinto, usá esa).

- [ ] **Step 5: Verificación de sintaxis**

```bash
cd /Users/alevogeler/maze-sales-tracker && node -e "const h=require('fs').readFileSync('index.html','utf8'); const m=h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/); new Function(m[1]); console.log('JS del index: OK');"
```
Expected: `JS del index: OK`.

- [ ] **Step 6: Commit**

```bash
cd /Users/alevogeler/maze-sales-tracker && git add index.html && git commit -m "feat(tabla): desglose de contactos de HighLevel por celda

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — la métrica huérfana `inbound_wpp_sin_canal`

**Files:**
- Modify: `index.html` (catálogo `METRICS.setter`, ~396–416)

**Contexto:** `api/metrics.js` calcula la clave `inbound_wpp_sin_canal` (inbounds de WhatsApp cuyo canal de origen no se pudo resolver: al contacto le falta el custom field con `utm_source` y el tag `origen:`). Esa clave **no existe en el catálogo de la UI**, así que esos contactos se calculan y se pierden en silencio — no aparecen en ninguna métrica.

- [ ] **Step 1: Agregar la métrica al catálogo del setter**

En `METRICS.setter`, justo después de `inbound_wpp_ig` (para que quede agrupada con los otros inbounds de WhatsApp):

```js
    {k:'inbound_wpp_sin_canal', label:'Inbound Wpp (sin canal)', def:'Te escribieron por WhatsApp, pero no pudimos determinar si venían de Instagram o de TikTok.\n\nCÓMO SE MIDE: el contacto es nuevo (dado de alta hoy en el CRM) y el primer mensaje de la conversación es entrante por WhatsApp, pero el contacto no tiene el campo utm_source ni un tag "origen:" que diga de dónde vino.\n\nSi este número es alto, tus inbounds de WhatsApp están mal atribuidos: entrá a los contactos (clic en el punto de la celda) y revisá por qué no traen origen.'},
```

- [ ] **Step 2: Verificación de sintaxis**

```bash
cd /Users/alevogeler/maze-sales-tracker && node -e "const h=require('fs').readFileSync('index.html','utf8'); const m=h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/); new Function(m[1]); console.log('JS del index: OK');"
```
Expected: `JS del index: OK`.

- [ ] **Step 3: Commit**

```bash
cd /Users/alevogeler/maze-sales-tracker && git add index.html && git commit -m "feat(setter): mostrar los inbound de WhatsApp sin canal resuelto (antes se perdían)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Frontend — tooltips con la regla exacta de medición

**Files:**
- Modify: `index.html` (catálogo `METRICS` ~395–438; CSS de `.tipbox` ~235; `derivedRows` ~1063–1094)

**Interfaces:**
- Consumes: `data-tip="${esc(mt.def)}"` (ya presente en la celda de etiqueta de cada fila, `index.html:1046` y `:1091`), y el listener global de tooltip (`index.html:2816-2831`) que hace `box.textContent = t.getAttribute('data-tip')`.

**El objetivo de esta tarea es la auditoría:** Alejandro va a usar estos textos para decidir si un número está bien o mal. Un tooltip que describa mal una regla es PEOR que no tener tooltip. Las reglas de abajo se derivaron leyendo `api/metrics.js`; **si al implementar encontrás que alguna no coincide con el código, PARÁ y reportalo** — no la ajustes por tu cuenta ni "arregles" el texto para que cierre.

- [ ] **Step 1: Permitir saltos de línea en el tooltip**

El tooltip se pinta con `textContent`, así que los `\n` no se renderizan. En el CSS de `.tipbox` (línea ~235), agregá `white-space:pre-line` y subí el ancho máximo (los textos ahora son más largos):

```css
  .tipbox{position:fixed;display:none;white-space:pre-line;background:var(--surface-2);border:1px solid var(--line);color:var(--ink);font-size:12px;line-height:1.45;padding:8px 11px;border-radius:9px;max-width:340px;z-index:9999;box-shadow:0 12px 34px rgba(0,0,0,.5);pointer-events:none}
```
No conviertas el tooltip a `innerHTML`: `textContent` + `pre-line` alcanza y evita inyección.

- [ ] **Step 2: Reescribir los `def` del catálogo SETTER**

Reemplazá el campo `def` de cada métrica de `METRICS.setter`. Dejá `k` y `label` como están.

```js
    {k:'outbound', label:'Outbound', def:'Vos abriste la conversación con alguien nuevo.\n\nCÓMO SE MIDE: el contacto fue dado de alta en el CRM ESE MISMO DÍA, y el primer mensaje de la conversación es tuyo, humano (no ManyChat), y salió ese día. Se cuenta 1 por contacto, no por mensaje.\n\nTikTok NO entra acá: va en Outbound TikTok.'},
    {k:'inbound_ig', label:'Inbound IG', def:'Te escribió alguien nuevo por Instagram, sin que vos le hablaras antes.\n\nCÓMO SE MIDE: el contacto fue dado de alta en el CRM ese mismo día y el PRIMER mensaje de la conversación es entrante, por Instagram. Se cuenta 1 por contacto.'},
    {k:'inbound_wpp_tk', label:'Inbound Wpp·TikTok', def:'Te escribió alguien nuevo por WhatsApp, y venía de TikTok.\n\nCÓMO SE MIDE: contacto nuevo del día, primer mensaje entrante por WhatsApp, y el origen TikTok sale del campo utm_source del contacto o de un tag "origen:". Si el contacto no trae ninguno de los dos, cae en "Inbound Wpp (sin canal)".'},
    {k:'inbound_wpp_ig', label:'Inbound Wpp·IG', def:'Te escribió alguien nuevo por WhatsApp, y venía de Instagram.\n\nCÓMO SE MIDE: contacto nuevo del día, primer mensaje entrante por WhatsApp, y el origen Instagram sale del campo utm_source del contacto o de un tag "origen:". Si el contacto no trae ninguno de los dos, cae en "Inbound Wpp (sin canal)".'},
    {k:'bienvenidas', label:'Bienvenidas', def:'El mensaje automático de bienvenida (ManyChat) que abrió la conversación.\n\nCÓMO SE MIDE: SOLO Instagram. El primer mensaje de la conversación es saliente pero AUTOMÁTICO (no lo escribiste vos: la API lo marca como enviado por una automatización), y salió ese día.\n\nNo cuenta como Outbound: Outbound son solo los que abriste vos a mano.'},
    {k:'cta', label:'CTA', def:'Respuestas a un call-to-action de feed o historias.\n\nSE CARGA A MANO: HighLevel no la puede detectar sola. Requiere instrumentar ManyChat para que etiquete al contacto cuando llega por un CTA.'},
    {k:'respuestas', label:'Respuestas', def:'Te contestó alguien con quien YA venías hablando.\n\nCÓMO SE MIDE: el contacto NO es nuevo (fue dado de alta otro día) y mandó al menos un mensaje entrante ese día. Se cuenta 1 por contacto, no por mensaje.\n\nTikTok va aparte, en Respuestas TikTok.'},
    {k:'seg_ig', label:'Seguimientos IG', def:'Le escribiste a alguien en una conversación que ya venía de antes, por Instagram.\n\nCÓMO SE MIDE: la conversación NO empezó ese día, y vos mandaste al menos un mensaje humano (no ManyChat) ese día. Se cuenta 1 por conversación.'},
    {k:'seg_wpp', label:'Seguimientos Wpp', def:'Le escribiste a alguien en una conversación que ya venía de antes, por WhatsApp.\n\nCÓMO SE MIDE: la conversación NO empezó ese día, y vos mandaste al menos un mensaje humano (no ManyChat) ese día. Se cuenta 1 por conversación.'},
    {k:'outbound_tk', label:'Outbound TikTok', def:'Vos abriste la conversación con alguien nuevo, por TikTok.\n\nCÓMO SE MIDE: igual que Outbound (contacto nuevo del día + primer mensaje tuyo y humano), pero en el DM nativo de TikTok.\n\nOJO: el WhatsApp que viene de TikTok NO es esto — eso es Inbound Wpp·TikTok.'},
    {k:'resp_tk', label:'Respuestas TikTok', def:'Te contestó por TikTok alguien con quien ya venías hablando.\n\nCÓMO SE MIDE: el contacto NO es nuevo y mandó al menos un mensaje entrante ese día, en el DM nativo de TikTok.'},
    {k:'inbound_tk', label:'Inbound TikTok', def:'Te escribió alguien nuevo por TikTok, sin que vos le hablaras antes.\n\nCÓMO SE MIDE: contacto nuevo del día y el primer mensaje de la conversación es entrante, en el DM nativo de TikTok.'},
    {k:'seg_tk', label:'Seguimientos TikTok', def:'Le escribiste por TikTok a alguien en una conversación que ya venía de antes.\n\nCÓMO SE MIDE: la conversación NO empezó ese día, y vos mandaste al menos un mensaje humano ese día.'},
    {k:'ads_inbound', label:'ADS inbound', def:'Te escribió alguien que llegó desde un anuncio.\n\nSE CARGA A MANO: todavía no se detecta sola. La atribución de ADS sale de attributionSource.adId en el contacto de HighLevel, pendiente de validar con un lead real de anuncios.'},
    {k:'ads_seg', label:'ADS seguimiento', def:'Le hiciste seguimiento a alguien que llegó desde un anuncio.\n\nSE CARGA A MANO: mismo motivo que ADS inbound.'},
    {k:'links_ig', label:'Links agenda IG', def:'Links de agenda que mandaste por Instagram.\n\nCÓMO SE MIDE: mensajes tuyos, humanos, enviados ese día por Instagram, cuyo texto contiene alguno de los dominios de agenda configurados (Configuraciones → panel de calibración).\n\nSe cuenta POR MENSAJE, no por contacto: si le mandás el link dos veces a la misma persona, suma 2.\n\nSi no configuraste dominios de agenda, esta métrica siempre da 0.'},
    {k:'links_wpp', label:'Links agenda Wpp', def:'Links de agenda que mandaste por WhatsApp.\n\nCÓMO SE MIDE: mensajes tuyos, humanos, enviados ese día por WhatsApp, cuyo texto contiene alguno de los dominios de agenda configurados.\n\nSe cuenta POR MENSAJE, no por contacto.\n\nSi no configuraste dominios de agenda, esta métrica siempre da 0.'},
    {k:'agend_ig', label:'Agendados IG', def:'Personas a las que les mandaste el link por Instagram y terminaron agendando.\n\nCÓMO SE MIDE: cruce entre el link que mandaste y las citas del calendario. Si le mandaste el link a un contacto ese día, y ese contacto tiene una cita agendada dentro de los 7 DÍAS siguientes, cuenta como agendado tuyo.\n\nNo importa a quién esté asignada la cita (suele quedar en el closer): la atribución es por contacto. Una agenda por contacto, aunque aparezca en varios calendarios.\n\nNecesita los calendarios de agenda configurados.'},
    {k:'agend_wpp', label:'Agendados Wpp', def:'Personas a las que les mandaste el link por WhatsApp y terminaron agendando.\n\nCÓMO SE MIDE: mismo cruce que Agendados IG — link enviado ese día + cita del contacto dentro de los 7 días siguientes, en los calendarios de agenda configurados.'},
```

Nota: `inbound_wpp_sin_canal` ya trae su `def` de la Task 4 — no lo dupliques.

- [ ] **Step 3: Reescribir los `def` del catálogo TRIAGE**

Las 4 métricas de triage son manuales: el motor NO las calcula (no hay ninguna rama en `api/metrics.js` que las toque). El tooltip tiene que decirlo, porque si no el usuario esperaría que se autocompleten.

```js
    {k:'agendadas', label:'Agendadas', def:'Llamadas de triage que te agendaron.\n\nSE CARGA A MANO: el motor de HighLevel todavía no calcula las métricas de triage — requiere un calendario de triage propio por organización.'},
    {k:'asistencias', label:'Asistencias', def:'Llamadas de triage a las que la persona asistió.\n\nSE CARGA A MANO: igual que Agendadas.'},
    {k:'no_shows', label:'Canceladas/No-show', def:'Llamadas de triage que se cancelaron o a las que no asistieron.\n\nSE CARGA A MANO: igual que Agendadas.'},
    {k:'pases', label:'Pases a closer', def:'Personas que pasaste al closer después del triage.\n\nSE CARGA A MANO: igual que Agendadas.'},
```

- [ ] **Step 4: Reescribir los `def` del catálogo CLOSER**

Ojo: tras la unificación con el motor (Task 1), el closer ahora SÍ autocompleta `segundas`, `cancelados`, `reservas`, `revenue` y `cash_cuotas`. Los tooltips tienen que reflejar el estado NUEVO, no el viejo.

```js
    {k:'disponibilidad', label:'Disponibilidad', def:'Slots de llamada que ofreciste en el día.\n\nSE CARGA A MANO: HighLevel no sabe cuántos slots ofreciste, solo cuáles se ocuparon.\n\nEs el denominador de "% Ocupación".'},
    {k:'llamadas', label:'Llamadas', def:'Llamadas que tenías agendadas ese día.\n\nCÓMO SE MIDE: citas del calendario de llamadas configurado, ASIGNADAS A VOS, que empiezan ese día y NO están canceladas ni son inválidas. Se cuenta por cita, no por contacto.\n\nSi una cita no está asignada a tu usuario de HighLevel, no cuenta.'},
    {k:'segundas', label:'Segundas', def:'Llamadas con alguien que ya te había asistido antes.\n\nCÓMO SE MIDE: de tus llamadas válidas del día, las de contactos que YA tuvieron una cita marcada como "asistió" (showed) en los 30 días previos.'},
    {k:'asistencias', label:'Asistencias', def:'Llamadas a las que la persona efectivamente asistió.\n\nCÓMO SE MIDE: tus citas válidas del día cuyo estado en HighLevel es exactamente "showed". Ningún otro estado cuenta como asistencia — si el closer no marca el estado, la llamada no suma acá.'},
    {k:'ofertas', label:'Ofertas', def:'Llamadas en las que llegaste a presentar la oferta.\n\nSE CARGA A MANO: HighLevel no sabe qué pasó dentro de la llamada.\n\nEs el denominador de "% Cierre".'},
    {k:'cancelados', label:'Cancelados', def:'Citas del día que se cancelaron.\n\nCÓMO SE MIDE: citas del calendario que empiezan ese día y cuyo estado en HighLevel es "cancelled". No entran en Llamadas (que solo cuenta las válidas).'},
    {k:'no_shows', label:'No-shows', def:'Personas que no aparecieron a la llamada.\n\nCÓMO SE MIDE: tus citas válidas del día cuyo estado en HighLevel es exactamente "noshow".'},
    {k:'cierres', label:'Cierres', def:'Ventas que cerraste ese día.\n\nCÓMO SE MIDE: sale del propio tracker (módulo Ventas), no de HighLevel: ventas cargadas con vos como closer y con fecha de venta ese día.'},
    {k:'cash_nuevo', label:'Cash nuevo', money:true, def:'Plata que entró de las ventas que cerraste ese día.\n\nCÓMO SE MIDE: suma del campo "cash" de tus ventas del día (módulo Ventas del tracker).'},
    {k:'cash_cuotas', label:'Cash cuotas', money:true, def:'Plata de cuotas que se cobró ese día, de ventas tuyas.\n\nCÓMO SE MIDE: suma de las cuotas marcadas como pagadas con fecha de cobro ese día, de cualquier venta tuya (sin importar cuándo se cerró la venta).'},
    {k:'reservas', label:'Reservas', money:true, def:'Reservas (señas) de las ventas que cerraste ese día.\n\nCÓMO SE MIDE: suma del campo "reserva" de tus ventas del día.'},
    {k:'revenue', label:'Revenue', money:true, def:'Total facturado de las ventas que cerraste ese día.\n\nCÓMO SE MIDE: suma del campo "facturado" de tus ventas del día. Es el valor del contrato, no lo que efectivamente entró (eso es Cash).'},
    {k:'referidos', label:'Referidos', def:'Referidos que te dieron en las llamadas.\n\nSE CARGA A MANO: HighLevel no lo sabe.'},
```

Preservá el flag `money:true` en las 4 métricas de monto — si se pierde, la fila de total deja de formatearse como plata.

- [ ] **Step 5: Arreglar el subtotal "Conversaciones nuevas" (BUG) y reescribir los tooltips derivados**

**El bug:** en `derivedRows()` (`index.html:1067`), "Conversaciones nuevas" hoy suma:
```js
num:ds=>get(ds,'outbound')+get(ds,'inbound_ig')+get(ds,'inbound_wpp_tk')+get(ds,'inbound_wpp_ig')
```
**Deja afuera TikTok** (`outbound_tk`, `inbound_tk`), que se agregaron al catálogo después y nadie sumó al subtotal. Un setter que abre conversaciones por TikTok no las ve reflejadas acá. Y tampoco sumaría la métrica nueva `inbound_wpp_sin_canal` de la Task 4.

Corregilo para que sume **todas** las conversaciones que se abren con contactos nuevos:
```js
      {label:'Conversaciones nuevas', def:'…', num:ds=>get(ds,'outbound')+get(ds,'inbound_ig')+get(ds,'inbound_wpp_tk')+get(ds,'inbound_wpp_ig')+get(ds,'inbound_wpp_sin_canal')+get(ds,'outbound_tk')+get(ds,'inbound_tk')},
```
No sumes `bienvenidas`, `respuestas` ni los seguimientos: no son conversaciones nuevas abiertas por actividad del setter (bienvenidas es un automatismo; respuestas y seguimientos son sobre contactos que ya existían).

**Los tooltips derivados.** Reemplazá el `def` de cada fila de `derivedRows()` (las fórmulas de abajo están verificadas contra el código; la primera refleja el subtotal YA CORREGIDO):

```js
    setter:[
      {label:'Conversaciones nuevas', def:'Subtotal: todas las conversaciones que se abrieron con contactos nuevos ese día.\n\nFÓRMULA: outbound + inbound IG + inbound Wpp·TikTok + inbound Wpp·IG + inbound Wpp sin canal + outbound TikTok + inbound TikTok.\n\nNo incluye bienvenidas (son automáticas), ni respuestas ni seguimientos (esos son contactos que ya existían).', num:…},
      {label:'Total links', def:'Subtotal: links de agenda que enviaste.\n\nFÓRMULA: links agenda IG + links agenda Wpp.\n\nCuenta por mensaje: si mandás el link dos veces a la misma persona, suma 2.', num:…},
      {label:'Total agendados', def:'Subtotal: personas que agendaron a partir de tu link.\n\nFÓRMULA: agendados IG + agendados Wpp.', num:…},
      {label:'Tasa link→agenda', def:'De cada 100 links que mandaste, cuántos terminaron en una cita agendada.\n\nFÓRMULA: (agendados IG + agendados Wpp) ÷ (links IG + links Wpp).\n\nOJO: el cruce link→cita tiene una ventana de 7 días. Si la persona agenda al día 8, no cuenta.', pct:…},
      {label:'% respuesta outbound TikTok', def:'De cada 100 personas que abriste en frío por TikTok, cuántas te contestaron.\n\nFÓRMULA: respuestas TikTok ÷ outbound TikTok.', pct:…},
    ],
    triage:[
      {label:'% Asistencia', def:'De cada 100 llamadas de triage agendadas, cuántas asistieron.\n\nFÓRMULA: asistencias ÷ agendadas.\n\nLos dos números se cargan a mano.', pct:…},
      {label:'% Pases a closer', def:'De cada 100 llamadas de triage agendadas, cuántas pasaste al closer.\n\nFÓRMULA: pases ÷ agendadas.\n\nLos dos números se cargan a mano.', pct:…},
    ],
    closer:[
      {label:'% Ocupación', def:'Qué parte de los slots que ofreciste se llenaron con llamadas.\n\nFÓRMULA: llamadas ÷ disponibilidad.\n\nDisponibilidad se carga a mano: si no la cargás, esta tasa queda vacía.', pct:…},
      {label:'% Cierre', def:'De cada 100 ofertas que presentaste, cuántas cerraron.\n\nFÓRMULA: cierres ÷ ofertas.\n\nOfertas se carga a mano: si no la cargás, esta tasa queda vacía.', pct:…},
      {label:'Cash total', def:'Subtotal de la plata que entró ese día.\n\nFÓRMULA: cash nuevo + cash de cuotas.\n\nNo incluye las reservas: esas se muestran aparte.', money:…},
    ],
```
(Los `…` son los `num`/`pct`/`money` que ya están en el código — no los toques, salvo el de "Conversaciones nuevas", que corregís arriba.)

Verificá que el tooltip de "Cash total" siga siendo cierto después de tu cambio: si `money:` suma algo distinto a `cash_nuevo + cash_cuotas`, el texto tiene que decir lo que el código hace, no al revés.

- [ ] **Step 6: Verificación de sintaxis**

```bash
cd /Users/alevogeler/maze-sales-tracker && node -e "const h=require('fs').readFileSync('index.html','utf8'); const m=h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/); new Function(m[1]); console.log('JS del index: OK');"
```
Expected: `JS del index: OK`.

Verificá además que las comillas simples dentro de los textos (ej. `"origen:"`) no rompan los strings JS — usá comillas dobles dentro de los `def` delimitados por comillas simples, como en los ejemplos.

- [ ] **Step 7: Commit**

```bash
cd /Users/alevogeler/maze-sales-tracker && git add index.html && git commit -m "feat(metricas): tooltips con la regla exacta de cómo se mide cada métrica

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Deploy del frontend y guion de QA

**Files:** (ninguno)

- [ ] **Step 1: Push y deploy del frontend a dev**

```bash
cd /Users/alevogeler/maze-sales-tracker && git push
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'cd /docker/maze-sales-tracker-dev && git pull origin feature/desglose-contactos-tabla --quiet && docker compose -f docker-compose.dev.yml up -d --force-recreate maze-sales-tracker-dev 2>&1 | tail -3'
```

- [ ] **Step 2: Smoke test por curl**

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'echo -n "cell-dot: "; curl -s https://sales-tracker-test.mazefunnels.io | grep -c "cell-dot"; echo -n "inbound_wpp_sin_canal: "; curl -s https://sales-tracker-test.mazefunnels.io | grep -c "inbound_wpp_sin_canal"; echo -n "pre-line en tipbox: "; curl -s https://sales-tracker-test.mazefunnels.io | grep -c "white-space:pre-line"'
```
Expected: los tres ≥1.

- [ ] **Step 3: Verificar que prod sigue intacto**

```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 'cd /docker/maze-sales-tracker && git log --oneline -1 | cat; curl -s -o /dev/null -w "prod HTTP %{http_code}\n" https://tracker.caminodigitalllc.com'
```
Expected: commit `f37fb0f`, HTTP 200.

- [ ] **Step 4: Guion de QA para Alejandro (click-through visual, lo hace él)**

Dejar escrito en el resumen final, sobre `https://sales-tracker-test.mazefunnels.io`:

1. Entrar a Camino Digital (Plataforma → Entrar), ir a la **Vista Tabla**, elegir a **Andy setter** y julio 2026.
2. Apretar **⚡ Traer de HighLevel** y aplicar.
3. Las celdas con número deberían mostrar un **punto lima** en la esquina. Clic en el punto → se abre la lista de contactos, con el nombre y el link a su ficha en GHL.
4. El link tiene que abrir el contacto **correcto** en la subcuenta de Clara (`EwHiiqjOSOdzpl909IDY`), no en otra.
5. Pasar el mouse por el nombre de cada métrica → el tooltip explica qué mide y **cómo** se mide.
6. Escribir un número a mano en una celda → sigue funcionando igual que antes.
7. Aparece la métrica nueva **"Inbound Wpp (sin canal)"**. Si tiene números, clic en el punto para ver a quiénes les falta el origen.
8. Con un **closer** (Maria Clara Perez): sus celdas ahora también tienen punto, y el ⚡ le trae además segundas, cancelados, reservas y cash de cuotas.

---

## Notas de cierre

- Rama `feature/desglose-contactos-tabla` sale de `feature/sync-usuarios-ghl-visita`, que sale de `feature/super-entrar-org`. **Tres ramas apiladas sin mergear** — el PR de esta va contra `sync-usuarios-ghl-visita`, o se mergea la cadena primero.
- No promover a main/prod sin el QA de Alejandro.
