# Stack Research

**Domain:** SaaS multi-tenant de sales-performance tracking (setter → triage → closer) con integración GHL + capa de IA (Claude)
**Researched:** 2026-06-30
**Confidence:** HIGH (framework/DB/IA), MEDIUM (background jobs / rollups / GHL OAuth details)

## Veredicto rápido

**Confirmá el stack Next.js + Supabase — es correcto para este dominio y coherente con maze-growth / maze-scheduler.** Pero hay que refinar 4 cosas donde el PROJECT.md está desactualizado o incompleto:

1. **GHL NO se integra por "API key por location".** Las API keys V1 están fuera de soporte desde el 31-dic-2025. Multi-tenant obliga a **OAuth 2.0 marketplace app** (Location + Company scope). Esto es un cambio de arquitectura, no un detalle.
2. **No uses TimescaleDB.** El volumen de datos de este producto (decenas de filas/día/tenant) no es time-series de verdad; además Supabase ya no ofrece la extensión. Rollups = tablas de resumen refrescadas por `pg_cron`.
3. **La IA de Claude ahora tiene structured outputs nativos** (`messages.parse` + Zod) — esto simplifica muchísimo auto-mapeo, clasificación de anomalías y recomendaciones del coach. No hace falta parsear JSON a mano.
4. **Alertas salientes van por n8n → Slack/GHL** (ya está en el ecosistema y respeta la regla "nunca mensajería propia"), no por un mailer propio.

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Next.js (App Router)** | 16.2.x | Framework full-stack web + API | Stable actual (jun-2026), Turbopack por defecto, React Compiler estable, Server Actions/PPR. Es el stack de las otras apps Maze → reutilización de conocimiento. **HIGH** |
| **React** | 19.x | UI | Viene con Next 16; React Compiler auto-memoiza. **HIGH** |
| **TypeScript** | 5.x | Type-safety end-to-end | Estándar; crítico para compartir tipos entre DB (Drizzle) y IA (Zod). **HIGH** |
| **Supabase (Postgres)** | Cloud, Postgres 15+ | DB + Auth + RLS + Realtime + Storage | Postgres gestionado con RLS nativo = motor de multi-tenancy. Auth incluido. Coherente con maze-growth. **HIGH** |
| **Supabase Auth** | supabase-js v2.x | Login, sesiones, JWT | Integra con RLS vía claims. `@supabase/ssr` para App Router. **HIGH** |
| **Drizzle ORM** | ^0.44 (latest) | Query builder + migraciones type-safe | SQL-first, bundle ~57KB (28x menor que Prisma 7), **soporte RLS nativo** para políticas por tenant, ideal en serverless/edge. Genera tipos desde el schema. **HIGH** |
| **Anthropic SDK (TypeScript)** | `@anthropic-ai/sdk` latest | Orquestación de los 4 usos de IA | Structured outputs nativos (`messages.parse` + `zodOutputFormat`), tool use, prompt caching, Message Batches. Modelos Claude = stack IA preferido de Maze. **HIGH** |

### Multi-tenancy (el corazón del producto)

| Pieza | Recomendación | Por qué |
|-------|---------------|---------|
| Modelo | Tabla `organizations` + `memberships` (user↔org↔rol) + `org_id` en TODA tabla de datos | Patrón estándar B2B SaaS; un usuario puede pertenecer a varias agencias. **HIGH** |
| Aislamiento | **RLS de Supabase** con política `org_id = auth.jwt()->>'org_id'` en cada tabla | Aislamiento a nivel DB, no de aplicación → un bug de query no filtra datos entre tenants. **HIGH** |
| Claim de tenant | **Custom Access Token Hook** de Supabase que inyecta `org_id`/`role` en el JWT | Evita un JOIN a memberships en cada request; RLS lee el claim directo. **HIGH** |
| Rol de servicio | Service role key SOLO en workers de background (bypass RLS con `org_id` explícito) | Los jobs de sync/rollup corren fuera de sesión de usuario. **HIGH** |

**Regla:** nunca confiar en el front para filtrar por tenant. RLS es la última línea; el claim de JWT es la primera.

### Integración GoHighLevel (auto-carga)

| Pieza | Recomendación | Por qué |
|-------|---------------|---------|
| Auth | **OAuth 2.0 Marketplace App** (Client ID + Secret), scope **Location-level** (sub-account por tenant) + Company-level donde aplique | API V1/API-keys sin soporte desde 31-dic-2025. OAuth es obligatorio para apps multi–sub-account. **HIGH** |
| Storage de tokens | `access_token` + `refresh_token` **cifrados** por tenant (columna cifrada / Supabase Vault), refresh automático en el worker | Tokens OAuth son de vida corta; el refresh token es la credencial sensible. **HIGH** |
| Ingesta real-time | **Webhooks de GHL** (conversation, appointment, opportunity/sale) → endpoint del app → cola | Empuja eventos sin polling; menor latencia y menos consumo de rate limit. **MEDIUM** (verificar catálogo de webhooks por scope) |
| Backfill / reconciliación | **Polling programado** (por tenant) como red de seguridad de los webhooks | Webhooks se pierden; un sync diario reconcilia. Límite: 200k requests/día por app por resource. **MEDIUM** |
| Degradación | Toda métrica tiene origen `manual | ghl`; si un tenant no conecta GHL, la carga manual cubre todo | Requisito core: funcionar sin GHL. **HIGH** |

### Capa de IA (los 4 usos, con Claude)

| Uso | Modelo sugerido | Técnica | Por qué |
|-----|-----------------|---------|---------|
| **1. Auto-mapeo GHL→métricas** | Haiku 4.5 / Sonnet 4.6 | `messages.parse` + **structured output (Zod)** | Clasificación estructurada barata y determinística; el schema Zod garantiza que salga a la métrica correcta. |
| **2. Analista/coach** | **Opus 4.8** (Sonnet 4.6 para reportes livianos) | Structured output (recomendaciones tipadas) + **prompt caching** del diccionario de datos | Razonamiento profundo sobre tendencias; caching abarata el contexto fijo repetido. |
| **3. Alertas/anomalías** | Haiku 4.5 / Sonnet 4.6 | Detección numérica en SQL/JS + Claude solo para redactar el mensaje accionable | Barato; corre en batch nocturno. La detección dura la hace la DB, no el LLM. |
| **4. Copiloto NLP** | Sonnet 4.6 | **Tool use** (herramientas tipadas: `get_metrics`, `compare_periods`…), NO SQL crudo | Seguridad multi-tenant: el LLM llama funciones que ya respetan RLS/org_id, nunca genera SQL libre. |

- **SDK:** `@anthropic-ai/sdk` con `messages.parse({ output_config: { format: zodOutputFormat(schema) } })`.
- **Batch nocturno multi-tenant:** Message Batches API para análisis/alertas de todos los tenants de una → ~50% de ahorro.
- **Model routing** explícito (Haiku→barato, Sonnet→default, Opus→coach) configurable por env para controlar costos.

### Time-series / roll-ups (diario→anual)

**Este NO es un problema de time-series de alto volumen — no reaches por TimescaleDB.**

| Pieza | Recomendación | Por qué |
|-------|---------------|---------|
| Tabla base | `daily_metrics` (una fila por member × día × métrica/línea de oferta) | Grano diario = unidad natural del tracker; semanal/mensual/trimestral/anual se agregan sobre esto. **HIGH** |
| Rollups | Tablas de resumen (`weekly/monthly/... _rollups`) recalculadas por **`pg_cron`** al cierre del día del tenant | Consulta de dashboard instantánea sin recomputar. Refresh incremental por tenant. **MEDIUM-HIGH** |
| Ad-hoc | `date_trunc()` + `GROUP BY` para vistas no precomputadas | El volumen (decenas de filas/día) hace que SQL plano sea de sobra. **HIGH** |
| **Timezone** | `date-fns-tz`, buckets calculados en **America/Argentina/Buenos_Aires (UTC-3)**, no en UTC | Un "día"/"semana" mal bucketeado rompe todo el tracking. Riesgo real dado el TZ del negocio. **HIGH** |

### Background jobs / scheduling

| Pieza | Recomendación primaria | Alternativa |
|-------|------------------------|-------------|
| Scheduler | **Supabase Cron (`pg_cron`)** para disparar sync/rollups por tenant | Vercel Cron si el app corriera en Vercel |
| Cola | **Supabase Queues (`pgmq`)** — durable, exactly-once, transaccional con los datos | Inngest si se prefiere step-functions gestionadas |
| Worker | **Proceso Node largo en Docker (VPS)** que drena la cola: GHL sync + rollups + análisis IA | Edge Functions (ojo: timeout 150s → mal para IA/GHL largos) |
| Orquestación IA compleja | **Inngest** si los flujos multi-paso (fan-out por tenant, retries, observabilidad) se vuelven pesados | Worker propio si se quiere cero vendors nuevos |
| Entrega de alertas | **n8n → Slack / GHL workflows** (webhook desde el app) | — (regla Maze: nunca mensajería propia) |

**Rationale:** al principio, `pg_cron` + `pgmq` + un worker en el VPS mantiene todo dentro de Postgres+Docker (cero infra nueva, coherente con el patrón "apps nativas en VPS"). Migrá a Inngest solo cuando la orquestación IA (fan-out, retries, steps largos) justifique una plataforma gestionada. Las alertas salen por n8n porque ya es el puente de automatización de Maze y respeta la regla de comunicación.

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@supabase/ssr` | latest | Sesiones Supabase en App Router (server components/actions) | Siempre |
| `zod` | ^4 | Validación + schemas para structured outputs de Claude | Siempre (forms, API, IA) |
| `@tanstack/react-query` | ^5 | Cache/estado de datos en cliente | Dashboards interactivos |
| **Tremor** | ^3 (latest) | Componentes React de dashboard/KPIs (charts, cards, deltas) | Vistas de métricas/goal-vs-actual |
| `recharts` | ^2 | Charts custom si Tremor se queda corto | Gráficos a medida |
| `date-fns` + `date-fns-tz` | ^4 | Buckets de fecha con timezone Buenos Aires | Rollups, pacing, comparativas de período |
| `shadcn/ui` + Radix | latest | Primitivas de UI accesibles (tablas, dialogs, tooltips) | UI general + tooltips del diccionario embebido |
| **Tailwind CSS** | v4 | Estilos | Siempre |
| `drizzle-kit` | latest | Migraciones | Dev/CI |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Drizzle Kit | Migraciones versionadas | Con Supabase usar connection en **Session Mode**; `prepare: false` si se usa transaction pooler |
| Supabase CLI | Migraciones locales, edge functions, tipos | Mantener schema en repo, no editar en UI |
| Docker Compose | Deploy del app en VPS | Igual patrón que maze-growth / maze-scheduler |
| GitHub (ramas→PR) | Workflow profesional | Hábito ya en adopción por Alejandro |

## Installation

```bash
# Core
npm install next@16 react react-dom @supabase/supabase-js @supabase/ssr \
  drizzle-orm @anthropic-ai/sdk zod

# Supporting
npm install @tanstack/react-query @tremor/react recharts date-fns date-fns-tz

# Background / colas (worker)
npm install pg  # driver para el worker que consume pgmq
# (Supabase Queues/pgmq + pg_cron se habilitan como extensiones, no npm)

# Dev
npm install -D drizzle-kit typescript tailwindcss@4 @types/node @types/pg
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Next.js 16 | Remix / TanStack Start | Si se priorizara edge-first puro; pero rompe coherencia Maze |
| Supabase | Neon + Clerk + custom auth | Si se necesitara separar auth de DB; pierde RLS integrado y coherencia |
| Drizzle | Prisma 7 | Si el equipo prefiere migraciones automáticas y DX declarativa sobre bundle/edge |
| pg_cron + pgmq + worker | Inngest / Trigger.dev | Cuando la orquestación IA multi-paso (fan-out, retries, runs >150s, observabilidad) pese más que evitar un vendor |
| Tablas de rollup (pg_cron) | TimescaleDB continuous aggregates | Solo si el volumen escalara a millones de eventos/día (no es el caso, y Supabase ya no la ofrece) |
| Tremor | Recharts / Nivo / visx | Dashboards muy custom; Tremor cubre 90% de KPIs out-of-the-box |
| n8n para alertas | Resend/mailer propio | Nunca — regla Maze prohíbe mensajería propia |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **GHL API keys V1 / "location API key"** | Fuera de soporte desde 31-dic-2025; no sirve para multi-tenant | **OAuth 2.0 Marketplace App** (Location + Company scope) |
| **TimescaleDB** | Volumen no lo justifica; Supabase no la ofrece; complejidad extra | Tablas de rollup refrescadas por `pg_cron` |
| **Parseo manual de JSON del LLM** | Frágil, propenso a errores | `messages.parse` + `zodOutputFormat` (structured outputs nativos) |
| **SQL generado por el LLM (text-to-SQL crudo)** en el copiloto NLP | Riesgo de fuga entre tenants + inyección | **Tool use** con funciones tipadas que respetan RLS/org_id |
| **Edge Functions para GHL sync / análisis IA** | Timeout 150s → cortan jobs largos | Worker Node largo en Docker (VPS) |
| **Filtrado de tenant solo en la app** | Un bug filtra datos entre agencias | **RLS** como piso + claim `org_id` en JWT |
| `middleware.ts` estilo Next 15 | Deprecado en Next 16 (→ `proxy.ts`) | `proxy.ts` según guía de upgrade |
| ClickUp / herramientas de PM externas | Regla Maze | GHL / Airtable / n8n según corresponda |

## Stack Patterns by Variant

**Si el app se hostea en el VPS (recomendado, patrón Maze "apps nativas en VPS"):**
- Next.js en Docker Compose + Supabase Cloud (DB/Auth) + worker Node en el mismo compose que drena `pgmq`.
- Alertas: el worker/app emite webhook → n8n → Slack/GHL.
- Cloudflare delante (SSL 1 nivel: usar guion, `maze-tracker.mazefunnels.io`, no subdominios anidados).

**Si más adelante se prefiere serverless:**
- Next.js en Vercel + Vercel Cron + Inngest para background/IA.
- Perder el worker largo; toda tarea >maxDuration va a Inngest steps.

**Si un tenant NO conecta GHL:**
- Solo carga manual; sync deshabilitado; IA sigue funcionando sobre datos manuales.
- El origen de cada métrica (`manual`/`ghl`) queda registrado para reconciliación futura.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Next.js 16.2.x | React 19 | React Compiler estable; `middleware.ts`→`proxy.ts` |
| Drizzle ORM | Supabase Postgres | Session Mode; `prepare: false` con transaction pooler |
| `@anthropic-ai/sdk` (latest) | claude-opus-4-8 / claude-sonnet-4-6 / claude-haiku-4-5 | `messages.parse` requiere versión con structured outputs GA |
| Supabase Queues (pgmq) | pg_cron + pg_net | Extensiones habilitables en Supabase Cloud |
| Zod v4 | `@anthropic-ai/sdk` helpers | `zodOutputFormat` espera Zod compatible; fijar misma major |

## Sources

- `/vercel/next.js` (Context7) — versiones; Next 16.2.x actual — HIGH
- nextjs.org/docs/app/guides/upgrading/version-16 — Turbopack default, React Compiler, `proxy.ts` — HIGH
- `/anthropics/anthropic-sdk-typescript` (Context7) — `messages.parse`, `zodOutputFormat`, tool use — HIGH
- platform.claude.com/docs/en/about-claude/models/overview — model IDs (opus-4-8, sonnet-4-6, haiku-4-5) — HIGH
- marketplace.gohighlevel.com/docs/Authorization/OAuth2.0 — OAuth obligatorio, Location/Company scope — HIGH
- help.gohighlevel.com … V1 API end-of-support 31-dic-2025; 200k req/día por app/resource — MEDIUM
- supabase.com/docs/guides/queues + /guides/functions/schedule-functions — pgmq, pg_cron, timeout 150s — HIGH
- supabase.com/docs/guides/database/drizzle — Drizzle+Supabase, Session Mode, `prepare:false` — HIGH
- bytebase.com / makerkit.dev — Drizzle vs Prisma 2026, bundle size, RLS nativo Drizzle — MEDIUM
- tigerdata.com / hackernoon — materialized views vs continuous aggregates (contexto para descartar Timescale) — MEDIUM
- buildmvpfast.com / hashbuilds.com — Inngest vs Trigger.dev vs Vercel Cron 2026 — MEDIUM

---
*Stack research for: SaaS multi-tenant de sales-performance tracking con GHL + Claude*
*Researched: 2026-06-30*
