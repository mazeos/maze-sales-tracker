# Auto-carga Fase A: motor sombra + panel de calibración — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job nocturno que calcula los KPIs auto de closer y setter por miembro/día, los guarda como sombra junto al valor manual, y un panel de calibración solo-admin para compararlos. NO escribe en los contadores (eso es Fase B).

**Architecture:** Módulo de cálculo `api/metrics.js` (lógica portada del prototipo `sombra.js` validado hoy) + scheduler dentro del proceso de la mini-API + endpoint de corrida manual + 2 tablas (`st_shadow_metrics`, `st_kpi_config`). El panel lee las tablas directo por supabase-js (RLS).

**Tech Stack:** Postgres (supabase-db), Node 22 sin deps (mini-API), vanilla JS (index.html).

**Spec:** `docs/superpowers/specs/2026-07-05-autocarga-sombra-design.md` · **Prototipo validado:** `/root/sombra.js` (VPS)

## Global Constraints

- Repo `/docker/maze-sales-tracker-dev`, rama `develop`; `git status` limpio antes de tocar `index.html`/`server.js`.
- GHL NO respeta `startTime`/`endTime` del query de eventos → SIEMPRE re-filtrar por fecha client-side en la TZ de la org.
- Solo mensajes humanos (`source: 'app'` o sin source) cuentan para el setter; `workflow` = automatización, fuera.
- Fase A NUNCA escribe `st_entries` — sombra pura.
- `st_shadow_metrics` la escribe SOLO el service role (el worker); clientes solo SELECT de su org.
- Split WhatsApp tk/ig: por `utm_source` del contacto (custom field, Estándar UTM del vault) con fallback a tag `origen:*`; sin señal → KPI sombra `inbound_wpp_sin_canal` (informativo, no existe en el tracker).
- Rate-limit friendly: throttle de ~10 req/s a GHL, reintento único en 429.
- Validar server.js con `node --check` y el JS del index con extracción de `<script>` + `node --check`. Rebuild api tras tocar server: `docker compose -f docker-compose.dev.yml up -d --build api`.

---

### Task 1: Migración 012 — tablas de sombra y configuración de KPIs

**Files:**
- Create: `supabase/migrations/012_shadow.sql`

**Interfaces:**
- Produces: `st_shadow_metrics(org_id, member_id, metric_date, kpi, auto_value numeric, manual_value numeric null, computed_at)` unique por (member_id, metric_date, kpi); `st_kpi_config(org_id, kpi, status 'sombra'|'auto'|'off', config jsonb)` unique por (org_id, kpi). La fila especial `kpi='_config'` guarda config de la org (`{booking_domains: []}`).

- [ ] **Step 1: Escribir la migración**

```sql
-- ============================================================
-- Maze Sales Tracker IA — Auto-carga Fase A: modo sombra
-- st_shadow_metrics: valor auto calculado vs valor manual, por member/día/kpi.
--   La escribe SOLO el worker (service role). Nunca pisa st_entries en Fase A.
-- st_kpi_config: estado por KPI de la org (sombra|auto|off) + fila '_config'
--   con configuración general ({booking_domains: [...]}).
-- Idempotente.
-- ============================================================

create table if not exists public.st_shadow_metrics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  member_id uuid not null references public.st_profiles(id) on delete cascade,
  metric_date date not null,
  kpi text not null,
  auto_value numeric not null default 0,
  manual_value numeric,
  computed_at timestamptz default now(),
  unique (member_id, metric_date, kpi)
);
create index if not exists st_shadow_org_date on public.st_shadow_metrics(org_id, metric_date);
create index if not exists st_shadow_org_kpi on public.st_shadow_metrics(org_id, kpi, metric_date);

create table if not exists public.st_kpi_config (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.st_orgs(id) on delete cascade,
  kpi text not null,
  status text not null default 'sombra' check (status in ('sombra','auto','off')),
  config jsonb not null default '{}'::jsonb,
  unique (org_id, kpi)
);

-- RLS: la sombra la ven todos los de la org, la escribe solo el service role.
alter table public.st_shadow_metrics enable row level security;
drop policy if exists st_shadow_sel on public.st_shadow_metrics;
create policy st_shadow_sel on public.st_shadow_metrics for select using (org_id = public.st_my_org());

-- st_kpi_config: ven todos; escribe el admin (switches y config de la org).
alter table public.st_kpi_config enable row level security;
drop policy if exists st_kcfg_sel on public.st_kpi_config;
create policy st_kcfg_sel on public.st_kpi_config for select using (org_id = public.st_my_org());
drop policy if exists st_kcfg_ins on public.st_kpi_config;
create policy st_kcfg_ins on public.st_kpi_config for insert with check (org_id = public.st_my_org() and public.st_is_admin());
drop policy if exists st_kcfg_upd on public.st_kpi_config;
create policy st_kcfg_upd on public.st_kpi_config for update using (org_id = public.st_my_org() and public.st_is_admin());
```

- [ ] **Step 2: Aplicar y verificar**

```bash
docker exec -i supabase-db psql -U postgres -d postgres < /docker/maze-sales-tracker-dev/supabase/migrations/012_shadow.sql
docker exec supabase-db psql -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema';"
docker exec supabase-db psql -U postgres -d postgres -tc "select count(*) from pg_policies where tablename in ('st_shadow_metrics','st_kpi_config');"
```

Expected: `4` políticas (1 + 3).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/012_shadow.sql && git commit -m "feat(sombra): tablas st_shadow_metrics y st_kpi_config"
```

---

### Task 2: Módulo de cálculo `api/metrics.js`

**Files:**
- Create: `api/metrics.js`

**Interfaces:**
- Consumes: nada del server (módulo puro): recibe `{ghlBase, token, locationId, calendarId, tz, date, member:{id, role, ghl_user_id}, salesRows, cuotasRows, bookingDomains}`.
- Produces: `export async function computeMemberKpis(ctx)` → `{kpi: valor}` (solo los KPIs del rol) y `export function tzDayRange(dateStr, tz)`. El server (Task 3) los importa.

- [ ] **Step 1: Escribir el módulo** (lógica portada del prototipo validado + paginación + split UTM)

Contenido completo de `api/metrics.js`:

```js
// metrics.js — Cálculo de KPIs auto del Maze Sales Tracker (Fase A: modo sombra).
// Lógica validada KPI por KPI el 2026-07-05 contra escenarios simulados y datos
// reales (prototipo /root/sombra.js). Módulo puro: recibe contexto, devuelve valores.
// REGLA DE ORO: GHL no respeta startTime/endTime del query — re-filtrar SIEMPRE
// client-side en la TZ de la org. Solo mensajes humanos (source app) cuentan.

export function tzDayRange(dateStr, tz) {
  const utcMidnight = new Date(dateStr + 'T00:00:00Z').getTime();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMidnight)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const start = utcMidnight - (asUtc - utcMidnight);
  return { start, end: start + 86400000 };
}

// throttle simple: ~10 req/s + 1 reintento en 429
let lastReq = 0;
async function ghlFetch(url, headers) {
  const wait = Math.max(0, lastReq + 100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  let res = await fetch(url, { headers });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    lastReq = Date.now();
    res = await fetch(url, { headers });
  }
  return res.json().catch(() => ({}));
}

function kpisCitas(events, userId, { start, end }, prevShowedContacts) {
  const inDay = (iso) => { const t = new Date(iso).getTime(); return t >= start && t < end; };
  const evs = events.filter((e) => !e.deleted && e.assignedUserId === userId && inDay(e.startTime));
  const st = (e) => String(e.appointmentStatus || '').toLowerCase();
  const validas = evs.filter((e) => !['cancelled', 'invalid'].includes(st(e)));
  return {
    llamadas: validas.length,
    asistencias: validas.filter((e) => st(e) === 'showed').length,
    no_shows: validas.filter((e) => st(e) === 'noshow').length,
    cancelados: evs.filter((e) => st(e) === 'cancelled').length,
    segundas: validas.filter((e) => prevShowedContacts.has(e.contactId)).length,
  };
}

// Canal de una conversación / origen de contacto WhatsApp
const IG_TYPES = new Set(['TYPE_INSTAGRAM']);
const WA_TYPES = new Set(['TYPE_WHATSAPP', 'TYPE_SMS', 'TYPE_CUSTOM_SMS']);
const TK_TYPES = new Set(['TYPE_TIKTOK']);

export async function computeMemberKpis(ctx) {
  const { ghlBase, token, locationId, calendarId, tz, date, member, salesRows, cuotasRows, bookingDomains } = ctx;
  const H = { Authorization: 'Bearer ' + token, Version: '2021-04-15', Accept: 'application/json' };
  const range = tzDayRange(date, tz);
  const inDay = (iso) => { const t = new Date(iso).getTime(); return t >= range.start && t < range.end; };
  const out = {};

  // ---------- Ventas y cuotas (fuente: el propio tracker, filas ya provistas) ----------
  if (member.role === 'closer') {
    const mySales = salesRows.filter((s) => s.closer_id === member.id && s.sale_date === date);
    out.cierres = mySales.length;
    out.cash_nuevo = mySales.reduce((a, s) => a + (+s.cash || 0), 0);
    out.reservas = mySales.reduce((a, s) => a + (+s.reserva || 0), 0);
    out.revenue = mySales.reduce((a, s) => a + (+s.facturado || 0), 0);
    const mySaleIds = new Set(salesRows.filter((s) => s.closer_id === member.id).map((s) => s.id));
    out.cash_cuotas = cuotasRows
      .filter((c) => c.status === 'pagada' && c.paid_date === date && mySaleIds.has(c.sale_id))
      .reduce((a, c) => a + (+c.paid_amount || 0), 0);
  }

  if (!member.ghl_user_id) return out; // sin vínculo GHL: solo KPIs internos

  // ---------- Citas (closer) ----------
  if (member.role === 'closer' && calendarId) {
    const ev = await ghlFetch(`${ghlBase}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${range.start}&endTime=${range.end}`, H);
    const prevEv = await ghlFetch(`${ghlBase}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${range.start - 30 * 86400000}&endTime=${range.start}`, H);
    const prevShowed = new Set((prevEv.events || [])
      .filter((e) => !e.deleted && new Date(e.startTime).getTime() < range.start && String(e.appointmentStatus || '').toLowerCase() === 'showed')
      .map((e) => e.contactId));
    Object.assign(out, kpisCitas(ev.events || [], member.ghl_user_id, range, prevShowed));
  }

  // ---------- Conversaciones (setter) ----------
  if (member.role === 'setter') {
    Object.assign(out, { outbound: 0, inbound_ig: 0, inbound_wpp_tk: 0, inbound_wpp_ig: 0, inbound_wpp_sin_canal: 0, respuestas: 0, seg_ig: 0, seg_wpp: 0, links_ig: 0, links_wpp: 0 });
    // paginación por startAfterDate hasta cubrir el día (+7 días de margen hacia atrás)
    let all = [], cursor = null;
    for (let page = 0; page < 20; page++) {
      const url = `${ghlBase}/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=100&sortBy=last_message_date&sort=desc` + (cursor ? `&startAfterDate=${cursor}` : '');
      const res = await ghlFetch(url, H);
      const convs = res.conversations || [];
      if (!convs.length) break;
      all.push(...convs);
      const oldest = convs[convs.length - 1].lastMessageDate;
      if (oldest < range.start) break; // ya cubrimos el día
      cursor = oldest;
    }
    // toda conversación con actividad desde el inicio del día (los mensajes se
    // re-filtran por inDay adentro; una conversación con actividad posterior
    // también puede contener mensajes del día pedido)
    const mias = all.filter((c) => c.lastMessageDate >= range.start && c.assignedTo === member.ghl_user_id);
    const humanOut = (m) => m.direction === 'outbound' && (m.source === 'app' || !m.source);
    const domRe = bookingDomains && bookingDomains.length
      ? new RegExp(bookingDomains.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
      : null;
    for (const c of mias) {
      const mm = await ghlFetch(`${ghlBase}/conversations/${encodeURIComponent(c.id)}/messages?limit=100`, H);
      const msgs = ((mm.messages && mm.messages.messages) || []).slice().sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
      if (!msgs.length) continue;
      const todays = msgs.filter((m) => inDay(m.dateAdded));
      if (!todays.length) continue;
      const type = msgs[0].messageType || c.lastMessageType || '';
      const isIg = IG_TYPES.has(type), isWa = WA_TYPES.has(type), isTk = TK_TYPES.has(type);
      // canal WhatsApp por utm_source del contacto (estándar UTM) con fallback a tag origen:*
      let waCanal = null;
      if (isWa) {
        const contact = await ghlFetch(`${ghlBase}/contacts/${encodeURIComponent(c.contactId)}`, H);
        const cc = contact.contact || {};
        const cf = (cc.customFields || []).find((f) => String(f.key || f.name || '').toLowerCase().includes('utm_source'));
        const src = String((cf && cf.value) || (cc.tags || []).find((t) => t.startsWith('origen:')) || '').toLowerCase();
        if (src.includes('tiktok')) waCanal = 'tk'; else if (src.includes('instagram')) waCanal = 'ig';
      }
      // apertura: primer mensaje histórico saliente humano y de hoy
      if (humanOut(msgs[0]) && inDay(msgs[0].dateAdded)) out.outbound++;
      // inbound: PERSONAS (conversaciones únicas con entrante hoy)
      if (todays.some((m) => m.direction === 'inbound')) {
        if (isIg) out.inbound_ig++;
        // isTk (TYPE_TIKTOK, DM nativo): aún no existe como métrica del tracker — se ignora en Fase A
        if (isWa) { if (waCanal === 'tk') out.inbound_wpp_tk++; else if (waCanal === 'ig') out.inbound_wpp_ig++; else out.inbound_wpp_sin_canal++; }
      }
      // respuestas: entrante de hoy posterior a un saliente humano previo
      const outTimes = msgs.filter(humanOut).map((m) => new Date(m.dateAdded).getTime());
      if (todays.some((m) => m.direction === 'inbound' && outTimes.some((t) => t < new Date(m.dateAdded).getTime()))) out.respuestas++;
      // seguimiento: saliente humano de hoy en conversación que NO abrió hoy
      if (!inDay(msgs[0].dateAdded) && todays.some(humanOut)) {
        if (isIg) out.seg_ig++; else if (isWa) out.seg_wpp++;
      }
      // links de agenda enviados hoy
      if (domRe) {
        const n = todays.filter((m) => humanOut(m) && domRe.test(m.body || '')).length;
        if (isIg) out.links_ig += n; else if (isWa) out.links_wpp += n;
      }
    }
  }

  return out;
}
```

- [ ] **Step 2: Sintaxis + commit**

```bash
node --check api/metrics.js
git add api/metrics.js && git commit -m "feat(sombra): módulo de cálculo de KPIs auto (closer + setter)"
```

---

### Task 3: Worker en la mini-API — scheduler nocturno + corrida manual

**Files:**
- Modify: `api/server.js` — import de metrics.js arriba, funciones nuevas junto a `captureGhl`, ruta `POST /api/shadow/run`, scheduler al final (antes del `server.listen`), doc del header

**Interfaces:**
- Consumes: `computeMemberKpis`, `tzDayRange` (Task 2); helpers existentes `getGhlCreds`, `svcHeaders`, `sendJSON`, `requireAdmin`, `GHL_BASE`, `GHL_CALENDAR`, `SUPABASE_URL`.
- Produces: `runShadowForOrg(orgId, dateStr)` → `{org_id, date, members, rows}`; `POST /api/shadow/run` body `{date?}` (admin; default = hoy en TZ de la org) → ese resumen.

- [ ] **Step 1: Import + lógica del worker**

Arriba de server.js (junto a los imports):

```js
import { computeMemberKpis, tzDayRange } from './metrics.js';
```

Funciones nuevas (después de `captureGhl`):

```js
// ---------- Auto-carga Fase A: modo sombra ----------
// Calcula los KPIs auto de cada miembro (closer/setter) y los guarda en
// st_shadow_metrics JUNTO al valor manual del momento. NO toca st_entries.
async function svcGet(pathq) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + pathq, { headers: svcHeaders() });
  return r.status === 200 ? r.json().catch(() => []) : [];
}

async function runShadowForOrg(orgId, dateStr) {
  const orgs = await svcGet('st_orgs?id=eq.' + encodeURIComponent(orgId) + '&select=id,tz');
  const org = orgs[0];
  if (!org) throw new Error('org inexistente');
  const tz = org.tz || 'America/Argentina/Buenos_Aires';
  const date = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

  let creds = null;
  try { creds = await getGhlCreds(orgId); } catch { /* sin GHL: solo KPIs internos */ }
  const calendarId = (creds && creds.integration && creds.integration.calendar_id) || GHL_CALENDAR || null;

  const members = await svcGet('st_profiles?org_id=eq.' + encodeURIComponent(orgId)
    + '&select=id,role,ghl_user_id,active&role=in.(closer,setter)');
  const activos = members.filter((m) => m.active !== false);
  const salesRows = await svcGet('st_sales?org_id=eq.' + encodeURIComponent(orgId) + '&select=id,closer_id,sale_date,cash,reserva,facturado');
  const cuotasRows = await svcGet('st_cuotas?org_id=eq.' + encodeURIComponent(orgId) + '&select=sale_id,status,paid_date,paid_amount');
  const cfgRows = await svcGet('st_kpi_config?org_id=eq.' + encodeURIComponent(orgId) + "&kpi=eq._config&select=config");
  const bookingDomains = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.booking_domains) || [];

  const rows = [];
  for (const m of activos) {
    let kpis = {};
    try {
      kpis = await computeMemberKpis({
        ghlBase: GHL_BASE, token: creds ? creds.token : null, locationId: creds ? creds.locationId : null,
        calendarId: creds ? calendarId : null, tz, date, member: m, salesRows, cuotasRows, bookingDomains,
      });
    } catch (e) {
      console.warn('[shadow] member', m.id, 'falló:', e.message);
      continue;
    }
    // valor manual del momento (st_entries)
    const ents = await svcGet('st_entries?member_id=eq.' + encodeURIComponent(m.id) + '&entry_date=eq.' + encodeURIComponent(date) + '&select=metrics');
    const manual = (ents[0] && ents[0].metrics) || {};
    for (const [kpi, val] of Object.entries(kpis)) {
      rows.push({ org_id: orgId, member_id: m.id, metric_date: date, kpi, auto_value: val, manual_value: manual[kpi] == null ? null : +manual[kpi], computed_at: new Date().toISOString() });
    }
  }
  if (rows.length) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/st_shadow_metrics?on_conflict=member_id,metric_date,kpi', {
      method: 'POST',
      headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(rows),
    });
    if (r.status >= 300) throw new Error('upsert sombra falló: ' + r.status);
  }
  return { org_id: orgId, date, members: activos.length, rows: rows.length };
}

async function shadowRun(req, res, admin) {
  const parsed = await readJSON(req);
  const date = parsed.ok && parsed.data && parsed.data.date ? String(parsed.data.date) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, 400, { error: 'Fecha inválida' });
  try {
    const summary = await runShadowForOrg(admin.org_id, date);
    return sendJSON(res, 200, { ok: true, ...summary });
  } catch (e) {
    return sendJSON(res, 502, { error: 'La corrida sombra falló: ' + e.message });
  }
}

// Scheduler: cada 10 min revisa qué orgs están en su ventana 23:40–23:59 local
// y corre la sombra del día (una vez por org por fecha, control en memoria).
const shadowLastRun = new Map(); // orgId -> 'YYYY-MM-DD'
async function shadowTick() {
  try {
    const orgs = await svcGet('st_orgs?select=id,tz');
    for (const o of orgs) {
      const tz = o.tz || 'America/Argentina/Buenos_Aires';
      const now = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date());
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      const [hh, mm] = now.split(':').map(Number);
      if (hh === 23 && mm >= 40 && shadowLastRun.get(o.id) !== today) {
        shadowLastRun.set(o.id, today);
        runShadowForOrg(o.id, today).then((s) => console.log('[shadow]', o.id, s.rows, 'filas')).catch((e) => console.warn('[shadow]', o.id, e.message));
      }
    }
  } catch (e) { console.warn('[shadow] tick falló:', e.message); }
}
setInterval(shadowTick, 10 * 60 * 1000);
```

(Si el helper de body se llama distinto a `readJSON`, usar el que ya exista en server.js para POSTs.)

- [ ] **Step 2: Ruta + doc del header**

```js
    if (req.method === 'POST' && path === '/api/shadow/run') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return shadowRun(req, res, admin);
    }
```

Header: `//   POST   /api/shadow/run         -> corre la sombra de auto-carga de la org (admin; body {date?})`

- [ ] **Step 3: Sintaxis, deploy, smoke, commit**

```bash
node --check api/server.js
docker compose -f docker-compose.dev.yml up -d --build api
curl -s -o /dev/null -w '%{http_code}' -X POST https://sales-tracker-test.mazefunnels.io/api/shadow/run   # sin auth
git add api/server.js && git commit -m "feat(sombra): worker nocturno + POST /api/shadow/run"
```

Expected: `401`.

---

### Task 4: Panel de calibración en Configuraciones (solo admin)

**Files:**
- Modify: `index.html` — sección nueva en `renderTeam` (después de `${ghlCard()}${ghlTeamCard()}`), funciones junto a las de Configuraciones

**Interfaces:**
- Consumes: `st_shadow_metrics` y `st_kpi_config` vía supabase-js (RLS), `IS_ADMIN`, `ME`, `esc()`, `info()`, `toast()`, clases `section/eyebrow/rollup/btn/chip`, `.cuo-est` badges.
- Produces: `calibracionCard()` (html), `window.runShadow()`, `window.setBookingDomains(v)`.

- [ ] **Step 1: Card + lógica**

En `renderTeam`, sumar `${IS_ADMIN ? calibracionCard() : ''}` al final del template (tras `${ghlTeamCard()}`), y las funciones:

```js
// ---------- Panel de calibración (auto-carga en sombra, Fase A) ----------
let SHADOW=null, SHADOW_LOADING=false, KPI_CFG=null;
async function loadShadow(){
  if(SHADOW_LOADING) return; SHADOW_LOADING=true;
  const desde=dstr(new Date(Date.now()-14*86400000));
  const [sm,kc]=await Promise.all([
    sb.from('st_shadow_metrics').select('*').eq('org_id',ME.org_id).gte('metric_date',desde),
    sb.from('st_kpi_config').select('*').eq('org_id',ME.org_id),
  ]);
  SHADOW=sm.data||[]; KPI_CFG=kc.data||[]; SHADOW_LOADING=false;
  if(state.view==='team') renderTeam();
}
function calibracionCard(){
  if(SHADOW===null){ loadShadow(); return `<div class="section"><div class="eyebrow">Auto-carga (modo sombra)</div><p style="color:var(--muted);font-size:13px;margin:0">Cargando calibración…</p></div>`; }
  const cfgRow=(KPI_CFG||[]).find(k=>k.kpi==='_config');
  const doms=((cfgRow&&cfgRow.config&&cfgRow.config.booking_domains)||[]).join(', ');
  const byKpi={};
  SHADOW.forEach(r=>{ (byKpi[r.kpi]=byKpi[r.kpi]||[]).push(r); });
  let rows='';
  Object.keys(byKpi).sort().forEach(k=>{
    const rs=byKpi[k].sort((a,b)=>a.metric_date<b.metric_date?1:-1);
    const comparables=rs.filter(r=>r.manual_value!=null);
    const matches=comparables.filter(r=>+r.auto_value===+r.manual_value);
    const pct=comparables.length?Math.round(matches.length/comparables.length*100):null;
    let racha=0; for(const r of rs){ if(r.manual_value!=null && +r.auto_value===+r.manual_value) racha++; else break; }
    const ult=rs[0];
    const chip=pct===null?`<span class="cuo-est">sin datos manuales</span>`:(pct>=90?`<span class="cuo-est paga">${pct}% match</span>`:`<span class="cuo-est venc">${pct}% match</span>`);
    rows+=`<tr><td style="text-align:left">${esc(k)}</td><td>${ult?ult.metric_date:'—'}</td><td>${ult?+ult.auto_value:'—'}</td><td>${ult&&ult.manual_value!=null?+ult.manual_value:'—'}</td><td>${chip}</td><td>${racha} días</td></tr>`;
  });
  if(!rows) rows=`<tr><td colspan="6" class="empty">Sin corridas todavía. Tocá "Correr ahora" para la primera.</td></tr>`;
  return `<div class="section"><div class="eyebrow">Auto-carga (modo sombra) ${info('El motor calcula cada KPI desde GHL y el tracker, y lo compara con lo cargado a mano. Nada se escribe en los contadores: esto es solo calibración. Cuando un KPI venga clavado varios días, en la Fase B vas a poder graduarlo a automático.')}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <button class="btn sm" onclick="runShadow()" id="shadowBtn">Correr ahora</button>
      <input class="inp" style="max-width:340px" placeholder="Dominios de agenda (coma): agendar.mazefunnels.io" value="${esc(doms)}" onchange="setBookingDomains(this.value)" data-tip="Para contar links de agenda enviados por el setter.">
    </div>
    <div class="rollup"><table>
      <thead><tr><th style="text-align:left">KPI</th><th>Último día</th><th>Auto</th><th>Manual</th><th>Match 14d</th><th>Racha</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
}
window.runShadow=async()=>{
  const btn=document.getElementById('shadowBtn'); if(btn){ btn.disabled=true; btn.textContent='Corriendo…'; }
  try{
    const {data:{session}}=await sb.auth.getSession();
    const r=await fetch('/api/shadow/run',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},body:JSON.stringify({})});
    const j=await r.json().catch(()=>null);
    if(!r.ok){ toast((j&&j.error)||'Falló la corrida'); }
    else toast(`Sombra corrida: ${j.rows} valores de ${j.members} miembros`);
  }catch(e){ toast('Falló la corrida'); }
  SHADOW=null; renderTeam();
};
window.setBookingDomains=async(v)=>{
  if(!IS_ADMIN) return;
  const domains=v.split(',').map(s=>s.trim()).filter(Boolean);
  const {error}=await sb.from('st_kpi_config').upsert({org_id:ME.org_id,kpi:'_config',config:{booking_domains:domains}},{onConflict:'org_id,kpi'});
  toast(error?'No se pudo guardar':'Dominios guardados'); KPI_CFG=null; SHADOW=null; renderTeam();
};
```

- [ ] **Step 2: Sintaxis, subir, commit**

```bash
# node --check del <script>; scp; luego
git add index.html && git commit -m "feat(sombra): panel de calibración en Configuraciones (solo admin)"
```

---

### Task 5: QA e2e en dev (org Maze — Pruebas)

- [ ] 1. Configuraciones → panel visible solo como admin; guardar dominio `agendar.mazefunnels.io`
- [ ] 2. "Correr ahora" → toast con filas; la tabla muestra KPIs de closer (Nico sin ghl_user_id: solo ventas) y setters
- [ ] 3. Validación cruzada: `node /root/sombra.js <user> <hoy>` vs filas de `st_shadow_metrics` del mismo member/día — mismos valores en llamadas/outbound/respuestas
- [ ] 4. Cargar un valor manual en Cargar día → correr de nuevo → la columna Manual lo refleja y el match se recalcula
- [ ] 5. `POST /api/shadow/run` sin auth → 401; como no-admin → 403
- [ ] 6. Verificar el scheduler: log `[shadow]` presente al simular (opcional: bajar la ventana a la hora actual en un env temporal — NO commitear)
- [ ] 7. Consola sin errores; commit final + push
