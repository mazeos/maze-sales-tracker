# Maze Sales Tracker IA

## What This Is

Una app web multi-tenant que reemplaza el tracker de ventas en planilla (estilo "CAMINO DIGITAL") por un sistema con IA. Trackea el embudo completo de un equipo de ventas — setter → triage → closer — y convierte la actividad diaria en métricas confiables y decisiones accionables. Es un **producto standalone** pensado para entregárselo o venderlo a los clientes de mentoring de Maze Funnels (emprendedores que arman su agencia/equipo de ventas).

## Core Value

Convertir la actividad diaria de un equipo de ventas en métricas confiables y decisiones accionables — **funcionando con o sin GHL conectado**. Si todo lo demás falla, el dueño de la agencia tiene que poder ver su embudo real (no inflado, no roto) y saber si va bien o mal contra sus metas.

## Requirements

### Validated

(None yet — ship to validate)

### Active

<!-- Hipótesis hasta que se shippeen y validen -->

**Núcleo del tracker (paridad con la planilla + arreglo de sus huecos)**
- [ ] Multi-tenant: cada cliente/agencia tiene su espacio aislado
- [ ] Equipos configurables: soporta solo-setter / setter+closer / setter+triage+closer con el mismo modelo
- [ ] Captura **manual** de métricas diarias por miembro (reemplaza el "contador en el celular" dentro de la app, no en una app aparte)
- [ ] Embudo completo con tasas calculadas: conversaciones nuevas → respuestas → seguimientos → links → agendados → asistencias → pases a closer → ofertas → cierres → cash
- [ ] Métricas de setter: outbound, inbound (IG / Wpp-TikTok / Wpp-IG), bienvenidas, CTA, links de agenda, agendados, tasa de agendamiento, % lead→agenda, por línea de oferta (Membresía / Lite / High Ticket)
- [ ] Métricas de closer: disponibilidad y % de ocupación (detección de burnout), asistencias, ofertas presentadas vs no presentadas (fit del lead), cancelados, no-shows, cierres, referidos, cash collected (nuevo / cuotas / reservas), revenue facturado
- [ ] Métricas de triage: agendadas, asistencias, no-shows, pases a closer y sus tasas
- [ ] Log de ventas con atribución completa: cliente, programa, método de pago, monto facturado, cash collected, cuotas, reserva, closer + triage + setter + **fuente del lead**
- [ ] Roll-ups automáticos diario / semanal / mensual / trimestral / anual para **todos los roles, incluido el setter** (mejora #3 — la planilla no lo automatizaba para setters)

**Las 4 mejoras sobre la planilla original**
- [ ] **Metas y pacing** (mejora #1): objetivos por rol/persona y vista goal-vs-actual con ritmo (¿voy adelantado o atrasado?)
- [ ] **Auto-carga desde GHL** (mejora #2): la integración lee conversaciones, citas y ventas de GHL y completa métricas automáticamente — sin reemplazar la carga manual, que sigue disponible
- [ ] **Definiciones embebidas** (mejora #4): el diccionario de datos del curso vive dentro de la app (tooltips/ayuda contextual), no en un video aparte
- [ ] Dashboard legible: vista de resumen de un golpe de vista (no la "pared de columnas" de la planilla)

**Capa de IA (las 4, definidas con Alejandro)**
- [ ] IA de auto-carga: interpreta datos de GHL y los mapea a las métricas correctas
- [ ] IA analista/coach: lee los números y da recomendaciones accionables ("este setter cayó 30% en agenda, revisá su tasa link→agenda")
- [ ] IA de alertas/anomalías: vigila y avisa (closer quemándose, caída de cierre, no-shows en alza) vía Slack/email
- [ ] IA de consultas en lenguaje natural: copiloto del dashboard ("¿cómo viene Facu esta semana vs la pasada?")

### Out of Scope

- Reemplazar a GHL como CRM — se **integra** con GHL, no lo reemplaza
- Facturación/cobros dentro de la app — eso vive en GHL/Stripe; acá solo se registra el resultado
- App móvil nativa — v1 es web responsive
- Onboarding/venta de la propia app (billing del SaaS) — primero el producto, después la comercialización

## Context

- **Origen:** se basa en el análisis del template "CAMINO DIGITAL" (planilla de Google Sheets) y su curso en video. El template tiene un buen modelo de KPIs (8,5/10) pero falla como herramienta operativa (6,5): carga 100% manual con apps "contadores", sin metas, resumen de setters no automatizado, y definiciones que viven solo en el video. Esta app cierra esos 4 huecos.
- **Audiencia:** clientes de mentoring de Maze Funnels — emprendedores con equipos de ventas de appointment-setting / high-ticket.
- **Ecosistema Maze:** ya hay GHL conectado (MCP propio, location `siM5ZYQ90OgKoshnqLeC`), Slack como canal de soporte, n8n como puente de automatización. Maze ya se posiciona abiertamente como marca sobre GHL.
- **Modelo de datos conocido:** el embudo de dos/tres etapas (setter → triage → closer) y todas las métricas ya están mapeadas en el análisis previo.

## Constraints

- **Tech stack**: Next.js + Supabase (alineado con las demás apps de Maze — maze-growth, maze-scheduler) — coherencia y reutilización de conocimiento. *(A confirmar/refinar en research.)*
- **Integración**: GHL vía API REST / OAuth (cada tenant conecta su propia cuenta GHL; si no tiene, usa carga manual) — Maze ya domina la API de GHL.
- **Multi-tenancy**: aislamiento por tenant desde el día 1 — es un producto para múltiples clientes.
- **IA**: modelos Claude (Opus 4.8 / Sonnet) — stack de IA preferido de Maze.
- **Idioma**: interfaz y copy en español (castellano latino).
- **Comunicación saliente**: notificaciones/alertas vía GHL workflows y/o Slack — nunca mensajería propia (regla Maze).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Producto standalone (no módulo de maze-hq) | Va dirigido a clientes de mentoring para entregarlo/venderlo; necesita identidad y multi-tenancy propias | — Pending |
| Carga manual **y** auto-carga por API coexisten | El sistema debe funcionar sin GHL conectado; el dueño no puede quedar bloqueado si no integra | — Pending |
| Las 4 capacidades de IA en v1 (auto-carga, coach, alertas, NL) | Decisión explícita de Alejandro — la IA es el diferenciador central del producto | — Pending |
| Multi-tenant desde el día 1 | Es un producto para múltiples agencias, no una herramienta interna | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-30 after initialization*
