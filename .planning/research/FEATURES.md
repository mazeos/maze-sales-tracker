# Feature Research

**Domain:** SaaS multi-tenant de sales performance tracking (setter → triage → closer / appointment-setting high-ticket)
**Researched:** 2026-06-30
**Confidence:** HIGH (modelo de datos ya validado en la planilla "CAMINO DIGITAL" + patrones de mercado confirmados con SPOTIO, Gong, Ambition, Salesforce, HubSpot)

## Contexto de lectura

Este dominio tiene una particularidad: **el "competidor" a superar no es otro SaaS, es una planilla de Google Sheets** (template "CAMINO DIGITAL") que los clientes ya usan y entienden. Eso invierte la lógica normal de table-stakes:

- **Table stakes = paridad con la planilla.** Si la app no captura y calcula todo lo que la planilla ya hace, el usuario vuelve a Sheets. La planilla es el piso, no el techo.
- **Diferenciadores = los 4 huecos de la planilla + la capa de IA.** Ahí está la razón para migrar.
- **Anti-features = todo lo que convierta esto en "otro CRM" o compita con GHL.**

Las estimaciones de complejidad son relativas a un stack Next.js + Supabase con un dev que ya domina la API de GHL.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Sin esto la app no reemplaza la planilla y el usuario no migra. No dan crédito por tenerlos; penalizan brutalmente por que falten.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Multi-tenancy con aislamiento por tenant** | Es un producto para N agencias; datos de una no pueden filtrar a otra | HIGH | RLS de Supabase por `tenant_id` en cada tabla. Decidir el día 1 — retrofittear multi-tenancy es un rewrite. Bloquea todo lo demás. |
| **Gestión de equipo y roles (setter / triage / closer)** | El modelo entero cuelga de "quién hizo qué". Un miembro puede tener más de un rol | MEDIUM | Miembros ≠ usuarios-login necesariamente (un setter puede no loguearse; el dueño carga por él). Soportar solo-setter / setter+closer / setter+triage+closer con el mismo esquema. |
| **Captura manual de métricas diarias por miembro** | Core value explícito: la app funciona SIN GHL. Reemplaza el "contador en el celular" | MEDIUM | UI rápida tipo tally/quick-entry, no formulario largo. Es el fallback universal y la fuente de verdad cuando no hay integración. Debe ser mobile-friendly (el setter carga desde el cel). |
| **Embudo completo con tasas calculadas** | Es el corazón del tracker: conversaciones → respuestas → seguimientos → links → agendados → asistencias → pases → ofertas → cierres → cash | MEDIUM | Las tasas (agendamiento, lead→agenda, show-rate, close-rate) son fórmulas derivadas; guardar los conteos crudos y calcular, nunca guardar tasas. |
| **Métricas de setter completas** | Paridad planilla: outbound, inbound (IG / Wpp-TikTok / Wpp-IG), bienvenidas, CTA, conversaciones, respuestas, seguimientos, links, agendados, por línea de oferta (Membresía/Lite/High-Ticket) | MEDIUM | El desglose por **canal** y por **línea de oferta** es lo que hace pesado el modelo. Modelar como dimensiones, no como columnas fijas. |
| **Métricas de triage** | Paridad planilla: agendadas, asistencias, no-shows, pases a closer y tasas | LOW | Etapa intermedia; pocos campos pero necesaria para agencias con triage. Debe poder "apagarse" para equipos sin triage. |
| **Métricas de closer completas** | Paridad planilla: disponibilidad, % ocupación, asistencias, ofertas presentadas vs no, cancelados, no-shows, cierres, referidos, cash collected (nuevo/cuotas/reservas), revenue | HIGH | La parte con más campos y con dinero de por medio (mayor exigencia de exactitud). Separar cash collected por tipo es requisito, no opcional. |
| **Log de ventas con atribución completa** | Sin atribución (closer+triage+setter+fuente) no hay comisiones ni análisis de fuente | MEDIUM | Una venta enlaza a múltiples miembros (crédito compartido) + fuente del lead + programa + método de pago + montos. Es la tabla que alimenta casi todos los roll-ups de dinero. |
| **Roll-ups temporales (diario/semanal/mensual/trimestral/anual)** | La planilla los tiene; sin agregación no hay "cómo venimos" | HIGH | Definir límites de semana/mes según zona horaria del tenant (Ale = UTC-3). Materializar agregados o calcular on-the-fly con cuidado de performance. Aplica a TODOS los roles (ver mejora #3). |
| **Dashboard de resumen legible** | La queja explícita de la planilla es la "pared de columnas". El dashboard es la razón visible de migrar | MEDIUM | Vista de un golpe: KPIs clave arriba, drill-down abajo. No replicar la grilla de Sheets. |
| **Vistas por rol y por persona** | El dueño mira el equipo; cada rep mira lo suyo | MEDIUM | Filtros por miembro / rol / rango de fechas / línea de oferta. Depende del modelo de roles. |
| **Diccionario de datos embebido (mejora #4)** | Table stake disfrazado de mejora: sin definiciones in-app, los números se cargan mal y todo el dato se corrompe | LOW | Tooltips / ayuda contextual con las definiciones del curso. Barato de construir, altísimo ROI en calidad de dato. Es el guardián de la confiabilidad del resto. |

### Differentiators (Competitive Advantage)

Aquí se compite. Alinean con el Core Value ("métricas confiables y decisiones accionables") y son las razones reales para dejar la planilla.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Metas + pacing goal-vs-actual (mejora #1)** | "¿Voy adelantado o atrasado?" en vivo, por rol/persona. La planilla no tiene metas. Es el feature más pedido en sales analytics (quota attainment + pacing) | MEDIUM | Meta por período/rol/persona/línea; pace lineal proyectado a fin de período. Depende de roll-ups. Es el diferenciador #1 no-IA: alto valor, costo medio. |
| **Auto-carga desde GHL (mejora #2)** | Mata el trabajo manual: citas, conversaciones y ventas entran solas. La razón de peso para un tenant con GHL | HIGH | OAuth por tenant + mapeo de entidades GHL → métricas. Convive con carga manual (no la reemplaza). Riesgo de duplicados: necesita idempotencia/dedup (patrón ya conocido en Maze: 1 fila por `igSid`). Ver PITFALLS. |
| **Roll-ups automáticos también para setters (mejora #3)** | La planilla NO automatizaba el resumen del setter — hueco explícito. Cerrarlo es diferenciador directo vs el original | LOW-MEDIUM | Técnicamente es aplicar el motor de roll-ups (ya existente para closers) a los datos de setter. Bajo costo incremental si el motor está bien diseñado. |
| **IA analista/coach** | Lee los números y da recomendaciones accionables ("este setter cayó 30% en agenda, revisá link→agenda"). Diferenciador CENTRAL declarado por Alejandro | HIGH | Claude Opus/Sonnet sobre los agregados. Debe razonar sobre deltas y tasas, no solo describir. Depende de roll-ups + metas para tener contra qué comparar. |
| **IA de alertas / detección de anomalías** | Vigila y avisa proactivamente (closer quemándose por % ocupación, caída de cierre, no-shows en alza) vía Slack/email | HIGH | Combina reglas simples (umbrales sobre burnout/close-rate) + IA para contexto. Saliente SOLO vía Slack/GHL workflows (regla Maze, nunca mensajería propia). Depende de roll-ups. |
| **IA de consultas en lenguaje natural** | Copiloto del dashboard: "¿cómo viene Facu esta semana vs la pasada?". Elimina la fricción de armar vistas | HIGH | Text-to-query sobre el modelo. Riesgo de alucinar números → debe ejecutar consultas reales, no inventar. Diferenciador "wow" pero el de mayor riesgo de exactitud. Ver anti-features. |
| **IA de auto-carga (interpretación/mapeo GHL)** | Interpreta datos ambiguos de GHL y los mapea a la métrica correcta cuando el mapeo determinista falla | MEDIUM-HIGH | Complementa, no reemplaza, el mapeo por reglas. Usar IA solo para lo ambiguo; lo determinista va por reglas (más barato y confiable). |
| **Detección de burnout del closer (% ocupación)** | Métrica de bienestar poco común en trackers; protege el activo más caro del equipo | LOW | Ya está en el modelo (disponibilidad vs ocupación). Convertirla en semáforo/alerta es diferenciador de bajo costo. |
| **Atribución por fuente de lead** | Saber qué canal (IG/TikTok/Wpp) produce ventas reales, no solo conversaciones | MEDIUM | Ya en el log de ventas. El diferencial es cruzarlo con revenue en el dashboard, no solo registrarlo. |

### Anti-Features (Commonly Requested, Often Problematic)

Features que parecen buenos pero destruyen el foco o meten a la app en terreno de GHL.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Convertirse en CRM (contactos, pipeline, inbox)** | "Ya que trackea ventas, que maneje los leads" | Compite con GHL, multiplica el scope 10x, rompe el posicionamiento "Maze sobre GHL". Fuera de scope explícito | Integrar con GHL como CRM; la app solo mide resultados |
| **Facturación / cobros dentro de la app** | "Si registra cash collected, que cobre" | GHL/Stripe ya cobran; duplicar es riesgo legal + PCI + scope enorme. Fuera de scope explícito | Registrar el resultado del cobro, no ejecutarlo |
| **IA que "escribe" los números o autocompleta sin fuente** | "Que la IA llene lo que falta" | Un tracker con números inventados pierde toda su razón de ser (confiabilidad). El Core Value muere | IA solo lee/analiza/consulta datos reales; nunca fabrica métricas. NL query ejecuta consultas, no estima |
| **Dashboards 100% configurables / builder de widgets** | "Que cada agencia arme su vista" | Sobre-ingeniería en v1; explota QA y soporte; retrasa el lanzamiento. Nadie migra por un dashboard-builder | Vistas curadas y opinadas por rol. Configurabilidad recién tras validar |
| **Gamificación / leaderboards competitivos entre reps** | Común en SPOTIO/Ambition; "motiva al equipo" | En high-ticket con equipos chicos puede ser tóxico y no es el dolor a resolver. Distrae del análisis | Ranking simple opcional dentro del dashboard; no un módulo de gamificación |
| **App móvil nativa** | "El setter carga desde el cel" | iOS/Android nativo duplica el esfuerzo de build y release. Fuera de scope explícito | Web responsive mobile-first para la carga rápida |
| **Reporte/PDF exports elaborados, white-label de reportes** | "Para mandarle al cliente" | Feature de madurez; en v1 consume tiempo sin validar el core | Exportar CSV simple si hace falta; PDFs en v2 |
| **Real-time / websockets en todo** | "Que se actualice al instante" | Complejidad de infra sin valor real: los datos de ventas se leen por día/semana, no por segundo | Refresh on-load + sync GHL periódico. Real-time solo si un dato lo justifica |
| **Comisiones / cálculo de payout automático** | "Ya que atribuye ventas, que calcule comisiones" | Reglas de comisión son infinitamente variables por agencia; soporte pesadillesco | Exponer la atribución y montos; que el dueño calcule comisiones afuera en v1 |
| **Multi-idioma / i18n** | "Por si vendo afuera" | La audiencia es 100% español (castellano latino). i18n es peso muerto en v1 | Español hardcodeado; i18n solo si aparece demanda real |

---

## Feature Dependencies

```
[Multi-tenancy + aislamiento (RLS)]
    └──requires──> (nada, es el cimiento — va primero)

[Gestión de equipo y roles]
    └──requires──> [Multi-tenancy]

[Captura manual de métricas]
    └──requires──> [Gestión de equipo y roles]

[Embudo con tasas] + [Métricas setter/triage/closer] + [Log de ventas]
    └──requires──> [Captura manual de métricas]

[Roll-ups temporales (todos los roles)]
    └──requires──> [Embudo + métricas + log de ventas]

[Metas + pacing (mejora #1)]
    └──requires──> [Roll-ups temporales]

[Dashboard de resumen]
    └──requires──> [Roll-ups] ──enhances──> [Metas + pacing]

[Auto-carga GHL (mejora #2)]
    └──requires──> [Gestión de equipo] + [modelo de métricas]
    └──requires──> [dedup / idempotencia] (crítico)

[IA auto-carga] ──enhances──> [Auto-carga GHL]

[IA analista/coach] + [IA alertas] + [IA NL query]
    └──requires──> [Roll-ups] + [Metas]   (necesitan contra-qué-comparar)

[IA alertas] ──requires──> [canal saliente Slack/GHL] (nunca mensajería propia)

[Diccionario embebido (mejora #4)]
    └──enhances──> [Captura manual]  (mejora calidad de dato en origen)
    └──requires──> (casi nada — se puede hacer temprano y barato)

[Roll-ups setters (mejora #3)] = [Roll-ups temporales] aplicado a setter (mismo motor)
```

### Dependency Notes

- **Todo cuelga de multi-tenancy + roles:** son el cimiento. Retrofittear aislamiento por tenant es un rewrite; por eso van en la primera fase sí o sí.
- **Los roll-ups son el cuello de botella de valor:** metas/pacing, dashboard y las 3 IAs analíticas dependen de tener agregados confiables. Es la feature-pivote del roadmap.
- **La IA no puede ir antes que los datos:** coach, alertas y NL query no tienen sentido sin roll-ups + metas. Meter IA temprano produce demos vistosas sobre datos vacíos.
- **Auto-carga GHL depende de dedup:** sin idempotencia, la integración duplica citas/ventas y corrompe todo (patrón ya sufrido en Maze con el hub de atribución). El dedup es prerequisito, no un extra.
- **Mejora #3 (roll-ups setter) es casi gratis** si el motor de roll-ups se diseña genérico por rol desde el inicio — no la traten como feature separada.
- **Diccionario embebido (#4) es independiente y barato:** puede entrar temprano y protege la calidad de todo el dato manual. Alto ROI, baja dependencia.

---

## MVP Definition

### Launch With (v1)

Mínimo para reemplazar la planilla con ventaja clara. Regla: **paridad total + los 2 diferenciadores no-IA más baratos + al menos 1 IA que demuestre el pitch.**

- [ ] **Multi-tenancy con RLS** — cimiento, no negociable
- [ ] **Equipo + roles configurables** (solo-setter / +triage / +closer) — el modelo cuelga de acá
- [ ] **Captura manual mobile-first** — el core value es funcionar sin GHL
- [ ] **Embudo + métricas completas de los 3 roles + tasas** — paridad planilla
- [ ] **Log de ventas con atribución completa** — sin esto no hay análisis de dinero
- [ ] **Roll-ups automáticos para todos los roles, incl. setter (mejora #3)** — cierra hueco de la planilla casi gratis
- [ ] **Dashboard de resumen legible** — la razón visible de migrar
- [ ] **Metas + pacing goal-vs-actual (mejora #1)** — diferenciador #1 no-IA, alto valor
- [ ] **Diccionario de datos embebido (mejora #4)** — barato, protege la calidad de todo el dato
- [ ] **1 capacidad de IA como prueba de concepto** — recomendado: **IA analista/coach** (mayor valor percibido, menor riesgo de exactitud que NL query, no depende de saliente como las alertas)

### Add After Validation (v1.x)

- [ ] **Auto-carga desde GHL (mejora #2)** — trigger: hay tenants con GHL pidiendo dejar de cargar a mano. Alto valor pero alto riesgo (dedup); mejor tras estabilizar el core manual
- [ ] **IA de alertas / anomalías** — trigger: hay suficientes datos históricos para definir umbrales; canal Slack/GHL ya cableado
- [ ] **IA de consultas en lenguaje natural** — trigger: el modelo de datos está estable; requiere el mayor cuidado anti-alucinación
- [ ] **IA de auto-carga (mapeo ambiguo)** — trigger: la auto-carga determinista ya funciona y aparecen casos ambiguos reales

### Future Consideration (v2+)

- [ ] **Exportes/PDF de reportes** — tras PMF, si los dueños quieren mandarlos al mentor
- [ ] **Ranking simple opcional** — solo si aparece demanda, sin gamificación pesada
- [ ] **Dashboards configurables** — solo si las vistas curadas se quedan cortas
- [ ] **Billing del propio SaaS** — fuera de scope hasta comercializar (ya declarado)

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Multi-tenancy + RLS | HIGH | HIGH | P1 |
| Equipo + roles | HIGH | MEDIUM | P1 |
| Captura manual mobile-first | HIGH | MEDIUM | P1 |
| Embudo + métricas 3 roles + tasas | HIGH | MEDIUM-HIGH | P1 |
| Log de ventas con atribución | HIGH | MEDIUM | P1 |
| Roll-ups todos los roles (incl. setter) | HIGH | HIGH | P1 |
| Dashboard de resumen | HIGH | MEDIUM | P1 |
| Metas + pacing (mejora #1) | HIGH | MEDIUM | P1 |
| Diccionario embebido (mejora #4) | MEDIUM | LOW | P1 |
| IA analista/coach | HIGH | HIGH | P1-P2 (1 IA en v1) |
| Auto-carga GHL (mejora #2) | HIGH | HIGH | P2 |
| IA alertas/anomalías | MEDIUM-HIGH | HIGH | P2 |
| IA NL query | MEDIUM-HIGH | HIGH | P2 |
| IA auto-carga (mapeo ambiguo) | MEDIUM | MEDIUM-HIGH | P2-P3 |
| Detección burnout closer | MEDIUM | LOW | P2 |
| Exportes/PDF | LOW | MEDIUM | P3 |
| Ranking/gamificación | LOW | MEDIUM | P3 |

**Priority key:** P1 = must have para lanzar · P2 = agregar apenas se pueda · P3 = nice to have futuro

---

## Competitor Feature Analysis

El "competidor" real es la planilla; los SaaS del mercado sirven para calibrar table-stakes de la categoría.

| Feature | Planilla "CAMINO DIGITAL" | SaaS mercado (SPOTIO/Gong/Ambition) | Our Approach |
|---------|---------------------------|--------------------------------------|--------------|
| Métricas por rep/rol | Sí, buen modelo KPI (8,5/10) | Scorecards por SDR/AE | Igualar el modelo + desglose por canal y línea de oferta |
| Carga de datos | 100% manual con apps "contador" (6,5/10 operativo) | Sync CRM automático | Manual mobile-first **+** auto-carga GHL (coexisten) |
| Metas / pacing | No tiene | Quota attainment + pacing charts | Metas por rol/persona + pace proyectado (mejora #1) |
| Roll-up setter | No automatizado (hueco) | Agregación estándar | Automatizado para todos los roles (mejora #3) |
| Definiciones | Solo en video del curso | Tooltips dispersos | Diccionario embebido in-app (mejora #4) |
| Coaching | No | Gong: scorecards + AI coaching | IA analista/coach sobre los agregados (diferenciador central) |
| Alertas | No | Ambition/algunas: alertas de umbral | IA de anomalías vía Slack/GHL (nunca mensajería propia) |
| Consultas NL | No | Emergente (ThoughtSpot-style) | Copiloto NL query con ejecución real anti-alucinación |
| Leaderboard/gamificación | No | SPOTIO/Ambition: fuerte | Deliberadamente mínimo (anti-feature en v1) |

---

## Sources

- Análisis previo del template "CAMINO DIGITAL" y modelo de KPIs (PROJECT.md) — HIGH
- [SPOTIO — Sales Rep Tracking](https://spotio.com/features/sales-rep-tracking/) — leaderboards, activity tracking — MEDIUM
- [Gong — Sales Coaching Software](https://www.gong.io/sales-coaching-software) — scorecards + AI coaching — MEDIUM
- [ZoomInfo — Building a Sales Rep Scorecard](https://pipeline.zoominfo.com/sales/building-a-sales-rep-scorecard) — SDR vs AE metrics split — MEDIUM
- [Highspot — Sales Scorecards](https://www.highspot.com/blog/sales-scorecards/) — scorecard patterns — MEDIUM
- [Salesforce — Sales Dashboard Examples](https://www.salesforce.com/sales/analytics/sales-dashboard-examples/) — dashboard/leaderboard patterns — MEDIUM
- [Klipfolio — Sales Quota Attainment](https://www.klipfolio.com/resources/kpi-examples/sales/sales-quota-attainment) — pacing/quota formula — MEDIUM
- [HubSpot — Sales Performance Dashboard](https://blog.hubspot.com/sales/sales-dashboard) — dashboard metrics — MEDIUM
- [Improvado — Sales Dashboard 25 Core Metrics](https://improvado.io/blog/sales-dashboard) — benchmark de métricas estándar — MEDIUM

---
*Feature research for: SaaS sales performance tracking (setter → triage → closer)*
*Researched: 2026-06-30*
