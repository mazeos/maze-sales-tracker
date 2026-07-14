# Desglose de contactos en la Vista Tabla + tooltips de métricas — Design

**Fecha:** 2026-07-14
**Rama:** `feature/desglose-contactos-tabla` (sale de `feature/sync-usuarios-ghl-visita`)
**Cadena de PRs pendiente:** `super-entrar-org` → `sync-usuarios-ghl-visita` → esta.

## Problema

En la Vista Tabla ("Día por día"), cuando se traen los datos de HighLevel los números aparecen
pero son **opacos**: no hay forma de ver qué contactos componen cada número, ni de ir a
HighLevel a verificar que la data esté bien atribuida. Y las etiquetas de las métricas tienen
un tooltip de una frase, insuficiente para auditar si el número es correcto.

## Hallazgo que cambia el costo del trabajo

`computeMemberKpis` (`api/metrics.js`) **ya devuelve `{values, contacts}`** — el desglose de
contactos por KPI, con el `contactId` real de GHL:

```js
contacts[kpi] = [{ id: 'pt72J5fwyVgHFTCzegma', name: 'Keira Solórzano', count?: 2 }]
```

Pero `captureGhl` (`api/server.js`, el endpoint que usan **⚡ Autocompletar** y el botón
**"Traer de HighLevel"**) se queda solo con `result.values` y **descarta `result.contacts`**.
El dato ya se computa; no se guarda ni se expone.

El worker nocturno del modo sombra sí los persiste: hay 877 filas en `st_shadow_metrics`, y la
columna `contacts` (jsonb, migración 017) está poblada. Su clave única es
`(member_id, metric_date, kpi)` — exactamente el eje de la Vista Tabla.

## Arquitectura

### 0. Backend — unificar el camino del closer con el motor

`captureGhl` tiene hoy **dos implementaciones distintas**:
- **setter / triage** → llama a `computeMemberKpis` (el motor del modo sombra), que devuelve
  `{values, contacts}`.
- **closer** → trae los eventos del calendario **por su cuenta**, con una copia de la lógica de
  citas. No genera contactos, y calcula menos métricas que el motor (le faltan `segundas`,
  `cancelados`, `reservas`, `revenue`, `cash_cuotas`).

Son dos implementaciones de la misma regla, que pueden divergir.

**Decisión (Alejandro, 2026-07-14): unificar.** El closer pasa a usar `computeMemberKpis` como
el resto. Consecuencias:
- Gana el desglose de contactos (el motor hace `bump(kpi, contactId)` en `kpisCitas`).
- El ⚡ Autocompletar del closer empieza a traer también `segundas`, `cancelados`, `reservas`,
  `revenue` y `cash_cuotas`, que hoy se cargan a mano.
- Se elimina la lógica duplicada.

**Riesgo a controlar:** toca un camino que hoy funciona bien. La verificación tiene que
confirmar que `llamadas`, `asistencias` y `no_shows` devuelven **exactamente los mismos
números** que antes para un mismo día y closer. Si cambian, se investiga antes de seguir.

Para eso, `computeMemberKpis` necesita `salesRows` y `cuotasRows` (hoy `captureGhl` se los pasa
vacíos al setter). Hay que leerlos de `st_sales` / `st_cuotas` como ya hace el bloque de cierres.

### 1. Backend — persistir lo que ya se calcula

`captureGhl` pasa a:
- Devolver `contacts` junto con `metrics` en la respuesta.
- **Hacer upsert en `st_shadow_metrics`** (`on_conflict=member_id,metric_date,kpi`) escribiendo
  `org_id`, `member_id`, `metric_date`, `kpi`, `auto_value`, `contacts`, `computed_at`.

**Crítico:** el upsert **NO debe pisar `manual_value`** — esa columna la escribe el worker
nocturno del modo sombra y es la base del cálculo de match de la calibración. Solo se tocan
`auto_value`, `contacts` y `computed_at`.

Escribe con service key (la tabla es solo-service-role-escribe por diseño, migración 012).
La org efectiva sale de `effectiveOrg` como en el resto del handler (modo visita ya soportado).

### 2. Frontend — el punto en la celda

La Vista Tabla (`renderTable()`, `index.html`) lee `st_shadow_metrics` por
`member_id` + rango de fechas del mes visible (una sola query vía supabase-js, igual que
`loadShadow()`), y arma un índice `contactsByKey[`${kpi}|${fecha}`] = [{id, name, count}]`.

Cada celda de métrica es hoy un `<input type="number">` editable con un clic. **No se toca esa
edición.** Se agrega un punto lima en la esquina de la celda cuando esa combinación
`(kpi, fecha)` tiene contactos. Click en el punto → panel con la lista.

El panel reusa el patrón que ya existe en `recapHoy()` (panel de calibración):
- Nombre del contacto, `×N` si aportó más de uno.
- Deep-link white-label: `https://app.mazefunnels.com/v2/location/${GHL_LOC}/contacts/detail/${c.id}`
- Si `GHL_LOC` no cargó todavía, se muestra el nombre sin link (nunca un link roto).

**Efecto secundario buscado:** el punto distingue de un vistazo qué números vinieron de
HighLevel y cuáles se cargaron a mano.

**Sin punto** (no tienen contacto detrás, por diseño):
- Los 4 montos ($): `cash_nuevo`, `cash_cuotas`, `reservas`, `revenue`.
- Las tasas derivadas (`derivedRows()`): son cocientes de otras métricas.
- Las manuales puras: `cta`, `ads_inbound`, `ads_seg` (setter); todo triage
  (`agendadas`, `asistencias`, `no_shows`, `pases`); `disponibilidad`, `ofertas`, `referidos`
  (closer).

### 3. Frontend — tooltips con la regla exacta

La infraestructura ya existe: cada fila de métrica tiene `data-tip="${mt.def}"` (el campo `def`
del catálogo `METRICS`), y un listener global lo pinta en una `.tipbox`.

Se reescriben los ~36 textos `def` con **definición de negocio + regla exacta de cálculo**,
para que sirvan de instrumento de auditoría. Cada tooltip auto debe decir: qué observa en GHL,
qué condición aplica, cómo dedupe, y el caso borde relevante.

Ejemplo (`outbound`):

> Outbound — Vos abriste la conversación con un contacto nuevo.
> Regla: el contacto fue dado de alta en el CRM ese mismo día, y el primer mensaje de la
> conversación es tuyo (humano, no ManyChat) y salió ese día. Se cuenta 1 por contacto, no por
> mensaje. TikTok va aparte, en Outbound TikTok.

Las métricas manuales lo dicen explícitamente ("Se carga a mano: HighLevel no puede
detectarla"). Las tasas muestran su fórmula (`% Cierre = cierres ÷ ofertas`).

**Cambio técnico necesario:** el tooltip se pinta con `textContent`, así que los saltos de
línea no se renderizan. Agregar `white-space: pre-line` al CSS de `.tipbox`. No se convierte a
HTML (evita inyección y no hace falta).

Las reglas exactas de cada KPI están documentadas en el informe de mapeo de esta sesión y se
derivan de `api/metrics.js` — hay que leer el motor, no inventarlas.

### 4. `inbound_wpp_sin_canal` — la métrica huérfana

`api/metrics.js` calcula la clave `inbound_wpp_sin_canal`: inbounds de WhatsApp cuyo canal de
origen NO se pudo resolver (ni por un custom field con `utm_source`, ni por un tag `origen:`).

**Esa clave no existe en el catálogo `METRICS` de la UI** → esos contactos se calculan y se
**pierden en silencio**. No aparecen en `inbound_wpp_ig`, ni en `inbound_wpp_tk`, ni en ningún
lado. Es una fuga de datos que rompe justamente la auditoría que esta feature busca habilitar.

**Decisión (Alejandro, 2026-07-14): se agrega como métrica propia** al catálogo del setter,
etiqueta "Inbound Wpp (sin canal)". Tiene desglose de contactos como cualquier otra, así que se
puede ir a GHL a entender por qué no se resolvieron y arreglarlos de raíz.

Su tooltip debe explicar la causa: "Llegó por WhatsApp pero no pudimos determinar si vino de
Instagram o TikTok — al contacto le falta el `utm_source` o el tag `origen:`. Revisalo en GHL."

## Alcance explícito — qué NO se hace

| Fuera de alcance | Por qué |
|---|---|
| Recalcular contactos en vivo al abrir el panel | Decisión: el desglose sale de lo guardado. Los días que nunca se trajeron de HighLevel no tienen punto hasta que se traigan. |
| Desglose en el total del mes (la columna de la derecha) | Se evaluó y se descartó: alcanza con el detalle por día. |
| Cambiar cómo se edita la celda | El `<input>` sigue igual. El punto es un elemento aparte. |
| Arreglar la resolución de canal de WhatsApp | Esta feature solo **expone** los no resueltos. Arreglar la causa (instrumentar `utm_source`/tags) es otro trabajo. |

## Verificación

- **Backend:** tras un "Traer de HighLevel" de un rango, `st_shadow_metrics` tiene filas con
  `contacts` pobladas para esos días, y los `manual_value` preexistentes **siguen intactos**
  (verificar con una fila que ya tenía `manual_value` antes).
- **Frontend:** en la Vista Tabla de un miembro con datos traídos de GHL, las celdas de conteo
  auto muestran el punto; las de monto, tasa y manuales NO. El panel abre la lista con los
  nombres y el link lleva a la ficha correcta del contacto en GHL.
- **No-regresión:** el `<input>` de la celda sigue editable con un clic y `tblEdit` sigue
  guardando igual.
- **Tooltips:** cada métrica del catálogo tiene un `def` nuevo, con saltos de línea que se
  renderizan.

## Constraints

- Base Supabase **compartida** por todos los tenants (Clara corre en prod). Deploy solo a
  `sales-tracker-test.mazefunnels.io`. **No promover a main/prod** sin QA de Alejandro.
- `st_shadow_metrics` es **solo-service-role-escribe** (migración 012): el frontend la LEE por
  RLS, nunca la escribe.
- Idioma de la UI: castellano rioplatense.
- Sin dependencias nuevas: `api/server.js` es Node sin deps, `index.html` es vanilla JS.
- Las reglas de los tooltips deben derivarse leyendo `api/metrics.js`. Un tooltip que describa
  mal una regla es peor que no tener tooltip: el usuario lo va a usar para decidir si un número
  está bien o mal.
