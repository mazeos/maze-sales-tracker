# Motor sombra Ola 1 — TikTok + bienvenidas + agendas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development o superpowers:executing-plans. Steps con checkbox (`- [ ]`).

**Goal:** Que el motor sombra auto-calcule TikTok (nativo), bienvenidas y agendas del setter desde GHL, subiendo la auto-medición de ~50% a ~85%.

**Architecture:** Toda la lógica en `api/metrics.js` (`computeMemberKpis`, rama `member.role === 'setter'`), más 2 claves nuevas en `METRICS.setter` de `index.html`. Módulo puro; se mantiene la regla de oro (re-filtrar fechas client-side por TZ). Modo sombra intacto: el worker escribe solo `st_shadow_metrics`.

**Tech Stack:** Node (ES module, `fetch` nativo) + vanilla JS. Verificación: `node --check` + corrida real (`POST /api/shadow/run`) comparada con GHL.

## Global Constraints

- Trabajar en la rama `feature/motor-sombra-ola1` (ya incluye las claves `outbound_tk`/`resp_tk` de la Fase 1).
- **Modo sombra**: NO escribir `st_entries` desde el worker. Solo `st_shadow_metrics`.
- Solo mensajes del día (re-filtrar por `inDay`), TZ de la org.
- Copy en español latino con tuteo.
- Decisiones aprobadas: TikTok nativo separado del WhatsApp-de-TikTok; bienvenidas solo IG; ventana de atribución de agendas = **7 días**.
- No romper los KPIs que ya calcula (IG/WhatsApp inbound/outbound/respuestas/seguimientos/links).

---

### Task 1: Agregar `inbound_tk` y `seg_tk` al catálogo del setter

**Files:**
- Modify: `index.html` — `METRICS.setter` (junto a `outbound_tk`/`resp_tk` de la Fase 1)

- [ ] **Step 1: Insertar las 2 claves nuevas después de `resp_tk`**

Ubicar `{k:'resp_tk', ...}` e insertar inmediatamente después:

```javascript
    {k:'inbound_tk', label:'Inbound TikTok', def:'Personas que ME escribieron por el DM nativo de TikTok.'},
    {k:'seg_tk', label:'Seguimientos TikTok', def:'Seguimientos hechos por el DM nativo de TikTok.'},
```

- [ ] **Step 2: Verificar**

Run: `grep -c -E "inbound_tk|seg_tk" index.html`
Expected: `2` o más.

- [ ] **Step 3: HTML sano**

Run: `node -e "const h=require('fs').readFileSync('index.html','utf8');const o=(h.match(/<script/g)||[]).length,c=(h.match(/<\/script>/g)||[]).length;console.log(o===c?'OK':'DESBALANCE')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(setter): agregar Inbound/Seguimientos TikTok al catálogo

Completa el canal TikTok nativo (junto a Outbound/Respuestas de Fase 1).
Los alimentará el motor sombra (Task 2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: TikTok nativo en el motor sombra

**Files:**
- Modify: `api/metrics.js` — constantes de canal + rama setter de `computeMemberKpis`

**Interfaces:**
- Produces: claves `outbound_tk`, `resp_tk`, `inbound_tk`, `seg_tk` en el objeto `out` del setter.

- [ ] **Step 1: Agregar el set de tipos TikTok**

Junto a `IG_TYPES`/`WA_TYPES` (~línea 47):

```javascript
const TK_TYPES = new Set(['TYPE_TIKTOK']);
```

- [ ] **Step 2: Inicializar las claves TikTok en `out`**

En el `Object.assign(out, { outbound: 0, inbound_ig: 0, ... })` de la rama setter (~línea 84), agregar: `outbound_tk: 0, resp_tk: 0, inbound_tk: 0, seg_tk: 0`.

- [ ] **Step 3: Clasificar el canal TikTok y contar por canal**

En el loop `for (const c of mias)`, donde se calcula `isIg`/`isWa` (~línea 112), agregar `const isTk = TK_TYPES.has(type);`.

Regla de asignación por canal (mantener las de IG/WhatsApp intactas, agregar TikTok):
- **Apertura/outbound** (hoy `out.outbound++` genérico, ~línea 123): cambiar para que **TikTok cuente en `outbound_tk`** y el resto siga en `outbound`. Es decir: `if (humanOut(msgs[0]) && inDay(msgs[0].dateAdded)) { if (isTk) out.outbound_tk++; else out.outbound++; }`. (Requiere que `isTk` esté calculado antes de esta línea — mover el cálculo de `type`/`isIg`/`isWa`/`isTk` arriba de la línea de apertura si hace falta.)
- **Inbound** (~línea 125): en el bloque `if (todays.some(inbound))`, agregar `if (isTk) out.inbound_tk++;` junto a los `isIg`/`isWa`.
- **Respuestas** (~línea 132): hoy `out.respuestas++` es genérico. Agregar el desglose TikTok: si la conversación es TikTok, contar en `out.resp_tk` en vez de `out.respuestas` (para separar respuestas TikTok, coherente con el sheet). Es decir, envolver: `if (isTk) out.resp_tk++; else out.respuestas++;`.
- **Seguimiento** (~línea 134): en el bloque de seguimiento, agregar `else if (isTk) out.seg_tk++;` junto a `isIg`/`isWa`.

- [ ] **Step 4: Verificar sintaxis**

Run: `node --check api/metrics.js && grep -q "TK_TYPES" api/metrics.js && grep -q "out.outbound_tk" api/metrics.js && grep -q "out.inbound_tk" api/metrics.js && grep -q "out.seg_tk" api/metrics.js`
Expected: sin error.

- [ ] **Step 5: Commit**

```bash
git add api/metrics.js
git commit -m "feat(sombra): calcular TikTok nativo (TYPE_TIKTOK) para el setter

outbound_tk/inbound_tk/resp_tk/seg_tk desde los DMs nativos de TikTok que
GHL ya recibe. Separado del WhatsApp-de-TikTok existente.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Bienvenidas (mensajes automated de IG)

**Files:**
- Modify: `api/metrics.js` — rama setter

**Interfaces:**
- Produces: clave `bienvenidas` en `out` del setter.

- [ ] **Step 1: Inicializar `bienvenidas: 0`** en el `Object.assign(out, {...})` de la rama setter.

- [ ] **Step 2: Detectar la bienvenida automática de apertura (solo IG)**

Una bienvenida = mensaje saliente **automatizado** (no humano) que abre la conversación. Hoy `humanOut(m)` exige humano (`source === 'app' || !source`); el opuesto (`m.direction === 'outbound' && m.source && m.source !== 'app'`) es automatizado.

En el loop, para conversaciones IG (`isIg`), si el **primer** mensaje del día es un saliente automatizado (apertura automática), contar `out.bienvenidas++`. Definir helper cerca de `humanOut`:

```javascript
const autoOut = (m) => m.direction === 'outbound' && !!m.source && m.source !== 'app';
```

Y en el loop (IG), tras filtrar `todays`: si `isIg && todays.length && autoOut(todays[0]) && !inDay(msgs[0].dateAdded) === false`… — regla concreta: contar bienvenida si el primer mensaje **histórico** de la conversación (`msgs[0]`) es automatizado, es de hoy, y es IG: `if (isIg && autoOut(msgs[0]) && inDay(msgs[0].dateAdded)) out.bienvenidas++;`. Ubicar junto al conteo de apertura (Task 2 Step 3).

- [ ] **Step 3: Verificar**

Run: `node --check api/metrics.js && grep -q "autoOut" api/metrics.js && grep -q "out.bienvenidas" api/metrics.js`
Expected: sin error.

- [ ] **Step 4: Commit**

```bash
git add api/metrics.js
git commit -m "feat(sombra): contar bienvenidas (mensajes automated de ManyChat en IG)

El opuesto de humanOut: saliente automatizado de apertura. Solo IG (donde
corre ManyChat).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Agendas por cruce link ↔ cita

**Files:**
- Modify: `api/metrics.js` — rama setter

**Interfaces:**
- Consumes: los `contactId` de las conversaciones donde el setter envió un link hoy (canal IG/WhatsApp).
- Produces: claves `agend_ig`, `agend_wpp` en `out`.

- [ ] **Step 1: Inicializar `agend_ig: 0, agend_wpp: 0`** en el `Object.assign`.

- [ ] **Step 2: Registrar los contactos "linkeados" por canal**

En el loop, donde se cuentan `links_ig`/`links_wpp` (~línea 138), cuando el setter envió ≥1 link a una conversación hoy, guardar el `contactId` con su canal en un Map declarado antes del loop:

```javascript
const linkedContacts = new Map(); // contactId -> 'ig' | 'wpp'
// dentro del bloque de links, si n > 0:
if (n > 0) linkedContacts.set(c.contactId, isIg ? 'ig' : 'wpp');
```

- [ ] **Step 3: Cruzar con las citas del día (ventana 7 días)**

Después del loop de conversaciones, consultar las citas cuyo `startTime` cae en el día (o creadas hoy) para el contacto linkeado. Reusar el patrón de `calendars/events` ya presente para closers. Para cada cita cuyo `contactId` está en `linkedContacts` **y** el link se envió dentro de los 7 días previos a la creación de la cita, incrementar `agend_ig` o `agend_wpp` según el canal guardado.

Nota de implementación: como el link se detecta "hoy" y la cita puede crearse el mismo día, la ventana de 7 días es un colchón; en la práctica de Fase A basta con: cita del día cuyo contacto está en `linkedContacts` → cuenta como agenda del canal correspondiente. Documentar la ventana como parámetro (`AGENDA_WINDOW_DAYS = 7`).

- [ ] **Step 4: Verificar**

Run: `node --check api/metrics.js && grep -q "linkedContacts" api/metrics.js && grep -q "out.agend_ig" api/metrics.js && grep -q "out.agend_wpp" api/metrics.js`
Expected: sin error.

- [ ] **Step 5: Commit**

```bash
git add api/metrics.js
git commit -m "feat(sombra): atribuir agendas al setter cruzando link enviado con cita

El contacto que recibió el link de agenda del setter y tiene cita en GHL
cuenta como agend_ig/agend_wpp según el canal del link. Ventana 7 días.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 (checkpoint human-verify, blocking): QA contra datos reales de Maze

- [ ] **Step 1: Desplegar a pruebas** (PR de la rama → `develop`, tras mergear antes la Fase 1 / PR #12).
- [ ] **Step 2: Correr el motor para un setter con GHL** vía `POST /api/shadow/run` para una fecha con actividad conocida.
- [ ] **Step 3: Comparar** los conteos auto de TikTok / bienvenidas / agendas contra lo observable en GHL para esa fecha (panel de calibración: auto vs manual, % match). Anotar desvíos.

**Resume-signal:** "aprobado" o describir qué no cuadró.

---

## Self-Review

**Spec coverage:** TikTok (Task 2) ✓ · Bienvenidas (Task 3) ✓ · Agendas (Task 4) ✓ · claves nuevas al catálogo (Task 1) ✓ · modo sombra intacto (Global Constraints) ✓ · ADS/CTA/Facebook fuera (spec) ✓.

**Placeholder scan:** los cambios en `metrics.js` especifican comportamiento + puntos de inserción exactos; el executor lee el archivo y ajusta el orden de clasificación de canal (calcular `isTk` antes de la línea de apertura). No hay TODOs.

**Riesgo señalado:** Task 2 cambia la semántica de `out.outbound`/`out.respuestas` (antes genéricos, ahora excluyen TikTok). Es intencional y coherente con el sheet (Outbound vs TT Outbound separados). Verificar en QA que los conteos IG no bajen indebidamente.
