# Paridad del tracker de setter — la app reemplaza el sheet

**Fecha:** 2026-07-08
**Estado:** Diseño aprobado (brainstorming), pendiente plan de implementación
**Origen:** Auditoría del Google Sheet "Tracker para setter" (setter de Clara) — la app cubre casi todo el modelo de la planilla salvo 2 categorías de captura.

## Contexto

El setter de Clara trackea su actividad diaria en un Google Sheet (DMs de IG/TikTok/WhatsApp/ADS → links → agendas). La app ya captura casi todo ese modelo, pero le faltan métricas para lograr **paridad total** y jubilar la planilla. Además, la planilla tiene problemas estructurales (fórmulas que se rompen sin datos — ej. "700%", días vacíos que cuentan como 0% y ensucian promedios, columnas ambiguas donde un "link" cae en "agendas") que la app resuelve por diseño (tasas derivadas robustas, roll-ups automáticos, dato tomado de GHL donde es certero).

## Objetivo

Que la app cubra el **100%** del tracker de setter para que Clara (y cualquier tenant) pueda **jubilar el sheet**, empezando por el setter de Clara.

## Alcance

### Dentro
1. **Métricas de captura nuevas** del setter, para paridad con el sheet:
   - `ADS inbound` — leads que entran por publicidad.
   - `ADS seguimiento` — seguimientos a leads de ADS.
   - `TikTok outbound` — mensajes salientes (prospección) en TikTok.
   - `TikTok respuestas` — respuestas al outbound de TikTok.
2. **Tasas derivadas** asociadas (ej. `% respuesta outbound TikTok`), calculadas en el front como las existentes.
3. **Revisar la desagregación TikTok vs WhatsApp**: hoy la app agrupa ambos en algunas claves (`inbound_wpp_tk`); el sheet los separa. El plan define si se desagrega para paridad exacta o se mantiene el agrupado con etiqueta clara.
4. **Migración del setter de Clara** al flujo de la app + apagado del sheet.

### Fuera (fases posteriores)
- **EOD Report** (el texto concatenado del día que se copia/manda). Se define más adelante.
- Cambios al motor sombra para las métricas nuevas (ver "Manual vs auto").

## Manual vs auto (hallazgo técnico)

Principio del producto: **híbrido siempre** — auto solo lo que GHL sabe con certeza; manual el resto; nunca inventar números.

- **IG y WhatsApp**: el motor sombra ya los auto-calcula desde GHL (sin cambios). Siguen igual.
- **ADS inbound/seguimiento**: GHL **no marca de forma confiable** si un DM vino de un anuncio → **manual**.
- **TikTok outbound/respuestas**: TikTok **no sincroniza sus DMs a GHL** como sí lo hace Instagram → **manual**.

Conclusión: las 4 métricas nuevas son de **carga manual**. No requieren extender el motor sombra. (Si a futuro se define atribución de ADS por UTM/custom field, se reevalúa — fuera de scope.)

## Diseño técnico

Stack real: SPA `index.html` (captura + cálculo en cliente) + Supabase. Los conteos del setter viven en `st_entries.metrics` (jsonb) → **agregar claves nuevas NO requiere migración de tabla**.

1. **Catálogo de captura** (`METRICS.setter` en `index.html`): agregar las 4 claves nuevas con su `label`, `def` (tooltip del diccionario) y agrupación por canal (bloque ADS + bloque TikTok con outbound/respuestas).
2. **KPIs derivados** (catálogo de dashboard del setter): sumar la tasa `% respuesta outbound TikTok` y, si aplica, incorporar ADS a "Conversaciones nuevas"/totales de canal.
3. **UI de "Cargar día"**: las nuevas aparecen como contadores atómicos (tap +/−), consistentes con el resto; nunca porcentajes.
4. **Diccionario embebido**: definición de cada métrica nueva (fuente única de verdad de la definición).

## Secuencia (por fases)

- **Fase 1 — Paridad de carga.** Métricas nuevas + tasas + diccionario. Con esto el setter **ya puede dejar el sheet**. Es el ~80% del valor y no toca backend/DB.
- **Fase 2 — Migrar a Clara.** Onboarding del setter al flujo, confirmar paridad real contra su planilla, apagar el sheet.
- **Fase 3 (después) — EOD report** y refinamientos.

Alternativa descartada: hacer todo en un release (paridad + migración + EOD). Da valor más tarde y arriesga más; la Fase 1 sola ya jubila el sheet.

## Criterios de éxito

1. Un setter puede cargar en la app **exactamente las mismas métricas** que el sheet (IG, TikTok incl. outbound/respuestas, WhatsApp, ADS, links, agendas), solo con conteos atómicos.
2. Las tasas del sheet (% rta bienvenida, % rta outbound, % rta outbound TT, % agendamiento) se derivan solas y **no se rompen** con días incompletos (muestran "—", no 0%/700%).
3. Cada métrica nueva tiene su definición en el diccionario embebido.
4. El setter de Clara opera un día completo en la app con paridad verificada contra su planilla, y el sheet queda jubilado.

## Fuera de alcance explícito
- EOD report (texto/envío automático).
- Auto-carga de ADS/TikTok (no son certeros desde GHL).
- Métricas de triage/closer/ventas (este tracker es solo del setter).
