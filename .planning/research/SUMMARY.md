# Project Research Summary

**Project:** Maze Sales Tracker IA
**Domain:** SaaS multi-tenant de sales-performance tracking (setter -> triage -> closer / appointment-setting high-ticket) con integracion GoHighLevel + capa de IA (Claude)
**Researched:** 2026-06-30
**Confidence:** HIGH

## Executive Summary

Maze Sales Tracker IA es un SaaS multi-tenant que reemplaza una planilla de Google Sheets (template "CAMINO DIGITAL") con la que ya conviven los clientes de mentoring de Maze. Esto invierte la logica normal de investigacion: el "competidor" no es otro SaaS sino la planilla misma, que tenia un modelo de KPIs solido (8,5/10) pero fracasaba como herramienta (6,5/10) por friccion de carga y definiciones ambiguas. El stack recomendado -- Next.js 16 + Supabase (Postgres/Auth/RLS) + Drizzle + Claude -- es coherente con el resto del ecosistema Maze (maze-growth, maze-scheduler) y correcto para el volumen real del producto (decenas de filas/dia por tenant, no un problema de time-series de alto volumen: nada de TimescaleDB). El punto de arquitectura critico es que manual y GHL deben escribir al mismo modelo canonico de hechos (`metric_facts` con `source` + `dedupe_key`), nunca sumarse como fuentes paralelas, y que GHL ya no admite integracion por API key -- es obligatorio OAuth 2.0 Marketplace App desde el diseno inicial.

El enfoque recomendado es: multi-tenancy con RLS de Supabase (aislamiento a nivel de base de datos, nunca en la capa de aplicacion) desde el dia 1, seguido de un nucleo de tracking manual mobile-first que entregue valor completo SIN GHL (Core Value explicito), y recien despues metas/pacing, integracion GHL y, al final, la capa de IA (auto-mapeo, coach/analista, alertas, copiloto NL) construida como tool-caller sobre datos ya agregados -- el LLM nunca calcula cifras ni toca SQL crudo, solo redacta sobre numeros pre-computados deterministamente.

Los riesgos principales, en orden de gravedad: (1) reintroducir la friccion de carga o la ambiguedad de definiciones que ya hundio la planilla -- esto mata la adopcion independientemente de que tan buena sea la IA; (2) una fuga de datos entre tenants (fatal para la reputacion de un producto que se vende a clientes de mentoring) por confiar en filtrado de aplicacion en vez de RLS o por usar `service_role` en rutas de usuario; (3) doble conteo entre carga manual y auto-carga GHL si no hay un modelo de eventos crudos con deduplicacion por `external_id`; y (4) que la IA alucine cifras o recomendaciones, lo cual destruiria la confianza en toda la capa de IA de un solo golpe. Todos estos riesgos tienen mitigaciones concretas y bien documentadas en la investigacion (RLS + test de aislamiento en CI, modelo `metric_facts` con `source`+`dedupe_key`, IA que nunca calcula solo redacta sobre payload pre-computado).

## Key Findings

### Recommended Stack

Next.js 16 (App Router) + React 19 + TypeScript sobre Supabase (Postgres 15+, Auth, RLS, Realtime) con Drizzle ORM como capa de queries type-safe. La IA corre sobre `@anthropic-ai/sdk` con structured outputs nativos (`messages.parse` + Zod), eliminando el parseo manual de JSON. Los roll-ups temporales (diario->anual) se resuelven con una unica tabla `daily_metrics` materializada por `pg_cron`, sin necesidad de TimescaleDB (Supabase ya no la ofrece y el volumen no lo justifica). Background jobs corren en un worker Node en el mismo Docker Compose del VPS (patron "apps nativas en VPS" de Maze), con `pgmq` como cola durable; las alertas salientes siempre van por n8n -> Slack/GHL, nunca por mensajeria propia.

**Core technologies:**
- Next.js 16 + React 19 + TypeScript: framework full-stack, coherente con maze-growth/maze-scheduler -- HIGH
- Supabase (Postgres + Auth + RLS): motor de multi-tenancy nativo a nivel DB, no de aplicacion -- HIGH
- Drizzle ORM: type-safe, bundle chico, soporte RLS nativo, ideal en serverless/edge -- HIGH
- `@anthropic-ai/sdk`: structured outputs, tool use, prompt caching, Message Batches para los 4 usos de IA -- HIGH
- OAuth 2.0 Marketplace App de GHL (NO API keys V1, sin soporte desde 31-dic-2025) -- HIGH

### Expected Features

El "competidor" real es la planilla, no otro SaaS: table stakes = paridad total con "CAMINO DIGITAL"; diferenciadores = cerrar los 4 huecos que la planilla dejo (metas/pacing, auto-carga GHL, roll-ups de setter, diccionario embebido) + la capa de IA.

**Must have (table stakes):**
- Multi-tenancy con aislamiento por tenant (RLS) -- cimiento no negociable
- Gestion de equipo y roles (setter/triage/closer, combinables)
- Captura manual de metricas diarias mobile-first (funciona sin GHL)
- Embudo completo con tasas calculadas (nunca cargadas directamente)
- Log de ventas con atribucion completa (closer+triage+setter+fuente)
- Roll-ups temporales para todos los roles

**Should have (competitive):**
- Metas + pacing goal-vs-actual (diferenciador #1 no-IA)
- Auto-carga desde GHL (coexiste con manual, requiere dedup)
- Diccionario de datos embebido (barato, protege calidad del dato)
- IA analista/coach como prueba de concepto de v1
- Roll-ups automaticos tambien para setters (casi gratis si el motor es generico)

**Defer (v2+):**
- IA de alertas/anomalias y copiloto NL (requieren roll-ups + metas estables primero)
- Convertirse en CRM, facturacion propia, app movil nativa, gamificacion/leaderboards, dashboards configurables, i18n -- todos anti-features explicitos que compiten con GHL o sobre-disenan v1

### Architecture Approach

Arquitectura en capas: cliente Next.js (RSC/Server Actions) -> capa de dominio pura sin I/O (embudo, roll-ups, pacing) -> Supabase Postgres con RLS por `org_id` -> background jobs (pg_cron + Edge Functions/cola) para sync GHL, roll-ups y scan de anomalias -> dispatcher unico de notificaciones hacia GHL/Slack. El patron central es el modelo canonico `metric_facts` con discriminador `source in {manual, ghl, reconciled}` y `dedupe_key`, sobre el cual se materializa `daily_metrics` (unica agregacion pre-calculada; periodos altos se computan on-read cacheados).

**Major components:**
1. Auth/Tenancy -- Supabase Auth + Custom Access Token Hook que inyecta `org_id`+`role` en el JWT, consumido por RLS
2. Ingesta (manual + GHL adapter) -- normaliza ambas fuentes al mismo `metric_facts`, idempotente por `dedupe_key`
3. Motor de metricas/roll-ups -- deriva `daily_metrics`, expone tasas del embudo
4. AI Orchestrator -- tool-caller sobre data-access acotado tenant-scoped, nunca SQL libre ni calculo de cifras
5. Notification dispatcher -- unico punto de salida hacia GHL workflow / Slack

### Critical Pitfalls

1. **Definiciones ambiguas de metrica** -- la misma tasa da resultados distintos segun quien la interpreta. Mitigacion: diccionario de datos como artefacto de primera clase que alimenta a la vez calculo y UI; tasas siempre derivadas de conteos atomicos, nunca cargadas como porcentaje.
2. **Friccion de carga manual -> abandono** -- causa real del fracaso 6,5/10 de la planilla, no falta de features. Mitigacion: la app ES el contador (botones de incremento en vivo), mobile-first, sin fricciones tontas, con feedback inmediato al cargar.
3. **Fuga de datos entre tenants** -- fatal para la reputacion del producto. Mitigacion: RLS default-deny en toda tabla + `org_id` obligatorio + `service_role` solo en jobs aislados + test automatizado de aislamiento cross-tenant en CI.
4. **Doble conteo manual vs GHL** -- ambas fuentes coexisten por diseno; sin precedencia clara se suman e inflan el embudo. Mitigacion: eventos crudos con `source`+`external_id`, nunca sumar fuentes, fuente autoritativa resuelta por celda.
5. **IA que alucina cifras** -- el coach/copiloto inventa deltas o causas que los datos no respaldan. Mitigacion: la IA nunca calcula, solo redacta sobre un payload de agregados pre-computados deterministamente en el backend; toda cifra debe ser trazable.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Fundaciones de tenancy + modelo de datos
**Rationale:** Todo depende de esto; retrofittear multi-tenancy o el modelo canonico de eventos es un rewrite. Es el punto de mayor riesgo de seguridad y el que define el contrato (`metric_facts`) que consumiran GHL, IA y alertas.
**Delivers:** orgs/teams/members/roles, Supabase Auth + Custom Access Token Hook (`org_id`+`role` en JWT), RLS + indices en toda tabla, test de aislamiento cross-tenant en CI, diseno del modelo `metric_facts` (source + dedupe_key) y diccionario de datos.
**Addresses:** Multi-tenancy con aislamiento (table stake), diccionario de datos embebido (mejora #4)
**Avoids:** Pitfall 4 (fuga entre tenants), Pitfall 1 (definiciones ambiguas), Pitfall 2 (doble conteo, diseno del modelo)

### Phase 2: Nucleo de tracking manual (embudo, metricas, roll-ups, dashboard)
**Rationale:** El producto ya entrega el Core Value completo SIN GHL en esta fase. Es donde se juega la adopcion real (la causa del fracaso de la planilla).
**Delivers:** captura manual mobile-first (contador en vivo), embudo con tasas de los 3 roles, log de ventas con atribucion, roll-ups diario->anual (incluyendo setters, mejora #3), dashboard de resumen jerarquizado por impacto en cash.
**Addresses:** Captura manual, embudo+tasas, log de ventas, roll-ups todos los roles, dashboard (todos table stakes P1)
**Avoids:** Pitfall 3 (friccion de carga -> abandono), Pitfall 12 (metricas de vanidad)

### Phase 3: Metas y pacing
**Rationale:** Depende de roll-ups estables (fase 2) para tener contra que comparar. Es el diferenciador #1 no-IA, de valor alto y costo medio.
**Delivers:** metas por rol/persona/periodo, pacing consciente de dias habiles, baseline historico, rampa para gente nueva.
**Uses:** tablas `daily_metrics`/`goals`, `date-fns-tz` (zona horaria Buenos Aires)
**Implements:** Metas & pacing engine (mejora #1)
**Avoids:** Pitfall 11 (metas mal calibradas que desmotivan)

### Phase 4: Integracion GoHighLevel
**Rationale:** Depende de que `metric_facts` este estable (fase 1-2) porque GHL escribe al mismo modelo. Alto valor pero alto riesgo (dedup, OAuth), mejor tras estabilizar el core manual.
**Delivers:** OAuth 2.0 Marketplace App por tenant, receptor de webhooks (firma Ed25519, idempotencia), polling backup/reconciliacion, indicador de estado de conexion y frescura de datos.
**Uses:** OAuth 2.0, Supabase Queues/pgmq, worker Node en VPS
**Implements:** GHL adapter (auto-carga, mejora #2)
**Avoids:** Pitfall 5 (rotacion de refresh token), Pitfall 6 (rate limits/webhooks perdidos), Pitfall 2 (doble conteo, implementacion de dedup)

### Phase 5: Capa de IA -- analista/coach y copiloto NL
**Rationale:** No tiene sentido sin roll-ups + metas ya construidos; meter IA antes produce demos vistosas sobre datos vacios. Empezar por coach/analista (mayor valor percibido, menor riesgo que NL query).
**Delivers:** AI Orchestrator con tool-calling tenant-scoped, IA analista/coach sobre agregados con structured outputs, copiloto NL con resolucion de entidades y consulta estructurada intermedia.
**Uses:** `@anthropic-ai/sdk`, `messages.parse`+Zod, model routing (Sonnet/Opus)
**Implements:** AI Orchestrator + tools tenant-scoped
**Avoids:** Pitfall 7 (IA alucina cifras), Pitfall 9 (costo de tokens sin control), Pitfall 10 (NLP malinterpreta la pregunta)

### Phase 6: Alertas/anomalias + notification dispatcher
**Rationale:** Depende de metas (fase 3), IA (fase 5) y del dispatcher para tener contra que comparar y un canal de salida ya cableado.
**Delivers:** scanner programado de anomalias (burnout, caida de cierre, no-shows) con baseline por persona, dispatcher unico hacia GHL workflow/Slack.
**Addresses:** IA de alertas/anomalias, deteccion de burnout del closer
**Avoids:** Pitfall 8 (fatiga de alertas), Pitfall 5 (mensajeria propia -- regla Maze)

### Phase Ordering Rationale

- El orden sigue la cadena de dependencias explicita en ARCHITECTURE.md: tenancy -> modelo de datos -> tracking manual -> metas -> GHL -> IA -> alertas. Cada fase solo se apoya en contratos ya estabilizados de la anterior.
- El Core Value ("funciona con o sin GHL") exige que el producto sea completo y vendible al terminar la Fase 2, antes de tocar la integracion externa mas riesgosa (GHL OAuth/dedup) o la capa de IA.
- La IA se pospone deliberadamente hasta tener datos reales agregados (roll-ups + metas) para evitar el anti-patron de "demo vistosa sobre datos vacios" y el riesgo de alucinacion sin grounding.
- Los pitfalls criticos (definiciones ambiguas, friccion de carga, fuga entre tenants) se resuelven en las fases 1-2 porque son estructurales -- diferirlos implica rewrite, no ajuste.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4 (Integracion GHL):** OAuth 2.0 Marketplace App, catalogo de webhooks por scope y mapeo de pipeline stages son areas MEDIUM confidence -- verificar contra la app registrada real de Maze en el marketplace de GHL antes de implementar.
- **Phase 5 (Capa de IA):** orquestacion multi-paso (fan-out por tenant, retries) y el diseno del catalogo de `tools` tenant-scoped requieren refinamiento en implementacion -- patron solido pero no 100% cerrado.
- **Phase 6 (Alertas):** calibracion de umbrales/baseline por persona es un area donde la investigacion da principios pero no formulas exactas -- necesita iteracion con datos reales.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Tenancy + RLS):** patron estandar de Supabase multi-tenant, documentado con fuentes oficiales HIGH confidence.
- **Phase 2 (Tracking manual):** modelo de datos ya validado contra la planilla "CAMINO DIGITAL"; patrones de captura mobile-first bien establecidos.
- **Phase 3 (Metas/pacing):** formulas de quota attainment/pacing son estandar de la industria (Klipfolio, Salesforce), bien documentadas.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Framework/DB/IA verificados con Context7 y docs oficiales (Next.js, Supabase, Anthropic SDK). MEDIUM en background jobs/rollups/detalles finos de OAuth GHL. |
| Features | HIGH | Modelo de datos validado contra la planilla real "CAMINO DIGITAL" (PROJECT.md) + patrones de mercado confirmados con multiples SaaS de referencia (SPOTIO, Gong, Ambition, Salesforce, HubSpot). |
| Architecture | HIGH en multi-tenancy RLS, ingesta GHL, notificaciones (fuentes oficiales Supabase/GHL) | MEDIUM en orquestacion de IA -- patron solido pero dependiente de refinamiento en implementacion. |
| Pitfalls | HIGH | Rate limits/OAuth de GHL y RLS de Supabase verificados con docs oficiales; pitfalls de dominio (friccion de carga, ambiguedad de definiciones) basados en analisis directo de la planilla origen -- evidencia de primera mano, no solo patrones genericos. |

**Overall confidence:** HIGH

### Gaps to Address

- **Catalogo exacto de webhooks disponibles por scope de GHL:** el research confirma el patron (Location+Company scope, firma Ed25519) pero no el listado final de eventos disponibles para la app real de Maze -- validar al registrar la Marketplace App.
- **Umbral de "friccion aceptable" en la captura manual:** el research recomienda <30 seg/dia pero no hay dato de usuario real aun -- instrumentar tasa de adopcion desde el MVP y ajustar UX con datos reales.
- **Costo real de IA en produccion multi-tenant:** las estimaciones de model routing (Haiku/Sonnet/Opus) son razonables pero no hay benchmark de costo por tenant -- instrumentar desde el dia 1 de la Fase 5, no asumir.
- **Definicion exacta de "dias habiles" para pacing por tenant:** cada agencia puede tener calendario distinto (fines de semana, feriados) -- validar con Alejandro en la Fase 3 antes de fijar la logica.

## Sources

### Primary (HIGH confidence)
- `/vercel/next.js` (Context7) -- versiones, Turbopack default, React Compiler, `middleware.ts`->`proxy.ts`
- `/anthropics/anthropic-sdk-typescript` (Context7) -- `messages.parse`, `zodOutputFormat`, tool use
- platform.claude.com/docs -- model IDs (opus-4-8, sonnet-4-6, haiku-4-5)
- marketplace.gohighlevel.com/docs/Authorization/OAuth2.0 -- OAuth obligatorio, rotacion de refresh token, rate limits
- marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide -- firma Ed25519, reintentos, circuit breaker
- supabase.com/docs (RLS performance, custom claims/RBAC, queues, drizzle) -- patrones de multi-tenancy y background jobs
- help.gohighlevel.com -- API rate limits (100 req/10s, 200k/dia por app/recurso)
- Analisis directo del template "CAMINO DIGITAL" (PROJECT.md) -- modelo de KPIs y causas del fracaso de la planilla

### Secondary (MEDIUM confidence)
- bytebase.com / makerkit.dev -- Drizzle vs Prisma, RLS nativo
- tigerdata.com / hackernoon -- descarte de TimescaleDB
- buildmvpfast.com / hashbuilds.com -- Inngest vs Trigger.dev vs Vercel Cron
- SPOTIO, Gong, ZoomInfo, Highspot, Salesforce, Klipfolio, HubSpot, Improvado -- benchmarks de features y dashboards de sales analytics
- Contexto interno Maze (Setter Agendador, lock Redis, spending cap Gemini) -- patrones ya vividos en el ecosistema

### Tertiary (LOW confidence)
- Ninguna fuente marcada como LOW en la investigacion.

---
*Research completed: 2026-06-30*
*Ready for roadmap: yes*
