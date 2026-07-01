# Pitfalls Research

**Domain:** SaaS multi-tenant de tracking de performance de ventas (setter → triage → closer) con integración GoHighLevel + carga manual + capa de IA
**Researched:** 2026-06-30
**Confidence:** HIGH (GHL rate limits/OAuth y Supabase RLS verificados con docs oficiales; pitfalls de dominio de tracking/IA basados en patrones conocidos + análisis de la planilla origen)

> Contexto clave: la planilla "CAMINO DIGITAL" sacó 8,5/10 en modelo de KPIs pero 6,5/10 como herramienta. **Lo que la hundió no fue el modelo — fue la fricción de carga y las definiciones ambiguas.** Todo pitfall de este documento se juzga contra esa lección: si la app reintroduce fricción o ambigüedad, repite el fracaso del 6,5.

---

## Critical Pitfalls

### Pitfall 1: Definiciones ambiguas de métrica → varianza sin sentido (el pecado original de la planilla)

**What goes wrong:**
La misma métrica se calcula distinto según quién la carga o cómo la interpreta el sistema. "Tasa de agendamiento" da 12% para un setter y 91% para otro no porque uno sea 7x mejor, sino porque uno cuenta "agendados / conversaciones nuevas" y otro "agendados / links enviados". El dato pierde todo valor de comparación y decisión.

**Why it happens:**
Cada tasa es un cociente y **el denominador nunca se estandariza**. En la planilla las definiciones vivían solo en un video; nadie las tenía a la vista al cargar. Se replica en la app si las fórmulas viven en el código pero las definiciones no se le muestran al usuario en el punto de carga.

**How to avoke:**
- El **diccionario de datos es un artefacto de primera clase**, no un tooltip decorativo (mejora #4 del PROJECT). Cada métrica tiene: nombre, numerador exacto, denominador exacto, unidad, y regla de qué eventos cuentan.
- **Las tasas se calculan en el backend a partir de conteos atómicos**, nunca se cargan como porcentaje. El usuario carga "conversaciones nuevas = 40, agendados = 8"; el sistema deriva 20%. Prohibir la carga directa de tasas.
- Un único módulo de definiciones (fuente de verdad) que alimenta a la vez el cálculo y los tooltips — que no puedan divergir.

**Warning signs:**
- Dos miembros con la misma tasa reportada tienen conteos base incompatibles.
- Tasas fuera de rango sensato (>100%, o 91% de agendamiento sostenido).
- Pedidos de "¿esto cómo se calcula?" en soporte → la definición no está a la vista.

**Phase to address:** Fundacional (modelo de datos / diccionario de métricas). Es el diferenciador core, va antes que GHL e IA.

---

### Pitfall 2: Doble conteo entre carga manual y auto-carga GHL

**What goes wrong:**
Un setter carga manualmente "8 agendados" y la integración GHL además lee 8 citas del calendario → el embudo muestra 16. O al revés: el sistema no sabe cuál es la fuente autoritativa para un día y suma ambas, inflando todo. Peor variante silenciosa: se cuenta parcial (5 manual + 8 auto) sin que nadie lo note.

**Why it happens:**
La decisión de diseño (PROJECT Key Decisions) es que **manual y auto coexisten**. Sin un modelo explícito de precedencia y deduplicación por métrica-día-persona, ambas fuentes escriben al mismo agregado.

**How to avoid:**
- **Nunca sumar fuentes.** Cada celda (métrica × persona × día) tiene una **fuente autoritativa resuelta**: `manual` OR `ghl`, con regla explícita (ej: "si hay auto-carga GHL para esa métrica ese día, gana GHL; manual queda como override editable con bandera").
- Modelar los datos como **eventos crudos con `source` + `external_id`** (el id de GHL), y derivar agregados por deduplicación sobre `external_id`. Un mismo appointment de GHL nunca se cuenta dos veces aunque llegue por webhook y por backfill.
- UI que muestra **de dónde viene cada número** (badge manual/auto) y permite override consciente, no acumulación ciega.

**Warning signs:**
- Totales que saltan al conectar GHL sin que cambiara la actividad real.
- Suma de sub-fuentes ≠ total mostrado.
- Reconexión de GHL duplica histórico.

**Phase to address:** Diseñar el modelo fuente-autoritativa en la fase fundacional; implementar dedup en la fase de integración GHL.

---

### Pitfall 3: Fricción de carga manual → el equipo deja de cargar (la causa real del 6,5/10)

**What goes wrong:**
Los vendedores abandonan la carga a los pocos días. Sin datos frescos, dashboards, metas, alertas e IA quedan vacíos o mienten. La app muere igual que la planilla — no por falta de features sino por **abandono de input**.

**Why it happens:**
El tracking es trabajo extra que no le rinde al que carga (le rinde al dueño). Si cargar cuesta más de ~30 seg/día, o exige recordar números de un "contador en el celular" aparte, o se hace en desktop cuando el vendedor vive en el teléfono → se cae. La planilla ya perdió por esto.

**How to avoid:**
- **La app ES el contador.** Botones de incremento en vivo durante el día (reemplaza el contador del celular *dentro* de la app, requisito explícito del PROJECT), no un formulario de fin de día que hay que llenar de memoria.
- **Mobile-first para la captura** aunque el dashboard sea desktop. El vendedor carga desde el teléfono entre conversaciones.
- **Auto-carga GHL reduce la superficie manual**: mientras más lee GHL, menos tiene que tipear el humano → menos abandono. La IA de auto-mapeo es una feature de *retención*, no solo de conveniencia.
- Fricción cero en fricciones tontas: sin login repetido, sin elegir fecha (default hoy), sin navegar menús.
- Feedback inmediato al cargar (racha, progreso vs meta) para que cargar *devuelva* algo al que carga.

**Warning signs:**
- % de días-persona con carga cae semana a semana (métrica de salud del producto — instrumentarla).
- Cargas en lote a fin de semana (señal de que no se usa en vivo → números inventados).
- Usuarios que solo miran el dashboard pero nunca cargan.

**Phase to address:** La UX de captura de baja fricción es fase temprana y es criterio de éxito del MVP, no un pulido posterior. Instrumentar "tasa de adopción de carga" desde el día 1.

---

### Pitfall 4: Fuga de datos entre tenants (falla de RLS / uso de service key)

**What goes wrong:**
La agencia A ve los números de ventas de la agencia B. En un producto que se *vende* a clientes de mentoring, una sola fuga de este tipo es fatal para la reputación de Maze.

**Why it happens:**
Dos causas verificadas en Supabase multi-tenant:
1. **Service key como footgun**: usar la `service_role` key (que **bypassa RLS**) en rutas que sirven requests de usuario. Un solo endpoint mal hecho expone todo.
2. **Fugas por JOIN**: la política está en la tabla A pero la query joinea a la tabla B; cada tabla evalúa su RLS por separado. Una tabla sin `tenant_id` o sin política deja un agujero.

**How to avoid:**
- **`tenant_id` (org_id) en TODAS las tablas de datos**, sin excepción. Política RLS en cada una comparando `tenant_id` contra el claim del JWT.
- **Regla dura de keys**: rutas de usuario → `anon` key + JWT del usuario. Solo jobs internos/admin usan `service_role`, explícitamente y aislados.
- Incluir siempre `authenticated` en los roles aprobados de la política — no confiar solo en `auth.uid()` para descartar `anon`.
- **Test automatizado de aislamiento** en CI: crear tenant A y B, autenticar como A, intentar leer cada tabla de B, assert vacío. Correr en cada deploy.
- Default-deny: RLS habilitado en toda tabla nueva por convención/migración, nunca opt-in manual.

**Warning signs:**
- Alguna tabla sin `tenant_id`.
- Uso de `service_role` fuera de `/api/internal` o jobs.
- Queries que joinean tablas y "funcionan" sin que ambas tengan política.

**Phase to address:** Fase fundacional (esquema + RLS + test de aislamiento en CI). No es negociable ni diferible.

---

### Pitfall 5: OAuth GHL — rotación de refresh token mal manejada rompe la conexión de un tenant

**What goes wrong:**
La integración de un tenant deja de sincronizar silenciosamente. Días después el dueño ve un embudo congelado/incompleto y desconfía de toda la app.

**Why it happens:**
GHL rota el refresh token: **al usar un refresh token para obtener un access token nuevo, el refresh token viejo queda inválido** y la respuesta trae uno nuevo que hay que persistir. Si el proceso de refresh falla a mitad (guardó el access pero no el nuevo refresh, o dos jobs refrescan en paralelo con el mismo token), la conexión se rompe sin vuelta y requiere re-autorización manual. Access token dura 1 día; refresh token sin usar dura 1 año.

**How to avoid:**
- **Persistir atómicamente** access + refresh nuevos en la misma transacción; el refresh es de un solo uso.
- **Lock por tenant** en el proceso de refresh para evitar refresh concurrente que invalide el token bueno (mismo patrón de lock que ya se usó en el Setter Agendador de Maze).
- Refrescar **proactivamente** antes del vencimiento (no esperar al 401).
- **Estado de conexión visible por tenant**: "GHL conectado / expirado / re-autorizar", con alerta al dueño cuando se cae, no fallo silencioso.
- Guardar tokens **cifrados** por tenant (dato sensible de un CRM de terceros).

**Warning signs:**
- 401 recurrentes de GHL para un tenant.
- Última sincronización exitosa hace >24h.
- Backfill que pide re-login inesperado.

**Phase to address:** Fase de integración GHL. El indicador de estado de conexión es parte del MVP de esa fase, no un extra.

---

### Pitfall 6: Rate limits y webhooks perdidos de GHL → datos incompletos que parecen completos

**What goes wrong:**
Con muchos tenants sincronizando, se topa el rate limit de GHL (**100 requests/10s por app por recurso; 200.000/día por app por recurso**) y se pierden lecturas. O un webhook de GHL falla y ese appointment/venta nunca entra. El embudo se ve normal pero le faltan eventos → subcuenta silenciosa (el peor error posible en un tracker: *parecer* confiable sin serlo).

**Why it happens:**
- Rate limit es **por marketplace app**, no por tenant: todos los tenants comparten el mismo cupo. A escala, un solo cupo global se agota.
- Los webhooks se pierden (red, deploy, timeout). Además GHL **deshabilita URLs de webhook con <90% de éxito de entrega en ventana de 3 días** — un endpoint lento/caído puede quedar cortado por GHL.
- Sin reconciliación, un evento perdido no deja rastro.

**How to avoid:**
- **Cola con throttling global** respetando el límite compartido; backoff exponencial ante 429; no un fan-out ingenuo por tenant.
- **Webhooks como optimización, no como fuente de verdad.** Verdad = **reconciliación periódica por pull** (backfill diario que compara conteos GHL vs almacenados y rellena huecos). Dedup por `external_id` (ver Pitfall 2).
- **Webhook receiver que responde 200 rápido** (encolar y procesar async) para mantenerse sobre el 90% de éxito y no ser deshabilitado por GHL.
- **Indicador de frescura/completitud de datos** por tenant: "sincronizado hasta HH:MM", y bandera si la reconciliación detectó discrepancias.

**Warning signs:**
- 429 en logs de GHL.
- Discrepancia entre conteo de reconciliación y agregado almacenado.
- Aviso de GHL de webhook deshabilitado.
- Huecos de citas en horarios sin actividad registrada.

**Phase to address:** Fase de integración GHL. Diseñar pull-reconciliation desde el inicio de esa fase; no confiar solo en webhooks.

---

### Pitfall 7: IA que alucina recomendaciones sobre los datos

**What goes wrong:**
El coach IA dice "el setter Facu cayó 30% en agenda" cuando en realidad subió, o inventa una causa ("bajó su tasa link→agenda") que los datos no respaldan. El dueño toma una decisión de management (reta o reasigna a alguien) sobre un dato falso. Destruye la confianza en toda la capa de IA de un solo golpe.

**Why it happens:**
Se le pasa el LLM texto/números en el prompt y se le pide "analizá", dejándolo hacer aritmética y comparaciones que alucina. Los LLMs son malos calculando y tienden a narrar patrones inexistentes.

**How to avoid:**
- **La IA NO calcula métricas.** Todos los números (deltas, tasas, comparaciones semana vs semana) se computan de forma **determinística en el backend** y se le pasan a la IA ya calculados. El rol del LLM es *redactar/priorizar/explicar*, no derivar cifras.
- **Grounding estricto**: la IA solo puede referirse a métricas presentes en el payload estructurado que se le entrega; prompt que prohíbe inventar cifras o causas no provistas.
- **Toda afirmación numérica en la salida es trazable** a un valor del payload (idealmente citando el dato). Si un número no está en el payload, no puede aparecer.
- **Umbral mínimo de datos**: no generar coaching sobre muestras chicas (ej: <N conversaciones) — evita "conclusiones" sobre ruido.

**Warning signs:**
- Cifras en la salida de IA que no matchean el dashboard.
- Recomendaciones sobre personas/días sin datos suficientes.
- Causas afirmadas que no se pueden reproducir desde los números.

**Phase to address:** Fase de IA (coach/analista). El principio "IA no calcula, solo redacta sobre cifras pre-computadas" es la decisión arquitectónica central de toda la capa IA.

---

### Pitfall 8: Fatiga de alertas → se ignoran todas, incluso las importantes

**What goes wrong:**
La IA de anomalías dispara demasiadas alertas ("cierre bajó", "no-show subió", "closer ocupado") por variaciones normales del día a día. El equipo silencia las notificaciones y deja de ver también la alerta que sí importaba (un closer realmente quemándose).

**Why it happens:**
Detección basada en umbrales ingenuos sobre datos ruidosos y de baja frecuencia (ventas es alta varianza, N chico por día). Cada fluctuación cruza un umbral fijo.

**How to avoid:**
- **Alertar sobre tendencia sostenida, no sobre un día.** Requerir persistencia (ej: caída sostenida X días o vs baseline propio de la persona) y significancia mínima antes de disparar.
- **Baseline por persona/tenant**, no umbrales absolutos globales (un no-show del 20% puede ser normal para uno y alarma para otro).
- **Presupuesto de alertas**: máximo N por semana por tenant; priorizar las de mayor impacto. Mejor 1 alerta certera que 10 ruidosas.
- **Alertas accionables**: cada una dice qué mirar y qué hacer, no solo "algo cambió".
- Permitir snooze/ajuste de sensibilidad por tenant y **medir tasa de acción** sobre las alertas (si nadie actúa, están mal calibradas).

**Warning signs:**
- Usuarios que desactivan notificaciones.
- Tasa de acción sobre alertas cercana a 0.
- Múltiples alertas/día por tenant.

**Phase to address:** Fase de IA (alertas/anomalías). Empezar conservador (pocas alertas de alta confianza) y aflojar, no al revés.

---

### Pitfall 9: Costo de tokens de IA sin control (economía del SaaS se rompe)

**What goes wrong:**
Con muchos tenants y las 4 features de IA (auto-mapeo, coach, alertas, NL), el gasto en Claude escala más rápido que el valor. Peor: un tenant abusa del copiloto NL y dispara la factura. Se replica el susto del "spending cap de Gemini" ya vivido en el ecosistema Setter de Maze.

**Why it happens:**
Llamar al LLM en cada request, en cada carga de dashboard, o pasar contexto enorme sin cache. Sin límites por tenant, un usuario puede consumir sin techo.

**How to avoid:**
- **Cachear y batchear**: el coach/alertas corren en batch programado (ej: 1x/día por tenant), no en cada visita al dashboard. Cachear la salida hasta que cambien los datos.
- **Enviar solo agregados pre-computados** al LLM (payload chico), no dumps crudos de eventos → menos tokens y menos alucinación (ligado al Pitfall 7).
- **Model routing**: Sonnet/modelos baratos para tareas rutinarias (mapeo, redacción), reservar Opus para lo que lo amerite.
- **Rate limit y presupuesto de tokens por tenant** en el copiloto NL; degradar con gracia al llegar al límite.
- **Instrumentar costo por tenant/feature** desde el día 1 para ver el margen real.

**Warning signs:**
- Factura de IA crece más rápido que los tenants.
- Un tenant concentra el grueso del gasto.
- Llamadas a LLM en el path de render del dashboard.

**Phase to address:** Fase de IA. El presupuesto/instrumentación de costos es parte del diseño de la capa IA, no un post-mortem.

---

### Pitfall 10: NLP del copiloto malinterpreta la pregunta sobre datos

**What goes wrong:**
El dueño pregunta "¿cómo viene Facu esta semana vs la pasada?" y la IA responde sobre otra persona, otro período, u otra métrica — con una cifra que suena confiable. Confianza mal depositada = peor que no responder.

**Why it happens:**
Se deja al LLM interpretar la pregunta *y* buscar/calcular los datos en un paso, sin resolver explícitamente entidades (persona, período, métrica) contra el catálogo real del tenant.

**How to avoid:**
- **NL → consulta estructurada, no NL → respuesta directa.** La IA traduce la pregunta a parámetros (entidad=Facu, métrica=agenda, período=esta_semana vs semana_pasada); el backend ejecuta la query determinística; la IA redacta el resultado.
- **Resolver entidades contra datos reales del tenant** (matching de nombres, validar que Facu existe) y **confirmar interpretación** cuando hay ambigüedad ("¿te referís a Facundo G.?").
- **Mostrar la interpretación** junto a la respuesta ("Facu · agenda · semana actual vs anterior") para que el usuario detecte malentendidos.
- Fallback honesto: si no puede mapear la pregunta con confianza, decirlo, no inventar.

**Warning signs:**
- Respuestas sobre entidad/período distintos al preguntado.
- Cifras del copiloto que no coinciden con el dashboard filtrado igual.

**Phase to address:** Fase de IA (copiloto NL). Arquitectura de "structured query intermediate" desde el diseño.

---

### Pitfall 11: Metas y pacing mal calibrados → desmotivan en vez de guiar

**What goes wrong:**
La vista goal-vs-actual muestra siempre "atrasado" (metas irreales) o siempre "adelantado" (metas blandas). En el primer caso el equipo se desmoraliza y deja de mirar; en el segundo la meta no significa nada. La mejora #1 de la app se vuelve contraproducente.

**Why it happens:**
Pacing lineal ingenuo (meta mensual / días) que ignora estacionalidad, fines de semana, arranque de mes, y ramp-up de gente nueva. Metas fijadas sin baseline histórico.

**How to avoid:**
- **Pacing consciente del calendario** (días hábiles/laborables del vendedor, no días corridos).
- **Metas ancladas en baseline histórico** de la propia persona/tenant, con posibilidad de stretch explícito, no números arbitrarios.
- **Rampa para gente nueva** (no compararlos contra un veterano desde el día 1).
- Encuadre motivacional: mostrar progreso y proximidad, no solo el rojo del déficit. Cuidar el tono (regla Maze: nada de tono "herido/P2").
- Metas ajustables sin fricción cuando la realidad cambia.

**Warning signs:**
- Todo el equipo consistentemente en rojo o todo en verde.
- Usuarios que ignoran la vista de metas.
- Metas seteadas una vez y nunca revisadas.

**Phase to address:** Fase de metas/pacing (mejora #1). Requiere algo de histórico → puede ir después del núcleo de tracking.

---

### Pitfall 12: Métricas de vanidad que se ven bien pero no mueven cash

**What goes wrong:**
El dashboard prioriza "conversaciones nuevas" o "mensajes enviados" (fáciles de inflar, suben siempre) y entierra las métricas que predicen ingreso (tasa oferta→cierre, cash collected, asistencia). El equipo optimiza actividad, no resultado.

**Why it happens:**
Es más fácil trackear/mostrar volumen de arriba del embudo. La planilla misma tenía "pared de columnas" donde todo pesaba igual.

**How to avoid:**
- **Jerarquía visual por impacto en cash**: el dashboard de resumen (mejora #4, "de un golpe de vista") destaca las métricas de resultado y tasas de conversión, no los conteos brutos de actividad.
- **Cash collected como métrica ancla** — todo se relaciona con ingreso real, no facturado ni actividad.
- Actividad visible pero **subordinada** a la tasa que la convierte en resultado.
- La IA coach debe señalar cuellos de botella de *conversión*, no felicitar por volumen.

**Warning signs:**
- Lo primero que se ve son conteos de actividad, no resultados.
- Alguien "cumple metas" de actividad con cash estancado.

**Phase to address:** Fase de dashboard/diseño de métricas. Curaduría de qué se destaca, ligada al diccionario del Pitfall 1.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Guardar agregados diarios en vez de eventos crudos | Menos storage, queries simples | Imposible deduplicar GHL vs manual, reconciliar o recalcular al cambiar una definición | **Nunca** — el modelo de eventos crudos con `source`+`external_id` es fundacional |
| Un solo cupo de rate limit sin cola global | Envío directo simple | A escala se topa el límite compartido de GHL y se pierden datos silenciosamente | Solo con 1-2 tenants en dev; nunca en prod multi-tenant |
| IA calcula las cifras en el prompt | Menos código backend | Alucinación numérica → decisiones sobre datos falsos | **Nunca** |
| RLS opt-in manual por tabla | Rápido al crear tablas nuevas | Una tabla olvidada = fuga entre tenants | **Nunca** — default-deny por migración |
| Webhooks como única fuente de sync | Tiempo real fácil | Eventos perdidos = subcuenta invisible | Solo si hay reconciliación por pull respaldándolos |
| Alertas por umbral fijo global | Simple de implementar | Fatiga de alertas → se ignoran todas | MVP interno; recalibrar con baseline por persona antes de vender |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| GHL OAuth | No persistir el refresh token rotado → conexión muerta | Guardar access+refresh nuevos atómicamente; refresh de un solo uso; lock por tenant |
| GHL rate limit | Fan-out por tenant sin throttle → 429 | Cola con throttling global (100/10s, 200k/día por app, compartido); backoff |
| GHL webhooks | Confiar en webhooks como verdad; responder lento | Reconciliación por pull como fuente de verdad; 200 rápido async (mantener >90% entrega o GHL corta el webhook) |
| GHL estados de oportunidad/cita | Mapear pipeline stages hardcodeados a métricas | Mapeo configurable por tenant (cada cuenta GHL tiene sus stages); la IA de auto-mapeo *sugiere*, el humano confirma |
| GHL sub-cuentas | Asumir un mapeo uniforme entre sub-cuentas | Cada tenant conecta su location; no asumir pipelines/campos custom idénticos |
| Slack/GHL alertas salientes | Mensajería propia | Solo GHL workflows y/o Slack (regla Maze); nunca canal propio |
| Claude (IA) | Contexto crudo enorme por request | Payload de agregados pre-computados, cacheado, batcheado; model routing Sonnet/Opus |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Columnas de RLS sin índice | Dashboards lentos a medida que crecen filas | Indexar `tenant_id` y toda columna usada en políticas RLS | Decenas de tenants × meses de eventos |
| Roll-ups calculados on-the-fly en cada request | Dashboard lento, costo DB | Agregados materializados/incrementales (diario→semanal→mensual→trimestral→anual) | Cuando cada tenant pide roll-ups anuales sobre eventos crudos |
| LLM en el path de render | Dashboard tarda segundos, factura IA dispara | IA en batch programado, salida cacheada hasta cambio de datos | Con varios tenants abriendo dashboards a diario |
| Sync GHL secuencial de todos los tenants | Ventana de sync no cierra, se topa rate limit | Cola con concurrencia acotada + throttle global | Al pasar de pocos a decenas de tenants |
| Policy RLS con `auth.uid()` del lado caro | Query planner no optimiza | `tenant_id in (select ... where user_id = auth.uid())` (subquery), no al revés | Tablas grandes con RLS |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| `service_role` key en rutas de usuario | Bypass total de RLS → fuga entre tenants | `anon`+JWT en rutas de usuario; `service_role` solo en jobs internos aislados |
| Tabla sin `tenant_id` / sin política | Fuga silenciosa entre agencias | `tenant_id` obligatorio por convención + test de aislamiento en CI |
| Tokens OAuth de GHL en claro | Robo de acceso al CRM de un cliente | Cifrado at-rest por tenant, scope mínimo |
| Confiar en filtrado por tenant en app-layer | Un bug de query expone otro tenant | Aislamiento en la DB vía RLS, no en el código de la app |
| Fuga por JOIN con RLS parcial | Datos de B vía tabla joineada sin política | Toda tabla joineada con RLS propia; test que valida joins cross-tenant |
| Copiloto NL sin scope de tenant | Pregunta que "ve" datos de otro tenant | El intermediate structured query hereda el `tenant_id` del JWT, siempre |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Formulario de carga de fin de día | Números de memoria → inexactos, se abandona | Contador en vivo incremental dentro de la app, mobile-first |
| "Pared de columnas" (todo pesa igual) | No se lee de un vistazo; se ignora | Resumen jerárquico por impacto en cash |
| Números sin indicar su fuente | Desconfianza (¿manual o GHL? ¿sumado?) | Badge de fuente + frescura por métrica |
| Meta siempre en rojo | Desmotiva, se deja de mirar | Pacing por días hábiles + baseline histórico + tono positivo |
| Alertas ruidosas | Se silencian todas | Presupuesto de alertas, baseline por persona, accionables |
| IA sin mostrar su interpretación | Confianza en respuesta equivocada | Mostrar entidad/período/métrica interpretados; confirmar ambigüedad |

## "Looks Done But Isn't" Checklist

- [ ] **Auto-carga GHL:** suele faltar la **deduplicación** manual vs webhook vs backfill — verificar que reconectar GHL no duplica el histórico.
- [ ] **Aislamiento multi-tenant:** suele faltar el **test automatizado** cross-tenant — verificar que un tenant no puede leer NINGUNA tabla de otro (incluyendo por JOIN).
- [ ] **OAuth GHL:** suele faltar el manejo de **refresh token rotado + refresh concurrente** — verificar reconexión tras 24h y bajo dos jobs simultáneos.
- [ ] **Webhooks GHL:** suele faltar la **reconciliación por pull** — verificar que un webhook perdido se recupera en el backfill.
- [ ] **IA coach:** suele faltar el **grounding** — verificar que toda cifra de la salida existe en el payload y matchea el dashboard.
- [ ] **Alertas:** suele faltar la **persistencia/baseline** — verificar que un solo día malo no dispara alerta.
- [ ] **Definiciones de métrica:** suele faltar que **cálculo y tooltip usen la misma fuente** — verificar que no pueden divergir.
- [ ] **Metas/pacing:** suele faltar el **calendario de días hábiles** — verificar que el pacing no cuenta fines de semana como días de venta.
- [ ] **Costo IA:** suele faltar la **instrumentación por tenant** — verificar que se ve el gasto por tenant/feature antes de escalar.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Doble conteo GHL/manual | MEDIUM | Si hay eventos crudos con `external_id`: recomputar agregados dedupeados. Si solo se guardaron agregados: HIGH, casi irrecuperable → confirma por qué el modelo de eventos es obligatorio |
| Fuga entre tenants | HIGH | Contención inmediata (revocar service key expuesta), auditoría de acceso, notificación, remediar RLS + test. Daño reputacional difícil de revertir |
| Refresh token roto de un tenant | LOW | Flujo de re-autorización guiado desde el indicador de estado de conexión |
| Datos incompletos por webhooks perdidos | LOW-MEDIUM | Backfill de reconciliación por pull rellena huecos (si existe) |
| IA alucinó recomendaciones | MEDIUM | Retirar feature, migrar a "IA solo redacta cifras pre-computadas", recuperar confianza con transparencia de cálculo |
| Abandono de carga | HIGH | Duro de revertir (hábito perdido). Prevención > cura: reducir fricción, subir auto-carga GHL, medir adopción desde el día 1 |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1. Definiciones ambiguas | Fundacional (modelo/diccionario) | Tasas derivadas de conteos; una sola fuente de definición alimenta cálculo y UI |
| 2. Doble conteo GHL/manual | Fundacional (modelo eventos) + Integración GHL | Reconectar GHL no duplica; suma de fuentes = total |
| 3. Fricción de carga | UX de captura (temprana, MVP) | Métrica de adopción de carga instrumentada y estable |
| 4. Fuga entre tenants | Fundacional (esquema+RLS) | Test de aislamiento cross-tenant en CI verde |
| 5. OAuth GHL rotación | Integración GHL | Reconexión tras 24h y bajo refresh concurrente OK; indicador de estado |
| 6. Rate limits/webhooks | Integración GHL | Reconciliación por pull recupera huecos; sin 429; webhook >90% entrega |
| 7. IA alucina cifras | IA (coach) | Toda cifra de salida trazable al payload; matchea dashboard |
| 8. Fatiga de alertas | IA (alertas) | Volumen bajo, tasa de acción alta, baseline por persona |
| 9. Costo tokens IA | IA (todas) | Costo por tenant instrumentado; sin LLM en render; batch+cache |
| 10. NLP malinterpreta | IA (copiloto NL) | Interpretación mostrada; entidades resueltas contra datos del tenant |
| 11. Metas mal calibradas | Metas/pacing | Pacing por días hábiles; metas con baseline; no todo rojo/verde |
| 12. Métricas de vanidad | Dashboard/diseño | Resumen jerarquizado por impacto en cash |

## Sources

- HighLevel API Documentation — Marketplace/Developer Portal (OAuth 2.0: access token 1 día, refresh token rotado de un solo uso, válido 1 año sin usar): https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0/index.html — HIGH
- HighLevel API rate limits (100 req/10s burst, 200.000/día por app por recurso): https://help.gohighlevel.com/support/solutions/articles/48001060529-highlevel-api — HIGH
- HighLevel Webhook Integration Guide (deshabilitación de URLs con <90% de entrega en ventana de 3 días): https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/index.html — HIGH
- Supabase Docs — RLS Performance and Best Practices (indexar columnas de política, subquery para tenant_id, rol authenticated): https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv — HIGH
- MakerKit — Supabase RLS Best Practices for Multi-Tenant (service key footgun, fugas por JOIN, anon+JWT vs service_role): https://makerkit.dev/blog/tutorials/supabase-rls-best-practices — MEDIUM
- DEV Community — Row-Level Security in Supabase: Multi-Tenant SaaS from Day One: https://dev.to/issuecapture/row-level-security-in-supabase-multi-tenant-saas-from-day-one-4lon — MEDIUM
- Análisis del template "CAMINO DIGITAL" y ecosistema Maze (fricción de carga como causa del 6,5/10; lock Redis del Setter Agendador; susto de spending cap de Gemini) — PROJECT.md + memoria interna — HIGH
- Patrones conocidos de LLM analytics (alucinación numérica, grounding, structured-query intermediate) — MEDIUM

---
*Pitfalls research for: SaaS multi-tenant de tracking de ventas con GHL + IA*
*Researched: 2026-06-30*
