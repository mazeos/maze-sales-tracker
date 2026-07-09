# Desglose de contactos por métrica en el recap — Diseño

**Fecha:** 2026-07-09
**Estado:** Diseño aprobado (brainstorming) → plan → implementación
**Origen:** Idea de Ale (2026-07-09). Cada número del recap del día (modo sombra) debe poder abrirse para ver los contactos que lo componen, cada uno con link directo a su ficha en HighLevel — para auditar/calibrar el motor de un vistazo.

## Contexto y problema

El recap del día muestra métricas **agregadas** por miembro (ej. `agend_ig: 3`). El motor (`api/metrics.js`) recorre contacto por contacto para contar, pero **descarta los `contactId`** y guarda solo el número en `st_shadow_metrics`. No hay forma de ver *quiénes* forman cada número ni de saltar a ese contacto en GHL para verificar.

El deep-link a un contacto en GHL **ya existe y funciona** en la app (aviso de cierre y botón 💬 de Ventas): `https://app.mazefunnels.com/v2/location/{locationId}/contacts/detail/{contactId}` (white-label — nunca `app.gohighlevel.com`).

## Objetivo

Que cada número del recap del día se pueda **expandir (acordeón inline)** y mostrar la lista de contactos que lo componen, cada uno con **nombre + link a su ficha en HighLevel**. La foto de contactos coincide exactamente con el número (misma corrida).

## Decisión de arquitectura

**Persistir el desglose en la corrida** (approach A). El motor ya tiene los contactos en memoria mientras cuenta; en vez de tirarlos, arma la lista por métrica, resuelve nombres y la guarda junto al conteo. El recap la lee al instante.

Descartados: (B) recalcular on-demand al tocar — lento y caro, el motor pagina todas las conversaciones; (C) híbrido IDs-guardados/nombres-al-tocar — latencia en el click y dos fuentes de datos.

## Modelo de datos

Sin tablas nuevas. Se agrega una columna a `st_shadow_metrics`:

- **`contacts`** (`JSONB`, nullable, default `null`): array `[{ id, name, count? }]` de los contactos que componen esa métrica.
  - `count` solo se incluye cuando el contacto aporta más de 1 al número (ej. 2 links enviados, o 2 citas el mismo día). Ausente = aporta 1.
  - Métricas sin contacto identificable (tasas %, montos como `cash_nuevo`/`revenue`/`reservas`) quedan en `null`.

La fila de `st_shadow_metrics` sigue siendo `(org_id, member_id, metric_date, kpi, auto_value, manual_value, computed_at)` + la nueva `contacts`. El upsert existente (`on_conflict=member_id,metric_date,kpi`) incluye la columna nueva.

## Motor (`api/metrics.js`)

1. **Acumular contactos por KPI** mientras cuenta, en un mapa paralelo a `out`:
   - Setter: `outbound`/`outbound_tk`, `bienvenidas`, `inbound_*`, `respuestas`/`resp_tk`, `seg_*`, `links_ig`/`links_wpp` (con count por nº de links), `agend_ig`/`agend_wpp`.
   - Closer: `llamadas`, `asistencias`, `no_shows`, `cancelados`, `segundas` (contactId de cada cita).
2. **Resolver nombres** al final: un fetch `GET /contacts/{id}` por **contacto único** del día (deduplicado sobre la unión de todos los KPIs), reutilizando los contactos ya traídos durante el conteo (WhatsApp ya hace ese fetch). Respeta el throttle 10 req/s + retry 429 ya existente.
3. **Retorno**: `computeMemberKpis` pasa de devolver `out` (números) a devolver `{ values: out, contacts: { [kpi]: [{id, name, count?}] } }`. Se actualizan los callers (`runShadowForOrg`).

## Worker (`api/server.js` — `runShadowForOrg`)

Al armar las `rows` para el upsert, adjuntar `contacts: contactsByKpi[kpi] || null` a cada fila, junto al `auto_value` que ya se guarda. Sin otros cambios de flujo (scheduler y `POST /api/shadow/run` intactos).

## Frontend (`index.html` — recap del día)

- El recap (`recapHoy`) lee `contacts` de cada fila de `st_shadow_metrics` (se agrega al `select` que ya trae la sombra).
- Cada número/chip que tenga `contacts` no vacío se vuelve **clickable** → toggle de un **acordeón inline** debajo que lista, por contacto: `nombre` (+ `×count` si aplica) → link `🔗 abrir en GHL` (`app.mazefunnels.com/v2/location/{GHL_LOC}/contacts/detail/{id}`, `target=_blank`).
- Números sin contactos (tasas, montos) no son clickables.

## Alcance

### Dentro
- Columna `contacts` en `st_shadow_metrics` + migración.
- Motor: acumula contactos por KPI, resuelve nombres dedup, cambia el retorno.
- Worker: persiste `contacts`.
- Recap del día: acordeón inline con nombre + deep-link GHL.

### Fuera
- La tabla de **calibración histórica** (KPI × último día) — queda igual por ahora.
- Desglose de métricas de **monto** (cash/revenue/reservas) — son sumas de dinero, no listas de contactos.
- Backfill de corridas viejas — el desglose aparece a partir de la primera corrida nueva.

## Criterios de éxito

1. Al correr "Recap del día", cada número contable por contacto guarda su lista de contactos con nombre.
2. En el recap, tocar un número despliega los contactos que lo forman; cada uno abre su ficha en HighLevel (white-label).
3. La cantidad de contactos del desglose coincide con el número (con `count` para los que aportan más de 1).
4. Las métricas sin contacto (tasas, montos) no son clickables y no rompen la vista.
5. El costo de nombres queda acotado: un fetch por contacto único del día, no uno por métrica.

## Fuera de alcance explícito
- Calibración histórica y backfill.
- Desglose de montos.
- Cambios en cómo se calcula cada número (la lógica del motor no cambia, solo deja de descartar los contactos).
