# Autocompletar desde GHL (Fase 3 carcasa) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Botón "⚡ Autocompletar" en Cargar día que trae lo certero (citas GHL + ventas del tracker) para closers, con badges por métrica y guardado por el flujo normal.

**Architecture:** Endpoint `GET /api/capture/ghl` en la mini-API (patrón `ghlLeads`: `requireMember` + `getGhlCreds` + calendario por org). El frontend aplica valores a `DB.entries`, marca badges transitorios en `state.ghlFill` y persiste por el `save()` de siempre.

**Tech Stack:** Node 22 sin deps (server.js), vanilla JS (index.html), API GHL `calendars/events` (Version 2021-04-15).

**Spec:** `docs/superpowers/specs/2026-07-05-autocompletar-ghl-design.md`

## Global Constraints

- Repo `/docker/maze-sales-tracker-dev`, rama `develop`; `git status` limpio antes de editar.
- **v1 SOLO closers** (verificado contra la API real 2026-07-05: `createdBy.userId` llega null → atribución setter no certera; además las métricas de setter están partidas por canal `agend_ig`/`agend_wpp` que GHL no conoce). Setter/triage → 400.
- Citas sin `assignedUserId` se ignoran (no certeras). `deleted:true` se ignora. `llamadas` = citas del día no canceladas/inválidas; `asistencias` = status `showed`; `no_shows` = status `noshow`.
- Día calculado en la TZ de la org, no UTC.
- `cierres`/`cash_nuevo` salen de `st_sales` (server-side, service role), nunca de GHL.
- Nada se persiste al apretar el botón: solo cambia `DB.entries` en memoria y el `save()` normal empuja.
- server.js cambiado ⇒ rebuild del contenedor api: `docker compose -f docker-compose.dev.yml up -d --build api`.
- Validar JS del index con `node --check`; copy castellano latino.

---

### Task 1: Endpoint `GET /api/capture/ghl` en la mini-API

**Files:**
- Modify: `/docker/maze-sales-tracker-dev/api/server.js` — header de rutas (~línea 18), función nueva después de `ghlLeads` (~línea 510), ruta junto a `/api/ghl/leads` (~línea 2427)

**Interfaces:**
- Consumes: `requireMember`, `requireAdmin` (para `member_id` ajeno), `getGhlCreds`, `ghlHeaders`, `svcHeaders`, `sendJSON`, `GHL_BASE`, `GHL_CALENDAR`.
- Produces: `GET /api/capture/ghl?date=YYYY-MM-DD[&member_id=uuid]` → `{date, member_id, role:'closer', metrics:{llamadas:{value,source:'ghl'}, asistencias:{value,source:'ghl'}, no_shows:{value,source:'ghl'}, cierres:{value,source:'ventas'}, cash_nuevo:{value,source:'ventas'}}}`. Errores: 400 fecha inválida / rol no closer; 403 member_id ajeno sin ser admin; 404 miembro inexistente/inactivo; 501 sin GHL o sin calendario (la UI oculta el botón); 502 fallas GHL/DB.

- [ ] **Step 1: Helper de rango de día en TZ + función del endpoint**

Insertar después de `ghlLeads`:

```js
// ---------- GET /api/capture/ghl ----------
// Autocompletar Cargar día (Fase 3 carcasa). SOLO closers en v1:
// - llamadas/asistencias/no_shows: citas del calendario de la org del día pedido,
//   SOLO las asignadas al ghl_user_id del closer (sin assignedUserId = no certera, se ignora).
// - cierres/cash_nuevo: st_sales del closer ese día (fuente: el propio tracker).
// El día se corta en la TZ de la org. Nada se escribe acá: la UI aplica y el
// usuario guarda por el flujo normal (RLS de st_entries manda).
function tzDayRange(dateStr, tz) {
  const utcMidnight = new Date(dateStr + 'T00:00:00Z').getTime();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMidnight)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const offset = asUtc - utcMidnight; // cuánto adelanta el tz respecto de UTC
  const start = utcMidnight - offset;
  return { start, end: start + 86400000 };
}

async function captureGhl(req, res, member, url) {
  const date = String(url.searchParams.get('date') || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, 400, { error: 'Fecha inválida (YYYY-MM-DD)' });

  // Target: uno mismo, o cualquier miembro de la org si el caller es admin.
  const targetId = url.searchParams.get('member_id') || member.uid;
  if (targetId !== member.uid && member.role !== 'admin') {
    return sendJSON(res, 403, { error: 'Solo el admin puede autocompletar el día de otro miembro' });
  }

  let prof;
  try {
    const pr = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(targetId)
        + '&org_id=eq.' + encodeURIComponent(member.org_id) + '&select=id,role,active,ghl_user_id',
      { headers: svcHeaders() }
    );
    prof = (await pr.json().catch(() => []))[0];
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo leer el perfil del miembro' });
  }
  if (!prof || prof.active === false) return sendJSON(res, 404, { error: 'Miembro no encontrado o inactivo' });
  if (prof.role !== 'closer') return sendJSON(res, 400, { error: 'El autocompletar está disponible solo para closers (v1)' });

  let creds;
  try { creds = await getGhlCreds(member.org_id); } catch {
    return sendJSON(res, 502, { error: 'No se pudo refrescar el acceso a GHL. Probá de nuevo.' });
  }
  if (!creds) return sendJSON(res, 501, { error: 'GHL no está configurado en esta instancia' });
  const calendarId = (creds.integration && creds.integration.calendar_id) || GHL_CALENDAR;
  if (!calendarId) return sendJSON(res, 501, { error: 'Elegí el calendario de llamadas en Configuraciones → Integración HighLevel' });

  // TZ de la org para cortar el día donde corresponde.
  let tz = 'America/Argentina/Buenos_Aires';
  try {
    const or_ = await fetch(SUPABASE_URL + '/rest/v1/st_orgs?id=eq.' + encodeURIComponent(member.org_id) + '&select=tz',
      { headers: svcHeaders() });
    const orow = (await or_.json().catch(() => []))[0];
    if (orow && orow.tz) tz = orow.tz;
  } catch { /* fallback al default */ }

  const metrics = {};

  // Citas del día asignadas al closer (solo si tiene ghl_user_id vinculado).
  if (prof.ghl_user_id) {
    let events = [];
    try {
      const { start, end } = tzDayRange(date, tz);
      const evRes = await fetch(
        `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(creds.locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${start}&endTime=${end}`,
        { headers: ghlHeaders(creds.token, '2021-04-15') }
      );
      const ev = await evRes.json().catch(() => ({}));
      events = ev.events || [];
    } catch {
      return sendJSON(res, 502, { error: 'No se pudieron leer las citas de GHL' });
    }
    let llamadas = 0, asistencias = 0, noShows = 0;
    for (const e of events) {
      if (e.deleted) continue;
      if (e.assignedUserId !== prof.ghl_user_id) continue; // sin asignación certera no cuenta
      const st = String(e.appointmentStatus || '').toLowerCase();
      if (['cancelled', 'invalid'].includes(st)) continue;
      llamadas++;
      if (st === 'showed') asistencias++;
      if (st === 'noshow') noShows++;
    }
    metrics.llamadas = { value: llamadas, source: 'ghl' };
    metrics.asistencias = { value: asistencias, source: 'ghl' };
    metrics.no_shows = { value: noShows, source: 'ghl' };
  }

  // Cierres y cash desde las ventas del tracker (fuente de verdad interna).
  try {
    const sr = await fetch(
      SUPABASE_URL + '/rest/v1/st_sales?org_id=eq.' + encodeURIComponent(member.org_id)
        + '&closer_id=eq.' + encodeURIComponent(targetId) + '&sale_date=eq.' + encodeURIComponent(date) + '&select=cash',
      { headers: svcHeaders() }
    );
    const sales = await sr.json().catch(() => null);
    if (Array.isArray(sales)) {
      metrics.cierres = { value: sales.length, source: 'ventas' };
      metrics.cash_nuevo = { value: sales.reduce((a, s) => a + (+s.cash || 0), 0), source: 'ventas' };
    }
  } catch { /* sin ventas legibles: se omiten esas métricas */ }

  return sendJSON(res, 200, { date, member_id: targetId, role: prof.role, metrics });
}
```

- [ ] **Step 2: Ruta + doc del header**

Junto a la ruta de `/api/ghl/leads` (misma sección "cualquier miembro ACTIVO"):

```js
    if (req.method === 'GET' && path === '/api/capture/ghl') {
      const member = await requireMember(req);
      if (!member.ok) return sendJSON(res, member.status, { error: member.error });
      return captureGhl(req, res, member, parsedUrl);
    }
```

(Usar la variable de URL parseada que ya exista en el router — si el router usa `path` de `new URL(...)`, pasar ese objeto URL; verificar el nombre real al editar.)

Y en el comentario de rutas del header del archivo:

```
//   GET    /api/capture/ghl        -> autocompletar Cargar día del closer (citas GHL + ventas del día)
```

- [ ] **Step 3: Sintaxis, deploy api, smoke test, commit**

```bash
node --check api/server.js
docker compose -f docker-compose.dev.yml up -d --build api
# smoke: sin auth -> 401
curl -s -o /dev/null -w '%{http_code}' https://sales-tracker-test.mazefunnels.io/api/capture/ghl?date=2026-07-05
git add api/server.js && git commit -m "feat(capture): endpoint GET /api/capture/ghl — autocompletar del closer"
```

Expected: `401`.

---

### Task 2: UI — botón ⚡ Autocompletar + badges en Cargar día

**Files:**
- Modify: `/docker/maze-sales-tracker-dev/index.html` — CSS (~junto a `.cuo-est`), `renderCapture` (~879), handlers `bump`/`setNum`/`setMoney` (~929–970), `setCapMember`/`setCapDate` (~975), función nueva `autofillGhl`

**Interfaces:**
- Consumes: endpoint Task 1; `state.capMember`, `state.capDate`, `DB.entries`, `save()`, `toast()`, `renderCapture()`, `sb.auth.getSession()`.
- Produces: `state.ghlFill` (mapa `k -> 'GHL'|'Ventas'`, transitorio), `window.autofillGhl()`.

- [ ] **Step 1: CSS del badge**

Junto a `.cuo-est`:

```css
  .ghl-badge{font-size:9px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:10px;background:rgba(197,255,73,.16);color:var(--lime-ink,#C5FF49);margin-left:6px;vertical-align:middle}
```

- [ ] **Step 2: Botón + badges en `renderCapture`**

En `cap-controls`, después del chip de Rol (solo closers con GHL conectable — probe optimista, el 501 lo oculta):

```js
        ${member.role==='closer' ? `<button class="chip" id="ghlFillBtn" onclick="autofillGhl()" data-tip="Trae lo certero: citas del calendario (llamadas, asistencias, no-shows) y cierres/cash de tus Ventas del día. Revisás y guardás.">⚡ Autocompletar</button>` : ''}
```

En los taps, badge junto al número y al input de dinero:

```js
      if(mt.money){
        taps+=`<div class="tap"><div><div class="tl">${mt.label}${state.ghlFill&&state.ghlFill[mt.k]?`<span class="ghl-badge" id="gb_${mt.k}">${state.ghlFill[mt.k]}</span>`:''}</div><div class="def">${mt.def}</div></div>
          <div class="tr"><input class="money-in" type="number" min="0" value="${val}" onchange="setMoney('${mt.k}', this.value)"></div></div>`;
      } else {
        taps+=`<div class="tap"><div><div class="tl">${mt.label}${state.ghlFill&&state.ghlFill[mt.k]?`<span class="ghl-badge" id="gb_${mt.k}">${state.ghlFill[mt.k]}</span>`:''}</div><div class="def">${mt.def}</div></div>
          <div class="tr"><button class="step" onclick="bump('${mt.k}',-1)">−</button><span class="num" id="n_${mt.k}" ondblclick="editNum('${mt.k}')" title="Doble clic para escribir el número">${val}</span><button class="step plus" onclick="bump('${mt.k}',1)">+</button></div></div>`;
      }
```

- [ ] **Step 3: `autofillGhl` + limpieza de badges en edición manual**

```js
window.autofillGhl=async()=>{
  const btn=document.getElementById('ghlFillBtn'); if(btn){ btn.disabled=true; btn.textContent='Trayendo…'; }
  const fail=(msg)=>{ if(btn){ btn.disabled=false; btn.textContent='⚡ Autocompletar'; } if(msg) toast(msg); };
  try{
    const {data:{session}}=await sb.auth.getSession();
    if(!session){ fail('Tu sesión venció, volvé a entrar'); return; }
    const q=new URLSearchParams({date:state.capDate}); if(state.capMember!==ME.id) q.set('member_id',state.capMember);
    const r=await fetch('/api/capture/ghl?'+q.toString(),{headers:{'Authorization':'Bearer '+session.access_token}});
    if(r.status===501){ if(btn) btn.style.display='none'; return; }
    const j=await r.json().catch(()=>null);
    if(!r.ok||!j||!j.metrics){ fail((j&&j.error)||'No se pudo traer de GHL, cargá a mano'); return; }
    const key=state.capMember+'|'+state.capDate;
    if(!DB.entries[key]) DB.entries[key]={};
    state.ghlFill={};
    let n=0;
    for(const k in j.metrics){ DB.entries[key][k]=+j.metrics[k].value||0; state.ghlFill[k]=j.metrics[k].source==='ghl'?'GHL':'Ventas'; n++; }
    save(); renderCapture();
    toast(n?`${n} métricas traídas — revisá y listo, se guardan solas`:'No hay nada certero para traer en este día');
  }catch(e){ fail('No se pudo traer de GHL, cargá a mano'); }
};
```

Limpieza del badge al editar a mano — agregar al inicio del cuerpo de `bump`, `setNum` y `setMoney`:

```js
  if(state.ghlFill&&state.ghlFill[k]){ delete state.ghlFill[k]; const b=document.getElementById('gb_'+k); if(b) b.remove(); }
```

Y resetear al cambiar contexto:

```js
window.setCapMember=(id)=>{ state.capMember=id; state.ghlFill=null; renderCapture(); };
window.setCapDate=(d)=>{ state.capDate=d||todayStr(); state.ghlFill=null; renderCapture(); };
```

- [ ] **Step 4: Sintaxis, subir, commit**

```bash
# node --check del <script>; scp; luego
ssh root@187.77.228.99 "cd /docker/maze-sales-tracker-dev && git add index.html && git commit -m 'feat(capture): botón Autocompletar desde GHL con badges por métrica (closers)'"
```

- [ ] **Step 5: QA e2e en dev**

Preparación (org Maze — Pruebas): dar a Johan role `closer` + `ghl_user_id='UGXlXC6BLnlAxwWEvosy'` vía SQL (revertir al final):

```sql
update st_profiles set role='closer', ghl_user_id='UGXlXC6BLnlAxwWEvosy' where name='Johan Martinez';
```

1. Cargar día como admin, miembro Johan, fecha `2026-06-30` → ⚡ Autocompletar → llamadas=1 (cita confirmed), asistencias=0, no_shows=0, badges "GHL"; cierres=0, cash=0 badges "Ventas"
2. Fecha `2026-07-03` (cita cancelled) → llamadas=0
3. Registrar venta de hoy con Johan closer + volver a Cargar día hoy → cierres=1, cash correcto ("Ventas")
4. Editar a mano un contador autocompletado → el badge desaparece
5. Miembro setter seleccionado → el botón no aparece
6. Borrar venta de prueba y revertir a Johan (role setter, ghl_user_id null); consola sin errores
