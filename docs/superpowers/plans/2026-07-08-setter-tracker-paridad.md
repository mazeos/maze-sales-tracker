# Paridad tracker de setter — Fase 1 (extender mínimo) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar al catálogo de captura del setter las 4 métricas que faltan para paridad con el Google Sheet, para que el setter pueda jubilar la planilla.

**Architecture:** SPA `index.html` (vanilla JS, client-side). Los conteos del setter viven en `st_entries.metrics` (jsonb) y se renderizan dinámicamente desde el catálogo `METRICS.setter`. Agregar claves al catálogo hace aparecer los contadores en "Cargar día" y las tasas derivadas — sin migración de tabla ni cambios de backend.

**Tech Stack:** HTML + vanilla JS (sin framework, sin build). Verificación por presencia en el código (`grep`) + QA visual en el navegador.

## Global Constraints

- Copy en **español latino con tuteo** (consistente con el catálogo existente).
- **Solo conteos atómicos**, nunca porcentajes de entrada (las tasas se derivan).
- Camino **A — extender mínimo**: NO reestructurar el modelo de canales existente ni tocar el motor sombra (`api/metrics.js`). Solo agregar claves nuevas.
- Las 4 métricas nuevas son de **carga manual** (GHL no las provee con certeza).
- No tocar `st_entries` a nivel schema (las claves nuevas viven en el jsonb existente).
- Trabajar en la rama `feature/setter-tracker-paridad`.

---

### Task 1: Agregar las 4 métricas nuevas al catálogo de captura del setter

**Files:**
- Modify: `index.html` — objeto `METRICS.setter` (actualmente líneas 395–409, entre `seg_wpp` y `links_ig`)

**Interfaces:**
- Produces: 4 claves nuevas en `st_entries.metrics` (jsonb): `outbound_tk`, `resp_tk`, `ads_inbound`, `ads_seg`. La Task 2 consume `outbound_tk` y `resp_tk` para la tasa derivada.

- [ ] **Step 1: Insertar las 4 claves nuevas en `METRICS.setter`**

Ubicar el cierre del bloque `seg_wpp` (línea ~404) e insertar, INMEDIATAMENTE DESPUÉS de esa línea y antes de `{k:'links_ig'...}`, estas 4 entradas (agrupadas: TikTok primero, ADS después):

```javascript
    {k:'outbound_tk', label:'Outbound TikTok', def:'Mensajes en frío que YO inicié por TikTok.'},
    {k:'resp_tk', label:'Respuestas TikTok', def:'Respuestas obtenidas al outbound de TikTok.'},
    {k:'ads_inbound', label:'ADS inbound', def:'Personas que ME escribieron llegando desde un anuncio.'},
    {k:'ads_seg', label:'ADS seguimiento', def:'Seguimientos hechos a leads que llegaron por anuncios.'},
```

- [ ] **Step 2: Verificar que las 4 claves quedaron en el catálogo**

Run: `grep -c -E "outbound_tk|resp_tk|ads_inbound|ads_seg" index.html`
Expected: `4` o más (las definiciones; +1 si Task 2 ya agregó la tasa que referencia `outbound_tk`/`resp_tk`).

- [ ] **Step 3: Verificar que el HTML sigue sano (balance de tags de script)**

Run: `node -e "const h=require('fs').readFileSync('index.html','utf8'); const o=(h.match(/<script/g)||[]).length, c=(h.match(/<\/script>/g)||[]).length; console.log(o===c?'OK':'DESBALANCE')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(setter): agregar Outbound/Respuestas TikTok + ADS inbound/seguimiento al catálogo

Paridad con el Google Sheet de tracker de setter (camino A: extender mínimo).
4 conteos manuales nuevos en METRICS.setter; van al jsonb de st_entries (sin migración).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Agregar la tasa derivada "% respuesta outbound TikTok"

**Files:**
- Modify: `index.html` — catálogo de KPIs derivados del setter (buscar el objeto que contiene `label:'Conversaciones nuevas'` y `label:'Tasa link→agenda'`)

**Interfaces:**
- Consumes: claves `outbound_tk` y `resp_tk` de Task 1.

- [ ] **Step 1: Localizar el catálogo de KPIs derivados del setter**

Run: `grep -n "Tasa link→agenda" index.html`
Usar la línea devuelta para ubicar el array de KPIs del setter (termina en `],`).

- [ ] **Step 2: Agregar la tasa de TikTok al final de ese array**

Insertar como última entrada del array (después de `Tasa link→agenda`), respetando el patrón `pct:ds=>[numerador, denominador]`:

```javascript
      {label:'% respuesta outbound TikTok', def:'Respuestas ÷ outbound de TikTok.', pct:ds=>[get(ds,'resp_tk'), get(ds,'outbound_tk')]},
```

- [ ] **Step 3: Verificar presencia**

Run: `grep -c "% respuesta outbound TikTok" index.html`
Expected: `1`

- [ ] **Step 4: Verificar HTML sano**

Run: `node -e "const h=require('fs').readFileSync('index.html','utf8'); const o=(h.match(/<script/g)||[]).length, c=(h.match(/<\/script>/g)||[]).length; console.log(o===c?'OK':'DESBALANCE')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(setter): tasa derivada % respuesta outbound TikTok

Se deriva de resp_tk ÷ outbound_tk (Task 1). Nunca se carga a mano.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 (checkpoint human-verify, blocking): QA visual en pruebas

**Deliverable:** confirmar en la app que los contadores nuevos aparecen en "Cargar día" del setter y que la tasa de TikTok se calcula.

- [ ] **Step 1: Desplegar a pruebas**

Merge de `feature/setter-tracker-paridad` → `develop` (PR), deploy automático a `sales-tracker-test.mazefunnels.io`.

- [ ] **Step 2: Verificar en la UI**

Entrar como un setter (o admin), ir a "Cargar día", y confirmar:
- Aparecen 4 contadores nuevos: **Outbound TikTok, Respuestas TikTok, ADS inbound, ADS seguimiento** (tap +/−, sin porcentajes).
- Cargar valores de prueba (ej. Outbound TikTok = 10, Respuestas TikTok = 3) y confirmar que la tasa **% respuesta outbound TikTok** muestra 30% en el dashboard/KPIs del setter.
- Las definiciones (tooltips) de las 4 métricas se ven al pasar el mouse.

- [ ] **Step 3: Paridad contra el sheet**

Tomar un día real del sheet del setter y confirmar que TODAS las columnas del sheet tienen su equivalente cargable en la app (IG, TikTok incl. outbound/respuestas, WhatsApp, ADS, links, agendas). Anotar cualquier columna del sheet que aún no tenga equivalente.

**Resume-signal:** Escribir "aprobado" o describir qué falta.

---

## Self-Review

**Spec coverage:**
- Métricas nuevas (ADS inbound/seg, TikTok outbound/respuestas) → Task 1 ✓
- Tasas derivadas (% rta outbound TT) → Task 2 ✓
- Sin migración / motor sombra intacto → Global Constraints ✓
- Migración de Clara / apagar sheet → **Fase 2 (fuera de este plan)**, verificación de paridad iniciada en Task 3 Step 3
- EOD report → fuera de alcance (spec) ✓

**Placeholder scan:** sin TBD/TODO; código completo en cada step. ✓

**Type consistency:** `outbound_tk`/`resp_tk` definidas en Task 1 y usadas idénticas en Task 2. ✓

**Nota de decisión (camino A):** el sheet separa "TT seguimiento" de "Wh seguimiento"; en el modelo actual ambos caen en `seg_wpp`. Se acepta ese agrupamiento en Fase 1 (extender mínimo). Un modelo por-plataforma limpio (camino B) queda para una fase futura si se decide.
