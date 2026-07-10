# Backfill Fase 1 — ⚡ Autocompletar para todos los roles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps con checkbox (`- [ ]`).

**Goal:** El botón ⚡ Autocompletar de "Cargar día" trae la data de GHL de la fecha elegida para CUALQUIER rol (hoy solo closer); para setter/triage usa el motor completo (`computeMemberKpis`).

**Architecture:** En `GET /api/capture/ghl`, si el miembro es closer se mantiene la lógica certera actual (citas + ventas); si es setter/triage se corre `computeMemberKpis` (el mismo del modo sombra) para la fecha y se devuelven sus KPIs en el formato existente `{metrics: {kpi: {value, source:'ghl'}}}`. En el front se quita el gate `role==='closer'` del botón.

**Tech Stack:** Node (mini-API sin framework) + vanilla JS. Verificación: `node --check` + greps + smoke test + QA real.

## Global Constraints

- Rama `feature/backfill-tracker-ghl`.
- No cambiar el comportamiento del closer (ya validado): su rama sigue trayendo citas + ventas igual.
- `computeMemberKpis` devuelve `{ values, contacts }` — se usa `.values`.
- Nada se escribe en `st_entries` en este endpoint: la UI aplica los valores y el usuario guarda por el flujo normal.
- Copy español latino con tuteo.

---

### Task 1: Backend — `captureGhl` para setter/triage vía `computeMemberKpis`

**Files:**
- Modify: `api/server.js` — `captureGhl`

**Interfaces:**
- Consumes: `computeMemberKpis({ ... }).values` (ya importado), `st_kpi_config._config` de la org (bookingDomains, agendaCalendarIds).
- Produces: `metrics` con los KPIs del setter/triage además del closer.

- [ ] **Step 1: Quitar el rechazo por rol y ramificar closer vs setter/triage**

En `captureGhl`, reemplazar la línea del rechazo:
```javascript
  if (prof.role !== 'closer') return sendJSON(res, 400, { error: 'El autocompletar está disponible solo para closers (v1)' });
```
por (nada — se elimina; el rol se ramifica más abajo). Es decir, **borrar esa línea**.

- [ ] **Step 2: Envolver la lógica de citas del closer en un `if` de rol**

El bloque de citas del closer (hoy `if (prof.ghl_user_id) { ... metrics.llamadas ... metrics.no_shows ... }`, ~líneas 652-678) queda **solo para closer**. Cambiar su condición de apertura de:
```javascript
  // Citas del día asignadas al closer (solo si tiene ghl_user_id vinculado).
  if (prof.ghl_user_id) {
```
a:
```javascript
  // Citas del día asignadas al closer (solo si tiene ghl_user_id vinculado).
  if (prof.role === 'closer' && prof.ghl_user_id) {
```

- [ ] **Step 3: Envolver las ventas del closer en un `if` de rol**

El bloque de ventas (hoy `try { ... metrics.cierres ... metrics.cash_nuevo ... }`, ~líneas 680-692) queda **solo para closer**. Envolverlo en `if (prof.role === 'closer') { ... }`. Reemplazar:
```javascript
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
```
por:
```javascript
  // Cierres y cash desde las ventas del tracker (fuente de verdad interna). Solo closer.
  if (prof.role === 'closer') {
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
  }

  // Setter / triage: KPIs de conversaciones del día vía el motor completo (mismo del modo sombra).
  if (prof.role !== 'closer' && prof.ghl_user_id) {
    const cfgRows = await svcGet('st_kpi_config?org_id=eq.' + encodeURIComponent(member.org_id) + '&kpi=eq._config&select=config');
    const bookingDomains = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.booking_domains) || [];
    const agendaCalendarIds = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.agenda_calendar_ids) || [];
    let result;
    try {
      result = await computeMemberKpis({
        ghlBase: GHL_BASE, token: creds.token, locationId: creds.locationId,
        calendarId: creds.integration ? calendarId : calendarId, tz, date,
        member: { id: targetId, role: prof.role, ghl_user_id: prof.ghl_user_id },
        salesRows: [], cuotasRows: [], bookingDomains, agendaCalendarIds,
      });
    } catch {
      return sendJSON(res, 502, { error: 'No se pudieron calcular los KPIs de GHL' });
    }
    for (const [k, v] of Object.entries(result.values || {})) {
      metrics[k] = { value: v, source: 'ghl' };
    }
  }
```

- [ ] **Step 4: Verificar**

Run: `node --check api/server.js && grep -q "prof.role === 'closer' && prof.ghl_user_id" api/server.js && grep -q "prof.role !== 'closer' && prof.ghl_user_id" api/server.js && grep -q "computeMemberKpis({" api/server.js`
Expected: sin error.

- [ ] **Step 5: Commit**

```bash
git add api/server.js
git commit -m "feat(capture): autocompletar Cargar día también para setter/triage

El closer mantiene su lógica certera (citas + ventas). Setter/triage corren
computeMemberKpis (el motor del modo sombra) para la fecha y devuelven sus KPIs
de conversaciones en el mismo formato {value, source:'ghl'}.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Frontend — mostrar el ⚡ para todos los roles

**Files:**
- Modify: `index.html` — botón ⚡ Autocompletar en Cargar día (~línea 927)

**Interfaces:**
- Consumes: `/api/capture/ghl` (ya extendido en Task 1).

- [ ] **Step 1: Quitar el gate de rol del botón**

Reemplazar la línea del botón (hoy gated a closer):
```javascript
        ${member.role==='closer' ? `<button class="chip" id="ghlFillBtn" onclick="autofillGhl()" data-tip="Trae lo certero: citas del calendario (llamadas, asistencias, no-shows) y cierres/cash de tus Ventas del día. Revisás y listo.">⚡ Autocompletar</button>` : ''}
```
por:
```javascript
        <button class="chip" id="ghlFillBtn" onclick="autofillGhl()" data-tip="Trae la data de HighLevel de este día para revisar y guardar. Del closer: citas + ventas. Del setter: conversaciones, inbound, respuestas y agendas.">⚡ Autocompletar</button>
```

- [ ] **Step 2: Verificar**

Run: `grep -q "Del closer: citas + ventas" index.html && node -e "const h=require('fs').readFileSync('index.html','utf8');const o=(h.match(/<script/g)||[]).length,c=(h.match(/<\/script>/g)||[]).length;console.log(o===c?'OK':'DESBALANCE')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(capture): mostrar ⚡ Autocompletar para todos los roles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 (checkpoint human-verify, blocking): QA real

- [ ] **Step 1: Deploy a pruebas** (merge de la rama → develop; deploy automático).
- [ ] **Step 2:** En "Cargar día", elegir un **setter** con actividad real y una **fecha pasada**; tocar **⚡ Autocompletar**.
- [ ] **Step 3:** Confirmar que se llenan los contadores del setter (outbound/inbound/respuestas/agendas) con la data de GHL de ese día, editables, y que al guardar quedan en el tracker. Repetir con un closer (no debe cambiar su comportamiento).

**Resume-signal:** "aprobado" o describir qué no cuadró.

---

## Self-Review

**Spec coverage (Fase 1):** ⚡ para todos los roles ✓ · closer sin cambios (su lógica queda envuelta en `if role==='closer'`) ✓ · setter/triage vía `computeMemberKpis` en el formato existente ✓ · no escribe en st_entries (la UI aplica y el usuario guarda) ✓ · QA real ✓.

**Placeholder scan:** todo el código va literal. Sin TODOs.

**Type consistency:** `computeMemberKpis(...).values` es `{kpi: number}`; se mapea a `metrics[kpi] = {value, source:'ghl'}`, el mismo shape que el front ya consume (`j.metrics[k].value`, `j.metrics[k].source`). `member` para el motor lleva `{id, role, ghl_user_id}` (lo que usa internamente). El calendarId ya está resuelto arriba en el handler.

**Nota:** el motor para setter pagina conversaciones — el ⚡ tardará unos segundos (igual que una corrida sombra de un miembro). Aceptable para un día puntual. Fase 2 (backfill por rango) usará el job en background.
