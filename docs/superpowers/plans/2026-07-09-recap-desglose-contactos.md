# Desglose de contactos por métrica en el recap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development o superpowers:executing-plans. Steps con checkbox (`- [ ]`).

**Goal:** Cada número del recap del día se expande (acordeón inline) y muestra los contactos que lo componen, con nombre + deep-link white-label a su ficha en GHL.

**Architecture:** El motor (`api/metrics.js`) ya recorre contacto por contacto para contar; deja de descartar los IDs, acumula por KPI, resuelve nombres (un fetch por contacto único) y devuelve el desglose junto a los conteos. El worker lo persiste en una columna `contacts` (JSONB) de `st_shadow_metrics`. El recap lee esa columna (`select('*')` ya la trae) y hace clickable cada número con contactos.

**Tech Stack:** Node (mini-API sin framework) + vanilla JS + Supabase (PostgREST) self-hosted en VPS. Verificación: `node --check` + greps + QA contra datos reales.

## Global Constraints

- Rama `feature/recap-desglose-contactos`.
- Deep-link white-label SIEMPRE `app.mazefunnels.com`, NUNCA `app.gohighlevel.com`.
- El motor **no cambia cómo calcula cada número** — solo deja de descartar los contactos. Los conteos existentes deben quedar idénticos.
- Retrocompat: filas viejas de `st_shadow_metrics` sin `contacts` (null) no rompen el recap (número no clickable).
- Copy español latino con tuteo. Modo sombra intacto (scheduler + `POST /api/shadow/run`).
- Base Supabase **compartida** en el VPS (`supabase.mazefunnels.io`): la migración impacta todos los tenants — usar `ADD COLUMN IF NOT EXISTS` (idempotente, no destructivo).

---

### Task 1: Migración — columna `contacts` en `st_shadow_metrics`

**Files:**
- Create: `supabase/migrations/017_shadow_contacts.sql`

**Interfaces:**
- Produces: columna `st_shadow_metrics.contacts` (JSONB, nullable) que el worker (Task 3) escribe y el recap (Task 4) lee.

- [ ] **Step 1: Escribir la migración**

Crear `supabase/migrations/017_shadow_contacts.sql`:
```sql
-- Desglose de contactos por métrica del modo sombra.
-- Cada fila (member, date, kpi) guarda, además del auto_value, la lista de
-- contactos que componen ese número: [{ id, name, count? }]. count solo cuando
-- el contacto aporta más de 1. Métricas sin contacto (tasas, montos) quedan null.
ALTER TABLE st_shadow_metrics ADD COLUMN IF NOT EXISTS contacts jsonb;
```

- [ ] **Step 2: Aplicar en la base compartida del VPS**

Aplicar el DDL contra la base Supabase self-hosted (Studio SQL editor, o psql dentro del contenedor de Postgres del VPS). Ejemplo por psql:
```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 \
  "docker exec supabase-db psql -U postgres -d postgres -c \
   'ALTER TABLE st_shadow_metrics ADD COLUMN IF NOT EXISTS contacts jsonb;'"
```
> Nota: confirmar el nombre real del contenedor de Postgres (`docker ps | grep -i db`) antes de correr; si difiere, ajustar `supabase-db`.

- [ ] **Step 3: Verificar que la columna existe**

Run:
```bash
ssh -o StrictHostKeyChecking=no root@187.77.228.99 \
  "docker exec supabase-db psql -U postgres -d postgres -c \
   \"SELECT column_name FROM information_schema.columns WHERE table_name='st_shadow_metrics' AND column_name='contacts';\""
```
Expected: una fila con `contacts`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/017_shadow_contacts.sql
git commit -m "feat(db): columna contacts (jsonb) en st_shadow_metrics para el desglose

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Motor — acumular contactos por KPI, resolver nombres, cambiar el retorno

**Files:**
- Modify: `api/metrics.js`

**Interfaces:**
- Consumes: nada nuevo (mismos `ctx`).
- Produces: `computeMemberKpis` ahora devuelve `{ values, contacts }` donde `values` es el objeto de conteos de siempre y `contacts` es `{ [kpi]: [{ id, name, count? }] }`. `kpisCitas` recibe un 5º parámetro `bump`.

- [ ] **Step 1: Agregar el acumulador de contactos y el helper de nombre**

En `computeMemberKpis`, justo después de `const out = {};` (línea ~55), agregar:
```javascript
  // Desglose de contactos por KPI: kpi -> Map(contactId -> count). Se puebla en
  // paralelo a los conteos de `out` y se resuelve a nombres al final.
  const contactsByKpi = {};
  const bump = (kpi, contactId) => {
    if (!contactId) return;
    const m = contactsByKpi[kpi] || (contactsByKpi[kpi] = new Map());
    m.set(contactId, (m.get(contactId) || 0) + 1);
  };
  const contactNames = new Map(); // contactId -> nombre (cache de los ya traídos)
  const nombreDe = (cc) => {
    const w = [cc.firstName, cc.lastName].filter(Boolean).join(' ').trim();
    return w || cc.email || cc.phone || 'Sin nombre';
  };
```

- [ ] **Step 2: Hacer que `kpisCitas` reporte contactos (closer)**

Reemplazar la función `kpisCitas` (líneas ~32-44) por:
```javascript
function kpisCitas(events, userId, { start, end }, prevShowedContacts, bump) {
  const inDay = (iso) => { const t = new Date(iso).getTime(); return t >= start && t < end; };
  const evs = events.filter((e) => !e.deleted && e.assignedUserId === userId && inDay(e.startTime));
  const st = (e) => String(e.appointmentStatus || '').toLowerCase();
  const validas = evs.filter((e) => !['cancelled', 'invalid'].includes(st(e)));
  for (const e of validas) {
    bump('llamadas', e.contactId);
    if (st(e) === 'showed') bump('asistencias', e.contactId);
    if (st(e) === 'noshow') bump('no_shows', e.contactId);
    if (prevShowedContacts.has(e.contactId)) bump('segundas', e.contactId);
  }
  for (const e of evs.filter((e) => st(e) === 'cancelled')) bump('cancelados', e.contactId);
  return {
    llamadas: validas.length,
    asistencias: validas.filter((e) => st(e) === 'showed').length,
    no_shows: validas.filter((e) => st(e) === 'noshow').length,
    cancelados: evs.filter((e) => st(e) === 'cancelled').length,
    segundas: validas.filter((e) => prevShowedContacts.has(e.contactId)).length,
  };
}
```

- [ ] **Step 3: Pasar `bump` a la llamada de `kpisCitas`**

En la rama del closer, reemplazar la línea (~80):
```javascript
    Object.assign(out, kpisCitas(ev.events || [], member.ghl_user_id, range, prevShowed));
```
por:
```javascript
    Object.assign(out, kpisCitas(ev.events || [], member.ghl_user_id, range, prevShowed, bump));
```

- [ ] **Step 4: Cachear el nombre del contacto de WhatsApp ya traído (setter)**

En el bloque WhatsApp del loop setter, donde ya se hace el fetch del contacto (líneas ~122-128), después de `const cc = contact.contact || {};` agregar el cacheo del nombre:
```javascript
        if (c.contactId) contactNames.set(c.contactId, nombreDe(cc));
```
(Reutiliza el fetch que ya se hace para el canal; evita re-pedirlo al resolver nombres.)

- [ ] **Step 5: Registrar contactos en cada conteo del setter**

En el loop setter, agregar un `bump(...)` con `c.contactId` junto a cada `out.X++`. Reemplazar el bloque de conteos (líneas ~129-151) por:
```javascript
      // apertura: primer mensaje histórico saliente humano y de hoy
      if (humanOut(msgs[0]) && inDay(msgs[0].dateAdded)) { if (isTk) { out.outbound_tk++; bump('outbound_tk', c.contactId); } else { out.outbound++; bump('outbound', c.contactId); } }
      // bienvenida: apertura automática (ManyChat) de hoy — solo IG (donde corre ManyChat)
      if (isIg && autoOut(msgs[0]) && inDay(msgs[0].dateAdded)) { out.bienvenidas++; bump('bienvenidas', c.contactId); }
      // inbound: PERSONAS (conversaciones únicas con entrante hoy)
      if (todays.some((m) => m.direction === 'inbound')) {
        if (isIg) { out.inbound_ig++; bump('inbound_ig', c.contactId); }
        if (isTk) { out.inbound_tk++; bump('inbound_tk', c.contactId); } // DM nativo de TikTok
        if (isWa) {
          if (waCanal === 'tk') { out.inbound_wpp_tk++; bump('inbound_wpp_tk', c.contactId); }
          else if (waCanal === 'ig') { out.inbound_wpp_ig++; bump('inbound_wpp_ig', c.contactId); }
          else { out.inbound_wpp_sin_canal++; bump('inbound_wpp_sin_canal', c.contactId); }
        }
      }
      // respuestas: entrante de hoy posterior a un saliente humano previo
      const outTimes = msgs.filter(humanOut).map((m) => new Date(m.dateAdded).getTime());
      if (todays.some((m) => m.direction === 'inbound' && outTimes.some((t) => t < new Date(m.dateAdded).getTime()))) { if (isTk) { out.resp_tk++; bump('resp_tk', c.contactId); } else { out.respuestas++; bump('respuestas', c.contactId); } }
      // seguimiento: saliente humano de hoy en conversación que NO abrió hoy
      if (!inDay(msgs[0].dateAdded) && todays.some(humanOut)) {
        if (isIg) { out.seg_ig++; bump('seg_ig', c.contactId); } else if (isWa) { out.seg_wpp++; bump('seg_wpp', c.contactId); } else if (isTk) { out.seg_tk++; bump('seg_tk', c.contactId); }
      }
      // links de agenda enviados hoy (content-match del dominio de la org)
      if (domRe) {
        const n = todays.filter((m) => humanOut(m) && domRe.test(m.body || '')).length;
        if (isIg) out.links_ig += n; else if (isWa) out.links_wpp += n;
        if (n > 0 && (isIg || isWa)) {
          linkedContacts.set(c.contactId, isIg ? 'ig' : 'wpp');
          for (let k = 0; k < n; k++) bump(isIg ? 'links_ig' : 'links_wpp', c.contactId); // count = nº de links
        }
      }
```

- [ ] **Step 6: Registrar contactos en las agendas (setter)**

En el cruce de agendas, donde hoy hace `out.agend_ig++` / `out.agend_wpp++` (líneas ~176), agregar el bump. Reemplazar:
```javascript
          if (canal === 'ig') out.agend_ig++; else out.agend_wpp++;
          linkedContacts.delete(e.contactId); // una agenda por contacto linkeado (en cualquier calendario)
```
por:
```javascript
          if (canal === 'ig') { out.agend_ig++; bump('agend_ig', e.contactId); } else { out.agend_wpp++; bump('agend_wpp', e.contactId); }
          linkedContacts.delete(e.contactId); // una agenda por contacto linkeado (en cualquier calendario)
```

- [ ] **Step 7: Resolver nombres faltantes y armar el desglose; cambiar los returns**

Reemplazar el return final `return out;` (línea ~175) por:
```javascript
  // Resolver nombres de los contactos únicos que aún no tenemos cacheados.
  const faltan = new Set();
  for (const m of Object.values(contactsByKpi)) for (const id of m.keys()) if (!contactNames.has(id)) faltan.add(id);
  for (const id of faltan) {
    const cr = await ghlFetch(`${ghlBase}/contacts/${encodeURIComponent(id)}`, H);
    contactNames.set(id, nombreDe(cr.contact || {}));
  }
  const contacts = {};
  for (const [kpi, m] of Object.entries(contactsByKpi)) {
    contacts[kpi] = [...m.entries()].map(([id, count]) => {
      const base = { id, name: contactNames.get(id) || 'Sin nombre' };
      return count > 1 ? { ...base, count } : base;
    });
  }
  return { values: out, contacts };
```

Y el return temprano (sin GHL, línea ~70) `return out;` cambiarlo por:
```javascript
  if (!member.ghl_user_id || !token) return { values: out, contacts: {} }; // sin vínculo GHL: solo KPIs internos
```

- [ ] **Step 8: Verificar**

Run: `node --check api/metrics.js && grep -q "return { values: out, contacts }" api/metrics.js && grep -c "bump(" api/metrics.js`
Expected: sin error; el conteo de `bump(` es ≥ 20 (una por cada conteo instrumentado + la firma).

- [ ] **Step 9: Commit**

```bash
git add api/metrics.js
git commit -m "feat(sombra): el motor emite el desglose de contactos por métrica

Acumula los contactId de cada conteo (setter + closer), resuelve nombres con
un fetch por contacto único (reusa el de WhatsApp), y devuelve
{ values, contacts }. Los conteos no cambian.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Worker — persistir `contacts` en `st_shadow_metrics`

**Files:**
- Modify: `api/server.js` — `runShadowForOrg`

**Interfaces:**
- Consumes: el nuevo retorno `{ values, contacts }` de `computeMemberKpis`.
- Produces: cada fila del upsert a `st_shadow_metrics` lleva `contacts`.

- [ ] **Step 1: Desestructurar el nuevo retorno**

En `runShadowForOrg`, donde se declara e invoca el motor (líneas ~734-738):
```javascript
    let kpis = {};
    try {
      kpis = await computeMemberKpis({
```
reemplazar por:
```javascript
    let kpis = {}, kpiContacts = {};
    try {
      const kpiResult = await computeMemberKpis({
```
y, cerrando la llamada, después del objeto de `ctx` (la línea `});` que cierra `computeMemberKpis({...})`), agregar:
```javascript
      kpis = kpiResult.values;
      kpiContacts = kpiResult.contacts;
```

- [ ] **Step 2: Adjuntar `contacts` a cada fila del upsert**

En el push de filas (línea ~746), reemplazar:
```javascript
      rows.push({ org_id: orgId, member_id: m.id, metric_date: date, kpi, auto_value: val, manual_value: manual[kpi] == null ? null : +manual[kpi], computed_at: new Date().toISOString() });
```
por:
```javascript
      rows.push({ org_id: orgId, member_id: m.id, metric_date: date, kpi, auto_value: val, manual_value: manual[kpi] == null ? null : +manual[kpi], contacts: kpiContacts[kpi] || null, computed_at: new Date().toISOString() });
```

- [ ] **Step 3: Verificar**

Run: `node --check api/server.js && grep -q "kpiContacts = kpiResult.contacts" api/server.js && grep -q "contacts: kpiContacts\[kpi\] || null" api/server.js`
Expected: sin error.

- [ ] **Step 4: Commit**

```bash
git add api/server.js
git commit -m "feat(sombra): el worker persiste el desglose de contactos por métrica

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — acordeón inline de contactos en el recap

**Files:**
- Modify: `index.html` — `recapHoy` + un handler global de toggle

**Interfaces:**
- Consumes: `r.contacts` (array `[{id, name, count?}]`) de cada fila de `st_shadow_metrics` (ya llega vía `select('*')`), y la variable global `GHL_LOC` (locationId de la org, ya usada en Ventas).
- Produces: chips clickables + acordeón con deep-links a GHL.

- [ ] **Step 1: Hacer clickable cada chip con contactos + agregar el panel**

En `recapHoy`, reemplazar el `detalle=conAlgo.map(...)` (líneas ~2133-2136) por:
```javascript
      detalle=conAlgo.map(r=>{
        const mismatch=r.manual_value!=null && +r.manual_value!==+r.auto_value;
        const cs=Array.isArray(r.contacts)?r.contacts:[];
        const rid=`rc_${esc(m.id)}_${esc(r.kpi)}`;
        const chip=`<span class="chip${cs.length?' rc-click':''}" ${cs.length?`onclick="toggleRecapContacts('${rid}')" style="cursor:pointer;${mismatch?'border-color:#ff6b6b;color:#ff6b6b':''}"`:`style="${mismatch?'border-color:#ff6b6b;color:#ff6b6b':''}"`}>${esc(r.kpi)}: <b>${+r.auto_value}</b>${r.manual_value!=null?` / manual ${+r.manual_value}`:''}${cs.length?' ▾':''}</span>`;
        const panel=cs.length?`<div id="${rid}" class="rc-panel" style="display:none;flex-basis:100%;margin:2px 0 6px;padding-left:8px">${cs.map(c=>`<a href="https://app.mazefunnels.com/v2/location/${esc(GHL_LOC)}/contacts/detail/${esc(c.id)}" target="_blank" rel="noopener" style="display:inline-block;margin:2px 8px 2px 0;font-size:12px">${esc(c.name)}${c.count?` ×${c.count}`:''} 🔗</a>`).join('')}</div>`:'';
        return chip+panel;
      }).join(' ');
```

- [ ] **Step 2: Agregar el handler global de toggle**

Junto a los otros `window.*` del modo sombra (después de `window.setBookingDomains`, línea ~2193), agregar:
```javascript
window.toggleRecapContacts=(id)=>{ const el=document.getElementById(id); if(el) el.style.display=el.style.display==='none'?'block':'none'; };
```

- [ ] **Step 3: Verificar**

Run: `grep -q "toggleRecapContacts" index.html && grep -q "contacts/detail" index.html && node -e "const h=require('fs').readFileSync('index.html','utf8');const o=(h.match(/<script/g)||[]).length,c=(h.match(/<\/script>/g)||[]).length;console.log(o===c?'OK':'DESBALANCE')"`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(sombra): recap con acordeón de contactos por métrica + link a GHL

Cada número con contactos se abre y lista nombre + deep-link white-label a
la ficha del contacto en HighLevel.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 (checkpoint human-verify, blocking): QA real del desglose

- [ ] **Step 1: Deploy a pruebas** (merge de la rama → develop; deploy automático a `sales-tracker-test.mazefunnels.io`).
- [ ] **Step 2:** En una org con GHL conectado y actividad real, correr **"Recap del día"**.
- [ ] **Step 3:** En el recap, tocar un número con actividad (ej. `inbound_ig`, `agend_ig`, `respuestas`): debe desplegar la lista de contactos con nombre; cada uno abre su ficha en HighLevel (`app.mazefunnels.com`). Confirmar que la cantidad de contactos coincide con el número (con `×count` donde aplica) y que los links llevan al contacto correcto.

**Resume-signal:** "aprobado" o describir qué no cuadró.

---

## Self-Review

**Spec coverage:** columna `contacts` (Task 1) ✓ · motor acumula por KPI + nombres dedup + retorno `{values,contacts}` (Task 2) ✓ · worker persiste (Task 3) ✓ · acordeón inline nombre+link white-label (Task 4) ✓ · QA real (Task 5) ✓ · fuera de alcance (histórica/backfill/montos) respetado — el motor solo instrumenta métricas contables por contacto, los montos (`cash_nuevo`/`revenue`/`reservas`) y las tasas nunca llaman `bump`, quedan sin `contacts`.

**Placeholder scan:** todo el código va literal (motor, worker, front). Sin TODOs. La migración es idempotente.

**Type consistency:** `contactsByKpi` (Map interno) → `contacts` (`{kpi:[{id,name,count?}]}`, retorno) → `kpiContacts[kpi]` (worker) → `contacts` columna JSONB → `r.contacts` (front). `computeMemberKpis` devuelve `{values, contacts}` en ambos returns (early y final); el único caller (`runShadowForOrg`) desestructura ambos. `kpisCitas` gana el 5º parámetro `bump` y la única llamada lo pasa.

**Nota:** los conteos de `out` no cambian en ningún paso — cada `bump` es aditivo al lado del `out.X++` existente. El QA de Task 5 confirma que los números siguen coincidiendo.
