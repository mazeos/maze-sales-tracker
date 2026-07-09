# Motor sombra al 100% — Ola 1 (solo código) — Diseño

**Fecha:** 2026-07-09
**Estado:** Diseño (pendiente aprobación) → plan → implementación
**Origen:** Auditoría de la subcuenta GHL de Maze (2026-07-09, verificada con conversaciones + contactos reales). Objetivo del negocio: que el motor sombra auto-mida la **mayor cantidad posible** del tracker de setter.

## Contexto (evidencia de la auditoría)

El motor sombra (`api/metrics.js`) hoy auto-calcula ~9 métricas del setter (outbound IG, inbound IG/WhatsApp, respuestas, seguimientos, links) desde las conversaciones de GHL. Quedaban "manuales". La auditoría confirmó con datos reales que **varias de esas manuales SÍ son auto-medibles hoy, sin instrumentación nueva** — solo falta código:

- **TikTok está conectado**: aparecen conversaciones `TYPE_TIKTOK` reales (el motor hoy las ignora a propósito, `metrics.js:127`).
- **Bienvenidas detectables**: GHL marca cada mensaje saliente como `automated` (ManyChat) o `manual`. El motor hoy descarta los `automated`.
- **Agendas**: las citas están en GHL (`calendars/events`) con `contactId`; el motor ya sabe a qué contactos el setter les mandó el link de agenda → se puede atribuir la agenda al setter cruzando ambos.

Fuera de esta ola (por depender de más que código): **ADS** (necesita validar `attributionSource.adId` con un lead de anuncio real → Ola 2) y **CTA** (el tag `seguimiento cta` no se aplica solo hoy → requiere instrumentar ManyChat → Ola 3). **Facebook/Messenger** (`TYPE_FACEBOOK`) existe pero el tracker del setter no lo mide → futuro.

## Objetivo

Subir la auto-medición del setter de ~50% a **~85%**, agregando al motor sombra: **TikTok nativo**, **bienvenidas** y **agendas** — todo desde datos que GHL ya tiene, sin instrumentación nueva.

## Alcance

### Dentro
1. **TikTok nativo** (`TYPE_TIKTOK`): auto-calcular outbound, inbound, respuestas y seguimientos de TikTok.
2. **Bienvenidas**: contar los mensajes salientes `automated` de ManyChat (hoy descartados).
3. **Agendas** (`agend_ig` / `agend_wpp`): atribuir al setter las citas de GHL cuyo contacto recibió un link de agenda suyo.

### Fuera
- ADS (Ola 2), CTA (Ola 3), Facebook/Messenger (futuro).
- Cambios a la carga manual del catálogo (el setter ya puede cargar todo; esto solo lo *auto-completa*).

## Diseño técnico

Todo en `api/metrics.js` (`computeMemberKpis`, rama `member.role === 'setter'`), más 2 claves nuevas en el catálogo `METRICS.setter` de `index.html`. Se respeta la regla de oro del módulo: re-filtrar fechas client-side por TZ de la org; contar solo lo que corresponde.

### 1. TikTok nativo — `TYPE_TIKTOK`
Hoy el canal se clasifica en IG (`TYPE_INSTAGRAM`) o WhatsApp (`TYPE_SMS/CUSTOM_SMS`). Se agrega un tercer canal TikTok:
- Nueva constante `TK_TYPES = new Set(['TYPE_TIKTOK'])`.
- Para conversaciones TikTok, alimentar las claves de TikTok del catálogo:
  - `outbound_tk` (apertura: primer saliente humano del día), `resp_tk` (entrante tras saliente humano previo), `inbound_tk` (conversación con entrante hoy), `seg_tk` (saliente humano de hoy en conversación que no abrió hoy).
- **Decisión de modelado (a validar):** el TikTok *nativo* (`TYPE_TIKTOK`) NO se mezcla con el WhatsApp-de-TikTok (`inbound_wpp_tk`, que ya existe y mide leads de TikTok derivados a WhatsApp). Son dos cosas distintas y se cuentan por separado. Se agregan al catálogo 2 claves nuevas: `inbound_tk` ("Inbound TikTok") y `seg_tk` ("Seguimientos TikTok") — junto a `outbound_tk`/`resp_tk` que ya existen (Fase 1 de paridad).

### 2. Bienvenidas — mensajes `automated`
- Hoy `humanOut(m)` exige `source === 'app' || !source` (humano). Las bienvenidas de ManyChat son salientes `automated`.
- Contar como `bienvenidas` los salientes cuyo `lastOutboundMessageAction`/`source` es automatizado y que son el mensaje de apertura automático del día (IG). Se define un helper `isAutoWelcome(m)` que identifica el saliente automático inicial.
- **Decisión (a validar):** las bienvenidas se cuentan solo en IG (donde opera ManyChat), no en WhatsApp. Ajustable si ManyChat también corre en WhatsApp.

### 3. Agendas — cruce link ↔ cita
- El motor ya identifica, por conversación, los links de agenda que el setter envió hoy (`links_ig`/`links_wpp`, content-match del dominio). Se registra el `contactId` de esas conversaciones (los "contactos linkeados" del setter).
- Se consultan las citas del período (`calendars/events`) y, para cada cita cuyo `contactId` está en los contactos linkeados del setter, se atribuye una agenda:
  - `agend_ig` si el link fue por IG, `agend_wpp` si fue por WhatsApp (según el canal por el que el setter mandó el link a ese contacto).
- **Decisión (a validar):** ventana de atribución = la cita se cuenta si el contacto recibió el link **en los últimos N días** (propuesto: 7) previos a la creación de la cita. Evita atribuir citas viejas o de otro origen.
- **Riesgo conocido:** `createdBy.userId` de la cita suele ser null (booking widget), por eso NO se usa para atribuir; el cruce por link es el mecanismo. Si un contacto recibió links de dos setters, se atribuye al del link más reciente.

## Criterios de éxito

1. El motor calcula automáticamente, para un setter con GHL vinculado: outbound/inbound/respuestas/seguimientos de **TikTok**, **bienvenidas** (IG), y **agendas** (IG/WhatsApp) — además de lo que ya calculaba.
2. Se mantiene el **modo sombra**: el worker escribe en `st_shadow_metrics`, nunca pisa `st_entries`. El panel de calibración muestra auto vs manual para las nuevas.
3. Las 2 claves nuevas (`inbound_tk`, `seg_tk`) aparecen en el catálogo del setter (carga manual + tooltip).
4. Verificado contra datos reales de la subcuenta de Maze: los conteos de TikTok/bienvenidas/agendas del motor coinciden razonablemente con lo observable en GHL para un día dado.

## Fuera de alcance explícito
- ADS (Ola 2): requiere validar `attributionSource.adId` con un lead de anuncio real.
- CTA (Ola 3): requiere que ManyChat aplique el tag `seguimiento cta` (instrumentación).
- Facebook/Messenger: el tracker del setter no lo mide todavía.
- Graduación a auto-escritura (Fase B del motor): esto sigue siendo modo sombra.
