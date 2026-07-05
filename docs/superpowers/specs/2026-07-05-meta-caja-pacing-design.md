# Diseño — Meta de caja mensual con pacing

**Fecha:** 2026-07-05
**Proyecto:** Maze Sales Tracker IA (`/docker/maze-sales-tracker-dev`)
**Estado:** Aprobado por Alejandro (sesión 2026-07-05)
**Depende de:** feature Caja/cuotas (usa los totales front/back de la vista Caja)

## Problema

Las metas actuales son de actividad semanal (cierres, cash del contador). No existe una meta de **plata cobrada del mes** ni una lectura de ritmo: "¿llegamos o no llegamos?".

## Decisiones

- **Un solo número**: meta mensual de caja total (front + back juntos).
- **Se fija en Metas** (solo admin), **se ve en Caja** (todos).
- Pacing consciente del calendario, en la zona horaria de la org.

## Datos

**Cero migraciones.** Se reusa `st_goals` (ya tiene `unique(org_id, period)` y RLS admin-escribe / todos-ven):

- Fila nueva: `{org_id, period: 'month', goals: {caja: N}}`
- `loadFromSupabase` suma la query de la fila `period='month'` → `DB.goals.month = {caja: N}`
- Guardado: upsert `on_conflict org_id,period` (mismo patrón que la fila `week` en `pushToSupabase`)

## Lógica de pacing (mes actual, TZ de la org vía `todayStr()`)

- `cobrado` = front + back del mes calendario en curso (mismas sumas que la vista Caja, con rango `range('month', hoy)`)
- `pct` = cobrado / meta
- `diasMes`, `diaHoy` → `pctMes` = diaHoy / diasMes
- `ritmoNecesario` = (meta − cobrado) / díasRestantes (si cobrado ≥ meta → "Meta cumplida 🎉")
- Estado: `pct ≥ pctMes` → **Adelantado** (chip verde) / si no → **Atrasado** (chip rojo) — misma semántica que el pacing de actividad existente

## UI

1. **Vista Metas**: card "Meta de caja del mes" — input de monto (solo admin, deshabilitado para el resto, patrón `adminNotice`/inputs disabled existente). Meta 0 o vacía = feature apagada.
2. **Vista Caja**: bloque arriba de los totales, visible solo si hay meta > 0 para el mes en curso:
   - Barra de progreso (cobrado vs meta) con los colores/tokens del tema (contraste WCAG como el resto)
   - Texto: `$X de $Y · Z% · quedan N días · necesitás $R/día`
   - Chip Adelantado/Atrasado
   - El bloque siempre refiere al **mes calendario en curso**, sin importar el selector de período de la vista (la meta es mensual; el selector sigue mandando sobre los totales de abajo)

## Casos borde

- Sin meta fijada → el bloque no aparece (ni barra vacía ni ceros).
- Meta cumplida antes de fin de mes → barra llena + "Meta cumplida", sin ritmo negativo.
- Último día del mes → ritmo necesario = lo que falta (división por 1, no por 0).
- Mes visto en el selector ≠ mes actual → el bloque de pacing sigue mostrando el mes actual (etiquetado con el nombre del mes para que no confunda).

## Testing

- UI en dev: fijar meta, verificar barra/%/días/ritmo contra cálculo a mano; cobrar una cuota → el progreso sube; borrar meta → bloque desaparece; como no-admin el input está bloqueado.

## Fuera de alcance

- Metas de caja por closer; metas trimestrales/anuales; histórico de metas.
