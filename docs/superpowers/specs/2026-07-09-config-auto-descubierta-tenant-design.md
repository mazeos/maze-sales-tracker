# Config auto-descubierta por tenant — Diseño

**Fecha:** 2026-07-09
**Estado:** Diseño aprobado (brainstorming) → plan por fases → implementación
**Origen:** Visión de producto (Ale, 2026-07-09). Habilita que el motor sombra (Olas 1/2/3) funcione **solo, por cada subcuenta conectada**, sin configuración manual ni valores hardcodeados.

## Contexto y problema

El motor sombra hoy depende de config que se pone a mano o está hardcodeada: el calendario se elige de a uno (`st_integrations.calendar_id`, se borra al desconectar), los dominios de agenda están fijos en `st_kpi_config._config.booking_domains`, y no hay forma de que el admin de un tenant mapee su atribución (ADS) ni su tag de CTA. Resultado: escalar a N subcuentas exige tocar config a mano por cada una — no escala.

Además, el motor cruza agendas contra **un solo** calendario, pero un setter puede agendar en **varios**.

## Objetivo

Que cada subcuenta conectada se **auto-configure**: al integrarla (o al re-sincronizar), la app **trae de GHL vía API** los recursos que el motor necesita y los expone en **Configuraciones** para que el admin del tenant los mapee. El motor lee esa config por-tenant al calcular. **Regla central: todo se jala de GHL — nada hardcodeado, nada preguntado a mano.**

## El patrón (idéntico para cada recurso)

1. **Descubrir** — la mini-API hace fetch a la API de GHL de los recursos disponibles de la subcuenta (con el token OAuth del tenant). Corre al conectar la subcuenta y bajo demanda con un botón **"Re-sincronizar desde HighLevel"** (por si aparecen calendarios/campos/tags nuevos).
2. **Mapear** — el admin del tenant, en Configuraciones (gated admin), selecciona qué es qué. Persistido por-tenant.
3. **Consumir** — el motor sombra (`api/metrics.js` / worker) lee la config del tenant al calcular sus KPIs.

## Los 4 recursos (todos vía API GHL)

| Recurso | Se trae de GHL con | El admin mapea | Lo consume | Habilita |
|---|---|---|---|---|
| **Calendarios** | `GET /calendars/?locationId` (ya usado) | **Multi-select**: cuáles cuentan como agendas del setter | Cruce de agendas | Agendas (Ola 1) |
| **Dominios de agenda** | Derivados del **widget/slug URL de los calendarios** seleccionados (GHL expone la URL de booking de cada calendario) + editables | Confirmar/ajustar los dominios detectados | Detección de links enviados | Links |
| **Atribución (ADS)** | `contact.attributionSource` (nativo: `adId`/`adName`/`mediumId`) + `GET .../customFields` (UTM First/Latest) | La regla de "qué cuenta como ADS" (ej. `adId` presente, o `utm_medium` = paid) | Clasificar inbound como ADS | ADS (Ola 2) |
| **Tags** | `GET /locations/{id}/tags` (ya usado) | Cuál tag marca la CTA | Contar CTA | CTA (Ola 3) |

**Nota técnica ADS:** la atribución de anuncios NO vive en un custom field en los leads orgánicos (verificado: `utmMedium` null en orgánicos) — vive en el objeto nativo `attributionSource` del contacto (`adId`/`mediumId` para Meta). El mapeo de ADS es, entonces, **confirmar la regla de detección**, no elegir un campo. Los custom fields UTM quedan como señal secundaria.

## Modelo de datos

Sin tablas nuevas: se consolida la config del motor por tenant.
- **Calendarios de agendas del setter (multi):** `st_kpi_config._config.agenda_calendar_ids` (array de IDs). Se mantiene `st_integrations.calendar_id` para el **closer** (llamadas/asistencias) — propósito distinto, se maneja aparte (decisión Ale).
- **Dominios de agenda:** `st_kpi_config._config.booking_domains` (ya existe) — poblado por auto-descubrimiento desde los calendarios + editable.
- **Regla ADS:** `st_kpi_config._config.ads_rule` (ej. `{ mode: 'adId' }`).
- **Tag de CTA:** `st_kpi_config._config.cta_tag`.
- **Catálogos descubiertos** (para poblar los selects de la UI sin re-consultar GHL en cada render): cacheados por tenant (calendarios, tags) — en `_config.discovered` o consultados on-demand vía endpoints existentes.

El motor (`computeMemberKpis`) recibe esta config en su `ctx` (hoy ya recibe `calendarId` y `bookingDomains`; se amplía a `agendaCalendarIds`, `adsRule`, `ctaTag`).

## Alcance

### Dentro
- El patrón descubrir→mapear→consumir para los 4 recursos.
- UI en Configuraciones (gated admin) por-tenant: multi-select de calendarios, dominios editables, regla ADS, tag CTA + botón "Re-sincronizar desde HighLevel".
- Motor lee la config del tenant (múltiples calendarios de agenda, dominios, regla ADS, tag CTA).
- Funciona para **todas** las subcuentas conectadas (el worker ya itera por org; cada una usa su config).

### Fuera
- La detección real de ADS/CTA en el motor (eso es Ola 2 / Ola 3; acá solo se provee la **config** que esas olas consumirán).
- Instrumentar ManyChat para que aplique el tag de CTA (operación, Ola 3).
- Graduación a auto-escritura (Fase B del motor).

## Fases de implementación

1. 🟢 **Multi-calendario (agendas)** — el panel pasa de un calendario a multi-select; `agenda_calendar_ids`; el motor cruza agendas contra todos. **Destraba el QA real de agendas.** Es la pieza rápida.
2. **Dominios de agenda** — auto-derivar de los calendarios seleccionados (widget URL) + edición; el motor los usa (ya los usa, pero desde config poblada, no hardcode).
3. **Atribución ADS** — descubrir/confirmar la regla; el motor la consumirá en la Ola 2.
4. **Tag de CTA** — descubrir tags + mapear; el motor lo consumirá en la Ola 3.

Cada fase de config va de la mano con la Ola del motor que habilita.

## Criterios de éxito

1. Al conectar una subcuenta, el admin ve en Configuraciones los calendarios/tags **reales de esa subcuenta**, traídos de GHL, sin nada hardcodeado.
2. El admin puede marcar **varios** calendarios como "agendas del setter" y el motor cuenta las citas de **todos** ellos.
3. La config es **por-tenant**: dos subcuentas distintas tienen sus propios calendarios/dominios/tags, aisladas.
4. Un botón "Re-sincronizar desde HighLevel" refresca los catálogos descubiertos.
5. El motor sombra lee la config del tenant (no valores hardcodeados) al calcular.

## Fuera de alcance explícito
- Detección de ADS/CTA en el motor (Olas 2/3).
- Instrumentación de ManyChat (CTA).
- Multi-calendario para el closer (hoy uno; fuera de este proyecto).
