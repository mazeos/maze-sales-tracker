# Motor irrefutable — Fase 1: que el motor no mienta — Design

**Fecha:** 2026-07-14
**Proyecto:** "El motor manda" — el tracker como fuente de verdad de la actividad del setter.

## Por qué existe este proyecto

Alejandro no puede usar el tracker para auditar a un setter, por dos razones que se
retroalimentan: **no confía en lo que el setter carga a mano**, y **no confía en lo que el motor
mide**. Mientras el motor pueda equivocarse, cualquier discrepancia es una discusión sin árbitro.

**El destino (decisión, 2026-07-14):** el motor es la fuente de verdad. El setter **deja de
cargar**: ve sus números, no los edita. Cuando Alejandro le muestra un número, lo puede defender
contacto por contacto.

**El orden no se puede saltear.** Apagar la carga manual antes de que el motor sea correcto es
peor que el problema de hoy: en vez de discutir con un número dudoso, acusarías con uno.

Esta Fase 1 hace UNA cosa: **que el motor no mienta.** Las fases siguientes (honestidad del dato,
calibración, apagar la carga manual) dependen de ésta y se especifican aparte.

## Supuesto validado

Toda la actividad de conversaciones del setter pasa por GoHighLevel (IG, TikTok y WhatsApp están
sincronizados en el inbox). Confirmado por Alejandro.

Las **citas** todavía no: los 4 calendarios de Camino Digital tienen 0 eventos en 60 días —
están recién haciendo el setup. Hasta que haya citas reales, "Agendados" y el bloque del closer
van a dar cero. No es un bug: es falta de datos.

---

## 1. Modelo simétrico de clasificación

**El problema.** Hoy la clasificación depende de `contact.dateAdded`: una conversación solo cuenta
como Outbound/Inbound si el contacto fue dado de alta en el CRM **ese mismo día**. Eso deja un
agujero real:

> El setter abre una conversación en frío con alguien que ya estaba en el CRM (entró ayer, o vino
> de una lista importada). Le escribe primero. Ese mensaje **no cuenta en ninguna métrica**: no es
> Outbound (el contacto no es nuevo), no es Respuesta (nadie le escribió), no es Seguimiento (la
> conversación empezó hoy). **Desaparece.**

Un setter que trabaja una lista de leads importados tiene Outbound = 0 para siempre.

**La regla nueva.** Lo que clasifica una conversación es **quién la abrió**, no cuándo entró el
contacto al CRM:

| La conversación… | El primer mensaje es… | Métrica |
|---|---|---|
| nació hoy | del setter, humano | **Outbound** |
| nació hoy | del contacto | **Inbound** |
| nació hoy | automático (ManyChat) | **Bienvenida** |
| ya existía | hay mensaje entrante hoy | **Respuesta** |
| ya existía | hay mensaje humano del setter hoy | **Seguimiento** |

Sin agujeros, sin solapamientos, sin depender de `dateAdded`.

**Beneficio lateral:** el motor deja de necesitar consultar la ficha de cada contacto para
clasificar → menos llamadas a GHL, más rápido, menos riesgo de agotar el rate limit. (Se sigue
necesitando el contacto para resolver el canal de WhatsApp — ver punto 5.)

**Revierte una decisión previa.** El spec `2026-07-09-inbound-contactos-nuevos` había establecido
lo contrario (inbound/outbound = solo leads nuevos del día). **Alejandro confirmó la reversión el
2026-07-14**, con el agujero de los leads importados a la vista.

**Impacto esperado:** Outbound e Inbound **suben** (aparece actividad que hoy se pierde).
Respuestas **baja** (los contactos preexistentes que abrían conversación caían ahí por descarte).

## 2. La unidad de conteo es el contacto de GHL

**El problema.** Hoy el motor suma **por conversación**, pero el desglose de contactos deduplica
**por contactId**. Por eso una celda puede decir 20 y el panel listar 17 nombres. El número y su
propia evidencia no coinciden.

**La regla nueva.** La unidad es el **contacto de GoHighLevel**. Un contacto con dos
conversaciones en el mismo canal cuenta **una vez**. El número de la celda es siempre igual a la
cantidad de nombres del desglose.

**Lo que NO se hace, y hay que ser honesto al respecto:** un contacto de GHL **no es
necesariamente una persona**. El flujo IG → WhatsApp produce dos contactos por persona casi
siempre (el de Instagram no tiene teléfono ni email, así que GHL nunca los va a mergear solo).

**Decisión (Alejandro, 2026-07-14): la unidad real es el contacto de GHL. El setter es
responsable de unir los duplicados en GHL, y el tracker se alinea automáticamente.**

No se construye un grafo de identidad paralelo. GHL manda; el tracker refleja.

**Consecuencia en la UI:** no se dice "personas". Se dice "contactos".

## 3. El motor no subcuenta en silencio

**El problema — el más grave de todos.** El motor pagina las conversaciones hacia atrás desde
ahora, con un **tope de 20 páginas × 100**. Si el setter tiene volumen, el loop se queda sin
páginas antes de llegar al día evaluado y **devuelve un número más bajo, sin avisar**.

Con esto activo, un setter que trabajó puede aparecer como que no trabajó. **Es el defecto que
haría que acuses injustamente.** Y un número truncado se ve exactamente igual que uno correcto.

**La regla nueva.** Dos cosas, y la segunda importa más que la primera:

1. **Paginar hasta cubrir el día.** Se elimina el tope arbitrario.
2. **Si por lo que sea no se logra cubrir el día** (rate limit, error, un límite duro de
   seguridad), la métrica se marca como **incompleta** y **no se presenta como un número**. El
   motor nunca entrega un dato truncado con cara de dato bueno.

El transporte de ese estado ("este KPI de este día está incompleto") hasta la UI es parte de la
Fase 2 (honestidad del dato), pero **el motor tiene que emitirlo desde la Fase 1** — si no, la
información se pierde en el origen.

## 4. Las agendas se atribuyen de verdad

**El problema.** Hoy: si el setter le mandó un link a un contacto y ese contacto tiene una cita
dentro de los 7 días siguientes, se le atribuye la agenda. **No se verifica que la cita sea
consecuencia del link.** Una cita que ya existía antes del mensaje se le cuenta igual.

**La regla nueva.** La cita se atribuye al setter solo si **se creó después** del mensaje con el
link. Si es anterior, no es suya.

**Riesgo técnico a validar en la primera tarea:** hay que confirmar que la API de GHL expone la
fecha de creación del evento (`dateAdded` / `createdAt`). No se pudo comprobar contra datos reales
porque **no hay ni una cita en ninguna de las dos cuentas**. Si GHL no expone ese campo, **parar y
replantear** esta regla — no inventar un sustituto.

La ventana de 7 días se mantiene (es una heurística razonable), pero deja de ser el único
criterio.

## 5. Canal de WhatsApp: lo que no se puede resolver acá

El motor separa los inbound de WhatsApp entre "vino de IG" y "vino de TikTok" leyendo un
`utm_source` del contacto o un tag `origen:`. **Esos campos no están instrumentados**, así que la
mayoría cae en `inbound_wpp_sin_canal` (métrica que se acaba de agregar a la UI justamente para
que esos contactos dejen de perderse).

**Esto NO se arregla en esta fase.** Es un problema de instrumentación aguas arriba (ManyChat /
workflows de GHL), no del motor. Se deja explícitamente afuera y se documenta.

## 6. Ventana viva: el tracker se autocorrige

**El problema.** El worker nocturno calcula **solo el día en curso**. Un día pasado se escribe una
vez y nunca más. Entonces:
- Si el setter une dos contactos duplicados, los números viejos **se quedan mal para siempre**.
- Si el closer marca una cita como "asistió" tres días después, la asistencia **nunca aparece**.
- Si se corrige una venta vieja, el dato **queda stale**.

Y hay un candado adicional, agregado el 2026-07-14: `captureGhl` no pisa el `auto_value` de fechas
pasadas. Ese candado se puso **por desconfianza en el recálculo** (justamente por el tope de
paginación del punto 3).

**Una vez que el motor no miente, recalcular deja de ser peligroso y pasa a ser deseable:** es lo
que hace que el sistema se corrija solo.

**La regla nueva (decisión Alejandro, 2026-07-14): las dos cosas.**

1. **Ventana viva de 30 días.** Cada noche el motor recalcula los últimos 30 días, no solo el día
   de hoy. Dentro de esa ventana todo se autocorrige: merges de contactos, citas marcadas tarde,
   ventas corregidas. Pasados los 30 días, el dato **se congela** y no se toca más.
2. **Recálculo manual de un rango.** Un botón para forzar el recálculo de un período puntual,
   cuando se hace una corrección más vieja que la ventana.

**El candado del `auto_value` en fechas pasadas se levanta** dentro de la ventana viva — pero solo
después de que el punto 3 esté resuelto y verificado. **En ese orden.** El candado existe hoy
porque el motor subcuenta; levantarlo antes reintroduce la corrupción del historial de
calibración.

**Costo a dimensionar:** recalcular 30 días × N miembros × M orgs es mucho más trabajo que 1 día.
Hay que medir cuánto tarda y cuánto rate limit consume antes de activarlo. Si no entra en la
ventana nocturna, hay que escalonarlo.

## 7. Detector de duplicados probables

Para que el setter pueda cumplir su parte (unir duplicados), **el tracker tiene que mostrárselos**:
hoy no tiene forma de saber que "Luis Rivas (IG)" y "Luis Rivas (WhatsApp)" son la misma persona.

Con el desglose de contactos que ya existe, el tracker puede señalar los candidatos: contactos con
el mismo nombre (o nombre muy similar) activos en el mismo período, en canales distintos.

**Pieza separable:** se puede construir después del resto de la Fase 1 sin bloquear nada. Se
documenta acá porque es la contraparte necesaria de la decisión del punto 2 — sin esto, "el setter
une los duplicados" es una expectativa que nadie puede cumplir.

---

## Fuera de alcance (explícito)

| Qué | Por qué |
|---|---|
| Fathom → asistencias/no-shows/ofertas automáticas | Es del closer. Este proyecto es sobre el setter. Fase aparte. |
| CTA, ADS inbound, ADS seguimiento | Requieren instrumentar ManyChat. No es un problema del motor. |
| Triage | Requiere un calendario de triage por org. |
| Grafo de identidad propio (unificar personas) | Decisión explícita: la unidad es el contacto de GHL. |
| Estado por celda en la UI (completo/incompleto/no configurado) | Fase 2 (honestidad del dato). El motor **emite** el estado en Fase 1; la UI lo **muestra** en Fase 2. |
| Apagar la carga manual del setter | Fase 4. Requiere calibración previa (Fase 3). |

## Verificación

Esta fase cambia los números que el tracker muestra hoy. La verificación tiene que demostrar que
los cambia **en la dirección correcta**, no solo que no rompe nada.

- **Modelo simétrico:** tomar un día real con actividad y un setter real. Listar sus conversaciones
  desde la API de GHL a mano y clasificarlas con la regla nueva. El motor tiene que dar el mismo
  resultado. **Verificar en particular el caso que hoy se pierde**: una conversación abierta por el
  setter con un contacto preexistente tiene que aparecer como Outbound.
- **Unidad de conteo:** el número de cada celda tiene que ser **exactamente** igual a la cantidad
  de nombres de su desglose. Sin excepciones.
- **Paginación:** forzar el caso de un setter con volumen alto (o bajar el límite duro
  artificialmente) y confirmar que el motor **marca el KPI como incompleto** en vez de devolver un
  número bajo.
- **Atribución de agendas:** requiere una cita real. Hasta que Camino Digital termine su setup, se
  verifica creando una cita de prueba en la org Maze — Pruebas.
- **No-regresión:** los KPIs que no cambian de definición (seguimientos, links, bienvenidas) tienen
  que dar los mismos números que antes.

## Constraints

- Base Supabase **compartida** con producción (Clara). Deploy solo a `sales-tracker-test`. **No
  promover sin QA de Alejandro.**
- `api/metrics.js` lo usan DOS consumidores: `captureGhl` y el worker nocturno. Todo cambio al
  motor los afecta a ambos.
- El candado del `auto_value` en fechas pasadas **no se levanta** hasta que la paginación esté
  resuelta y verificada.
- Sin dependencias nuevas. Idioma de la UI: castellano rioplatense.
