# Config auto-descubierta — Fase 1: multi-calendario (agendas) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development o superpowers:executing-plans. Steps con checkbox (`- [ ]`).

**Goal:** El admin de un tenant marca **varios** calendarios (traídos de GHL) como "agendas del setter", y el motor sombra cuenta las citas de **todos** ellos. Destraba el QA real de agendas.

**Architecture:** Los calendarios de agenda del setter (multi) se guardan en `st_kpi_config._config.agenda_calendar_ids` (array). `st_integrations.calendar_id` se mantiene para el closer (llamadas/asistencias). El worker (`runShadowForOrg`) lee los IDs y los pasa al motor; el cruce de agendas itera sobre todos. UI multi-select en la card de Integración HighLevel.

**Tech Stack:** Node (mini-API sin framework) + vanilla JS + Supabase (PostgREST). Verificación: `node --check` + greps + QA contra GHL real.

## Global Constraints

- Rama `feature/config-auto-descubierta`.
- **Todo se jala de GHL**: los calendarios del multi-select vienen de `GET /api/ghl/calendars` (ya existe), nunca hardcodeados.
- Por-tenant: la config vive en `st_kpi_config._config` de cada org, aislada.
- **Retrocompat**: si un tenant no eligió calendarios de agenda, el motor cae al `calendar_id` del closer (para no romper lo ya configurado).
- No tocar el `calendar_id` del closer (`st_integrations`) — es propósito distinto.
- Copy español latino con tuteo. Modo sombra intacto.

---

### Task 1: Motor — cruzar agendas contra múltiples calendarios

**Files:**
- Modify: `api/metrics.js` — bloque de agendas del setter (el `if (linkedContacts.size && calendarId)`)

**Interfaces:**
- Consumes: `ctx.agendaCalendarIds` (array de IDs; nuevo). Fallback: si ausente/vacío, usar `[ctx.calendarId]` cuando `calendarId` exista.
- Produces: `out.agend_ig` / `out.agend_wpp` sumando citas de todos los calendarios.

- [ ] **Step 1: Derivar la lista de calendarios de agenda**

Al inicio de la rama setter (o donde se define el contexto), calcular:
```javascript
const agendaCals = (ctx.agendaCalendarIds && ctx.agendaCalendarIds.length)
  ? ctx.agendaCalendarIds
  : (calendarId ? [calendarId] : []);
```

- [ ] **Step 2: Iterar el cruce sobre cada calendario**

Reemplazar el `if (linkedContacts.size && calendarId) { … 1 fetch … }` por un loop sobre `agendaCals`: para cada `calId`, consultar `calendars/events` en la ventana `[range.start, range.start + AGENDA_WINDOW_DAYS*86400000]`, re-filtrar client-side por la ventana, y atribuir `agend_ig`/`agend_wpp` por contacto linkeado, borrando el contacto del Map tras contarlo (una agenda por contacto, sin importar en cuál calendario aparezca).

```javascript
if (linkedContacts.size && agendaCals.length) {
  const winEnd = range.start + AGENDA_WINDOW_DAYS * 86400000;
  const inWin = (iso) => { const t = new Date(iso).getTime(); return t >= range.start && t < winEnd; };
  for (const calId of agendaCals) {
    if (!linkedContacts.size) break; // ya no quedan contactos por atribuir
    const ag = await ghlFetch(`${ghlBase}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calId)}&startTime=${range.start}&endTime=${winEnd}`, H);
    for (const e of (ag.events || [])) {
      if (e.deleted || !inWin(e.startTime)) continue;
      const canal = linkedContacts.get(e.contactId);
      if (!canal) continue;
      if (canal === 'ig') out.agend_ig++; else out.agend_wpp++;
      linkedContacts.delete(e.contactId);
    }
  }
}
```

- [ ] **Step 3: Verificar**

Run: `node --check api/metrics.js && grep -q "agendaCals" api/metrics.js && grep -q "ctx.agendaCalendarIds" api/metrics.js`
Expected: sin error.

- [ ] **Step 4: Commit**

```bash
git add api/metrics.js
git commit -m "feat(sombra): cruzar agendas contra múltiples calendarios (agendaCalendarIds)

El setter puede agendar en varios calendarios; el motor suma las citas de
todos. Fallback al calendar_id del closer si el tenant no eligió agenda cals.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Worker — leer `agenda_calendar_ids` y pasarlos al motor

**Files:**
- Modify: `api/server.js` — `runShadowForOrg` (~línea 682-712)

**Interfaces:**
- Consumes: `st_kpi_config._config.agenda_calendar_ids`.
- Produces: `ctx.agendaCalendarIds` en la llamada a `computeMemberKpis`.

- [ ] **Step 1: Leer los IDs del `_config`**

Donde se lee `booking_domains` (`cfgRows[0].config.booking_domains`, ~línea 704), agregar:
```javascript
const agendaCalendarIds = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.agenda_calendar_ids) || [];
```

- [ ] **Step 2: Pasarlo al ctx**

En el objeto ctx que se pasa a `computeMemberKpis` (~línea 712), agregar `agendaCalendarIds` junto a `bookingDomains`.

- [ ] **Step 3: Verificar**

Run: `node --check api/server.js && grep -q "agenda_calendar_ids" api/server.js && grep -q "agendaCalendarIds" api/server.js`
Expected: sin error.

- [ ] **Step 4: Commit**

```bash
git add api/server.js
git commit -m "feat(sombra): worker lee agenda_calendar_ids del _config y los pasa al motor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Backend — endpoint para guardar/leer los calendarios de agenda

**Files:**
- Modify: `api/server.js` — nuevo endpoint + routing

**Interfaces:**
- `POST /api/integrations/ghl/agenda-calendars` (admin): body `{ calendar_ids: string[] }` → valida cada ID contra la lista real de `GET /api/ghl/calendars` (reusar el helper que ya lista/filtra), y hace **upsert** de `st_kpi_config._config.agenda_calendar_ids` (merge con el resto del `_config`, sin pisar `booking_domains`).
- El `GET` de estado de integración (~línea 842, donde se devuelve `selected`/`selected_name`) agrega `agenda_calendar_ids` (los guardados) para que la UI marque los seleccionados.

- [ ] **Step 1: Implementar el endpoint**

Patrón (reusar `svcGet`/`svcPatch`/upsert de `_config` ya presentes): leer el `_config` actual, setear `agenda_calendar_ids` con los IDs validados, upsert. Validar que cada ID exista en la lista de calendarios de la org (rechazar 400 con IDs inválidos). `admin.org_id` del perfil validado.

- [ ] **Step 2: Registrar el routing** junto al de `/api/integrations/ghl/calendar` (~línea 2827).

- [ ] **Step 3: Exponer los guardados en el GET de estado** (agregar `agenda_calendar_ids` a la respuesta ~línea 842).

- [ ] **Step 4: Verificar**

Run: `node --check api/server.js && grep -q "agenda-calendars" api/server.js`
Expected: sin error.

- [ ] **Step 5: Commit**

```bash
git add api/server.js
git commit -m "feat(config): endpoint guardar/leer calendarios de agenda del setter (multi)

POST /api/integrations/ghl/agenda-calendars (admin, valida contra GHL) +
agenda_calendar_ids en el GET de estado. Persiste en st_kpi_config._config.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — multi-select de calendarios de agenda

**Files:**
- Modify: `index.html` — card "Integración HighLevel", bloque de calendario

**Interfaces:**
- Consumes: la lista de calendarios (ya se trae de `GET /api/ghl/calendars`) + `agenda_calendar_ids` del estado.
- Produces: `POST /api/integrations/ghl/agenda-calendars` al guardar.

- [ ] **Step 1: Agregar el bloque "Calendarios de agenda del setter"**

En la card de integración, debajo (o junto) al select actual de "calendario de llamadas" (closer), agregar un bloque nuevo con **checkboxes** (uno por calendario traído de GHL), marcando los que están en `agenda_calendar_ids`. Copy: "Marcá los calendarios donde tus setters agendan llamadas — sus citas cuentan como agendas." Botón "Guardar calendarios de agenda" → `POST /api/integrations/ghl/agenda-calendars` con los IDs marcados, luego `toast` + refrescar estado.

- [ ] **Step 2: Verificar**

Run: `grep -q "agenda-calendars" index.html && node -e "const h=require('fs').readFileSync('index.html','utf8');const o=(h.match(/<script/g)||[]).length,c=(h.match(/<\/script>/g)||[]).length;console.log(o===c?'OK':'DESBALANCE')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(config): multi-select de calendarios de agenda del setter (checkboxes)

Trae los calendarios de GHL y deja marcar varios como agendas del setter.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 (checkpoint human-verify, blocking): QA real de agendas

- [ ] **Step 1: Deploy a pruebas** (merge de la rama → develop tras revisión).
- [ ] **Step 2:** En Configuraciones → Integración HighLevel, marcar 1+ calendarios de agenda (ej. "Auditoría Estratégica") y guardar.
- [ ] **Step 3:** Correr el motor (`POST /api/shadow/run` o el QA por script) para un setter con links enviados en un día real, y confirmar que `agend_ig`/`agend_wpp` cuentan las citas de los calendarios marcados. Comparar contra GHL.

**Resume-signal:** "aprobado" o describir qué no cuadró.

---

## Self-Review

**Spec coverage:** multi-calendario descubrir(ya)→mapear(Task 3/4)→consumir(Task 1/2) ✓ · por-tenant (`_config` por org) ✓ · retrocompat con calendar_id del closer ✓ · destraba QA agendas (Task 5) ✓.

**Placeholder scan:** Task 1/2 traen código exacto; Task 3/4 especifican comportamiento + endpoint + puntos de inserción (el executor reusa helpers existentes de `_config`/calendarios). Sin TODOs.

**Type consistency:** `agenda_calendar_ids` (DB/config) ↔ `agendaCalendarIds` (ctx/motor) ↔ `agendaCals` (local en metrics) — nombres consistentes en su capa.

**Nota:** este plan sólo cubre calendarios (Fase 1 del proyecto). Dominios/ADS/CTA son fases 2/3/4.
