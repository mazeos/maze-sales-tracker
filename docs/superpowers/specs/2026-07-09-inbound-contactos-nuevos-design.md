# Inbound/outbound por contacto nuevo vs existente — Diseño

**Fecha:** 2026-07-09
**Estado:** Diseño aprobado (brainstorming) → plan → implementación
**Origen:** Feedback de Ale (2026-07-09) durante el QA del desglose. El motor infla `inbound` porque cuenta cualquier conversación con un entrante ese día, sin distinguir si el contacto es nuevo o ya existía.

## Contexto y problema

Hoy el motor (`api/metrics.js`, rama setter) clasifica las conversaciones así:
- `outbound` / `outbound_tk`: primer mensaje de la conversación es saliente humano de hoy (apertura).
- `inbound_*`: **cualquier** conversación con un mensaje entrante hoy.
- `respuestas` / `resp_tk`: entrante de hoy posterior a un saliente humano previo.

Problema: un contacto que **ya existía** y hoy vuelve a escribir se cuenta como `inbound`, inflando la métrica de leads nuevos. `inbound` debe medir **leads nuevos que entran**, no reactivaciones.

## Objetivo

Clasificar la actividad del setter según **si el contacto es nuevo (alta hoy) o ya existía**, usando `contact.dateAdded` de GHL (verificado: el objeto contacto trae `dateAdded` en ISO UTC). El eje es contacto-nuevo-vs-viejo, comparando la fecha de alta contra el día en la TZ de la org (mismo `tzDayRange`/`inDay` ya usado).

## Regla (definición de métricas)

Por conversación del setter, con su primer mensaje (`msgs[0]`) y la fecha de alta del contacto (`esNuevo = inDay(contact.dateAdded)`):

| Contacto | Primer mensaje / actividad | Métrica |
|---|---|---|
| **Nuevo** (alta hoy) | saliente humano de hoy (vos abriste) | `outbound` (o `outbound_tk` en TikTok) |
| **Nuevo** (alta hoy) | entrante (el lead escribió primero) | `inbound_ig` / `inbound_tk` / `inbound_wpp_*` según canal |
| **Existente** (alta anterior a hoy) | entrante de hoy (el lead te escribe) | `respuestas` (o `resp_tk` en TikTok) |
| **Existente** (alta anterior a hoy) | saliente humano de hoy en conv que no abrió hoy | `seg_ig` / `seg_wpp` / `seg_tk` (**sin cambios**) |

En una línea: **inbound/outbound = actividad de leads NUEVOS (alta hoy); respuestas = entrantes de contactos que YA existían.**

### Cambios vs. la lógica actual
- `outbound` / `outbound_tk`: agregar la condición `esNuevo`. Un saliente humano de apertura a un contacto que ya existía deja de contar como outbound (es seguimiento/reactivación).
- `inbound_*`: pasa de "cualquier entrante hoy" a "`esNuevo` **y** primer mensaje entrante".
- `respuestas` / `resp_tk`: pasa de "entrante posterior a saliente previo" a "entrante de hoy de un contacto **no** nuevo".
- `seg_*`, `bienvenidas`, `links_*`, `agend_*`: **sin cambios**.

## Implementación (motor)

1. **Traer el contacto en todos los canales.** Hoy el motor solo hace `GET /contacts/{id}` en WhatsApp (para el canal por `utm_source`). Se extiende a IG y TikTok para leer `dateAdded`. Se hace **una vez por conversación con actividad** y se cachea (junto con el nombre que ya se cachea para el desglose). Respeta el throttle 10 req/s + retry 429 existente.
2. **`esNuevo = inDay(contact.dateAdded)`** en la TZ de la org.
3. **Reescribir la clasificación** del bloque de conteos del setter según la tabla de arriba. Los `bump(...)` del desglose de contactos acompañan a cada métrica (se recolocan junto a los conteos nuevos).

## Alcance

### Dentro
- Redefinición de `outbound`/`outbound_tk`, `inbound_*`, `respuestas`/`resp_tk` según contacto nuevo vs existente.
- Traer `dateAdded` del contacto en todos los canales.

### Fuera
- `bienvenidas` (apertura automática de ManyChat) — sin cambios.
- Métricas del closer (citas) — sin cambios.
- Desglose de contactos (ya implementado) — se mantiene; los `bump` se reubican con la lógica nueva.

## Criterios de éxito

1. Un contacto con alta anterior a hoy que escribe hoy cuenta como `respuesta`, no como `inbound`.
2. Un contacto con alta de hoy que te escribió primero cuenta como `inbound` (por canal).
3. Un contacto con alta de hoy al que vos abriste cuenta como `outbound` (todos los canales), no como inbound.
4. Un saliente a un contacto que ya existía sigue contando como `seguimiento`, no como outbound.
5. Los conteos coinciden con lo que se ve en GHL (validado en el QA real con el desglose de contactos).

## Fuera de alcance explícito
- Cambiar `bienvenidas`, las métricas del closer, o el desglose ya construido.
- Separar `outbound` por canal ig/wpp (sigue siendo `outbound` total + `outbound_tk`).
