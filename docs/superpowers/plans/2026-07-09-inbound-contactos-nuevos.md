# Inbound/outbound por contacto nuevo vs existente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps con checkbox (`- [ ]`).

**Goal:** El motor clasifica la actividad del setter según si el contacto es nuevo (alta hoy) o ya existía: inbound/outbound solo para leads nuevos, respuestas para entrantes de contactos existentes.

**Architecture:** En la rama setter de `api/metrics.js`, traer la ficha del contacto en todos los canales (para leer `dateAdded`), calcular `esNuevo`, y reescribir la clasificación outbound/inbound/respuestas como un if/else-if excluyente por contacto nuevo vs viejo.

**Tech Stack:** Node (mini-API sin framework). Verificación: `node --check` + greps + smoke test del contrato + QA real contra GHL.

## Global Constraints

- Rama `feature/inbound-contactos-nuevos`.
- Los `bump(...)` del desglose de contactos (ya implementado) acompañan cada métrica — se recolocan con la lógica nueva, no se pierden.
- `seg_*`, `bienvenidas`, `links_*`, `agend_*`, métricas del closer: **sin cambios**.
- `outbound` sigue siendo total (ig/wpp juntos) + `outbound_tk`; no se separa por canal.
- El contacto se trae **una vez por conversación** con actividad y se cachea (nombre + dateAdded). Respeta el throttle 10 req/s + retry 429.
- Copy español latino con tuteo. Modo sombra intacto.

---

### Task 1: Motor — clasificar por contacto nuevo vs existente

**Files:**
- Modify: `api/metrics.js` — bloque de conteos de la rama setter

**Interfaces:**
- Consumes: `contact.dateAdded` (ISO UTC) de `GET /contacts/{id}` (ya se llama en WhatsApp; se extiende a todos los canales). `inDay` y `bump` ya definidos en `computeMemberKpis`.
- Produces: `out.outbound`/`out.inbound_*`/`out.respuestas` reclasificados; `contactsByKpi` poblado acorde.

- [ ] **Step 1: Reescribir el bloque de canal + clasificación**

En la rama setter, reemplazar desde `const type = msgs[0].messageType...` hasta el final del bloque de respuestas/seguimiento (el bloque que hoy contiene el `if (isWa) { ... waCanal ... }` y las clasificaciones de apertura/inbound/respuestas/seguimiento) por:

```javascript
      const type = msgs[0].messageType || c.lastMessageType || '';
      const isIg = IG_TYPES.has(type), isWa = WA_TYPES.has(type), isTk = TK_TYPES.has(type);
      // Traer el contacto para leer su fecha de alta (esNuevo) y, en WhatsApp, el
      // canal por utm_source. Una vez por conversación; cachea el nombre para el desglose.
      let esNuevo = false, waCanal = null;
      if (c.contactId) {
        const contact = await ghlFetch(`${ghlBase}/contacts/${encodeURIComponent(c.contactId)}`, H);
        const cc = contact.contact || {};
        contactNames.set(c.contactId, nombreDe(cc));
        esNuevo = cc.dateAdded ? inDay(cc.dateAdded) : false;
        if (isWa) {
          const cf = (cc.customFields || []).find((f) => String(f.key || f.name || '').toLowerCase().includes('utm_source'));
          const src = String((cf && cf.value) || (cc.tags || []).find((t) => String(t).startsWith('origen:')) || '').toLowerCase();
          if (src.includes('tiktok')) waCanal = 'tk'; else if (src.includes('instagram')) waCanal = 'ig';
        }
      }
      const abrioSetter = humanOut(msgs[0]) && inDay(msgs[0].dateAdded);
      const primerEntrante = msgs[0].direction === 'inbound';
      if (esNuevo && abrioSetter) {
        // outbound: apertura a un lead NUEVO (todos los canales)
        if (isTk) { out.outbound_tk++; bump('outbound_tk', c.contactId); } else { out.outbound++; bump('outbound', c.contactId); }
      } else if (esNuevo && primerEntrante) {
        // inbound: lead NUEVO que escribió primero (por canal)
        if (isIg) { out.inbound_ig++; bump('inbound_ig', c.contactId); }
        else if (isTk) { out.inbound_tk++; bump('inbound_tk', c.contactId); }
        else if (isWa) {
          if (waCanal === 'tk') { out.inbound_wpp_tk++; bump('inbound_wpp_tk', c.contactId); }
          else if (waCanal === 'ig') { out.inbound_wpp_ig++; bump('inbound_wpp_ig', c.contactId); }
          else { out.inbound_wpp_sin_canal++; bump('inbound_wpp_sin_canal', c.contactId); }
        }
      } else if (!esNuevo && todays.some((m) => m.direction === 'inbound')) {
        // respuesta: contacto que YA existía te escribe hoy
        if (isTk) { out.resp_tk++; bump('resp_tk', c.contactId); } else { out.respuestas++; bump('respuestas', c.contactId); }
      }
      // bienvenida: apertura automática (ManyChat) de hoy — solo IG (sin cambios)
      if (isIg && autoOut(msgs[0]) && inDay(msgs[0].dateAdded)) { out.bienvenidas++; bump('bienvenidas', c.contactId); }
      // seguimiento: saliente humano de hoy en conversación que NO abrió hoy (sin cambios)
      if (!inDay(msgs[0].dateAdded) && todays.some(humanOut)) {
        if (isIg) { out.seg_ig++; bump('seg_ig', c.contactId); } else if (isWa) { out.seg_wpp++; bump('seg_wpp', c.contactId); } else if (isTk) { out.seg_tk++; bump('seg_tk', c.contactId); }
      }
```

> El bloque de `links` (`if (domRe) { ... }`) queda **igual**, justo después. No tocarlo.

- [ ] **Step 2: Verificar sintaxis y señales**

Run:
```bash
node --check api/metrics.js \
  && grep -q "esNuevo = cc.dateAdded ? inDay(cc.dateAdded) : false" api/metrics.js \
  && grep -q "esNuevo && abrioSetter" api/metrics.js \
  && grep -q "esNuevo && primerEntrante" api/metrics.js \
  && grep -q "!esNuevo && todays.some" api/metrics.js \
  && echo OK
```
Expected: `OK`.

- [ ] **Step 3: Smoke test del contrato (sin red)**

Run:
```bash
node --input-type=module -e "
import('./api/metrics.js').then(async (m) => {
  const r = await m.computeMemberKpis({ member:{role:'setter'}, date:'2026-07-09', tz:'America/Argentina/Buenos_Aires', salesRows:[], cuotasRows:[] });
  console.log(r && 'values' in r && 'contacts' in r ? 'SMOKE OK' : 'SMOKE FAIL');
});
"
```
Expected: `SMOKE OK` (el early-return sigue devolviendo `{ values, contacts }`).

- [ ] **Step 4: Commit**

```bash
git add api/metrics.js
git commit -m "feat(sombra): inbound/outbound solo para leads nuevos (alta hoy)

Clasifica cada conversación del setter por contacto nuevo (alta hoy) vs
existente: outbound/inbound = leads nuevos; entrante de contacto existente =
respuesta. Trae la ficha del contacto en todos los canales para leer dateAdded.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2 (checkpoint human-verify, blocking): QA real

- [ ] **Step 1: Deploy a pruebas** (merge de la rama → develop; deploy automático).
- [ ] **Step 2:** Correr "Recap del día" para un setter con actividad real.
- [ ] **Step 3:** Con el desglose de contactos, verificar:
  - `inbound_*` lista solo contactos con **alta de hoy** que escribieron primero.
  - `respuestas` incluye los contactos que **ya existían** que escribieron hoy.
  - `outbound` cuenta solo aperturas a contactos con alta de hoy.
  - Comparar los contactos del desglose contra su ficha en GHL (fecha de alta).

**Resume-signal:** "aprobado" o describir qué no cuadró.

---

## Self-Review

**Spec coverage:** outbound con `esNuevo` (Task 1) ✓ · inbound = esNuevo + primer entrante (Task 1) ✓ · respuestas = entrante de contacto no-nuevo (Task 1) ✓ · traer contacto en todos los canales para dateAdded (Task 1) ✓ · seg/bienvenidas/links/agendas sin cambios (bloque links intacto; bienvenida y seguimiento reescritos idénticos salvo el bump ya existente) ✓ · QA real (Task 2) ✓.

**Placeholder scan:** el bloque va literal y completo. Sin TODOs.

**Type consistency:** `esNuevo` (bool), `abrioSetter` (bool), `primerEntrante` (bool). `bump(kpi, contactId)` y `nombreDe`/`contactNames`/`inDay` ya existen en `computeMemberKpis`. Las claves de `out` (`outbound`, `outbound_tk`, `inbound_ig`, `inbound_tk`, `inbound_wpp_tk`, `inbound_wpp_ig`, `inbound_wpp_sin_canal`, `respuestas`, `resp_tk`) ya están inicializadas en el `Object.assign(out, {...})` del inicio de la rama setter — no se agregan claves nuevas, solo cambia cuándo se incrementan.

**Nota de exclusividad:** el if/else-if hace que cada conversación cuente en a lo sumo una de outbound/inbound/respuesta. bienvenida, seguimiento y links se evalúan aparte (pueden coexistir), como hoy.
