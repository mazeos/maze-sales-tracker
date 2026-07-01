# Architecture Research

**Domain:** SaaS multi-tenant de tracking de performance de ventas (setter → triage → closer) con ingesta dual (manual + GoHighLevel) y capa de IA (auto-mapeo, analista, alertas, NLP). Stack Next.js + Supabase + Claude.
**Researched:** 2026-06-30
**Confidence:** HIGH (multi-tenancy RLS, ingesta GHL, notificaciones) / MEDIUM (orquestación de IA — patrón sólido pero dependiente de refinamiento en implementación)

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLIENT (Next.js App Router)                    │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────┐  │
│  │ Dashboard  │ │ Carga      │ │ Metas /    │ │ Copiloto NL        │  │
│  │ (roll-ups) │ │ manual     │ │ pacing UI  │ │ (chat sobre datos) │  │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────────┬──────────┘  │
└────────┼──────────────┼──────────────┼──────────────────┼─────────────┘
         │  (RSC / Server Actions / Route Handlers, sesión = JWT tenant) │
┌────────┼──────────────┼──────────────┼──────────────────┼─────────────┐
│        ▼              ▼              ▼                  ▼               │
│                      APPLICATION / DOMAIN LAYER                        │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────┐  │
│  │ Ingesta       │ │ Motor de      │ │ Metas &       │ │ AI        │  │
│  │ (manual +     │ │ métricas /    │ │ pacing        │ │ Orchestr. │  │
│  │  GHL adapter) │ │ roll-ups      │ │ engine        │ │ (Claude)  │  │
│  └──────┬────────┘ └──────┬────────┘ └──────┬────────┘ └─────┬─────┘  │
│         │  escribe facts   │ lee facts       │ lee roll-ups   │ tools  │
│         ▼                  ▼                 ▼                ▼         │
├───────────────────────────────────────────────────────────────────────┤
│                     DATA LAYER — Supabase Postgres (RLS por tenant)    │
│  ┌──────────┐ ┌───────────┐ ┌─────────────┐ ┌──────────┐ ┌─────────┐  │
│  │ orgs /   │ │ metric_   │ │ daily_      │ │ goals /  │ │ ghl_    │  │
│  │ members/ │ │ facts     │ │ metrics     │ │ pacing   │ │ events  │  │
│  │ roles    │ │ (source)  │ │ (roll-up)   │ │          │ │ (dedupe)│  │
│  └──────────┘ └───────────┘ └─────────────┘ └──────────┘ └─────────┘  │
├───────────────────────────────────────────────────────────────────────┤
│         BACKGROUND (pg_cron + Edge Functions / cola)                   │
│  ┌────────────────┐ ┌────────────────┐ ┌──────────────────────────┐   │
│  │ GHL webhook    │ │ Roll-up /      │ │ Scan de pacing +         │   │
│  │ receiver +     │ │ reconciliación │ │ anomalías (scheduled)    │   │
│  │ polling backup │ │ (scheduled)    │ │  → dispara notificación  │   │
│  └───────┬────────┘ └────────────────┘ └────────────┬─────────────┘   │
└──────────┼──────────────────────────────────────────┼─────────────────┘
           │ (webhooks in / REST out)                  │ (outbound)
     ┌─────▼───────┐                          ┌────────▼───────────┐
     │ GoHighLevel │                          │ Notif. Dispatcher  │
     │ (OAuth app) │                          │  → GHL workflow    │
     └─────────────┘                          │  → Slack           │
                                              └────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| **Auth / Tenancy** | Identidad, membresía org/team, rol (owner/setter/triage/closer), inyección de `org_id` + rol en el JWT | Supabase Auth + Custom Access Token Auth Hook + RLS |
| **Ingesta manual** | UI de carga diaria por miembro → escribe `metric_facts` con `source='manual'` | Server Actions + validación Zod |
| **GHL adapter** | Recibe webhooks / hace polling backup, normaliza a facts canónicos con `source='ghl'`, dedupe/idempotencia | Edge Function (webhook), pg_cron (polling) |
| **Motor de métricas / roll-ups** | Deriva `daily_metrics` por miembro/rol/línea de oferta desde `metric_facts`; expone tasas del embudo | Funciones SQL + jobs incrementales |
| **Metas & pacing** | Objetivos por rol/persona/período; calcula goal-vs-actual y ritmo (adelantado/atrasado) | Tabla `goals` + funciones de pacing sobre roll-ups |
| **AI Orchestrator** | Enruta las 4 capacidades de IA; construye contexto tenant-scoped; aplica guardrails | Claude API + tool-calling sobre un data-access API acotado |
| **Anomaly/alert scanner** | Job programado que detecta desvíos (burnout, caída de cierre, no-shows) y dispara notificaciones | pg_cron + Edge Function |
| **Notification dispatcher** | Único punto de salida de mensajería: emite a GHL workflow (inbound webhook) o Slack | Edge Function; NUNCA mensajería propia |

## Recommended Project Structure

```
src/
├── app/                          # Next.js App Router
│   ├── (dashboard)/              # UI autenticada (roll-ups, pacing)
│   ├── (manual-entry)/           # Carga diaria por miembro
│   ├── copilot/                  # UI del copiloto NL
│   └── api/
│       ├── webhooks/ghl/         # Route Handler receptor de webhooks GHL
│       └── ai/                   # Endpoints de IA request-time
├── lib/
│   ├── tenancy/                  # Helpers de org/rol, guards de sesión
│   ├── supabase/                 # Clients (server, service-role, browser)
│   └── ghl/                      # SDK/cliente REST + verificación de firma
├── domain/                       # Lógica de negocio pura (sin I/O)
│   ├── metrics/                  # Definición del embudo, cálculo de tasas
│   ├── ingestion/                # Normalización manual + mapeo GHL→facts
│   ├── rollups/                  # Agregaciones daily/weekly/monthly
│   ├── goals/                    # Pacing engine
│   └── anomalies/                # Reglas de detección
├── ai/
│   ├── orchestrator.ts           # Router de las 4 capacidades
│   ├── tools/                    # Tool definitions (query acotado por tenant)
│   ├── prompts/                  # System prompts + guardrails
│   └── context.ts                # Builder de contexto tenant-scoped
├── jobs/                         # Funciones invocadas por pg_cron/Edge
│   ├── ghl-poll.ts               # Backup de webhooks
│   ├── rollup-recompute.ts       # Reconciliación + roll-up incremental
│   └── anomaly-scan.ts           # Scan + trigger de alertas
└── notifications/
    └── dispatcher.ts             # Salida única → GHL workflow / Slack
supabase/
├── migrations/                   # Esquema + políticas RLS versionadas
└── functions/                    # Edge Functions (webhooks, jobs, AI async)
```

### Structure Rationale

- **`domain/` sin I/O:** la lógica del embudo, roll-ups y pacing es el corazón del producto y debe ser testeable sin base de datos ni red. Facilita paridad exacta con la planilla original.
- **`ingestion/` unifica manual + GHL:** ambos caminos convergen en el mismo modelo de `metric_facts`; separar el mapeo GHL de la normalización manual permite que el sistema funcione sin GHL (Core Value).
- **`ai/tools/` como frontera dura:** el modelo nunca toca SQL crudo ni la DB directo; solo llama funciones acotadas que ya respetan el `org_id`. Es el guardrail principal de aislamiento.
- **`notifications/dispatcher.ts` como cuello único:** garantiza la regla Maze "nunca mensajería propia" — todo egreso pasa por GHL/Slack.

## Architectural Patterns

### Pattern 1: Tenancy por columna `org_id` + RLS con claim en JWT

**What:** Cada tabla lleva `org_id`. En login, un Custom Access Token Auth Hook inyecta `org_id` y `role` en el JWT. Las políticas RLS comparan la columna contra el claim. Aislamiento a nivel base de datos, no de aplicación.
**When to use:** Multi-tenant compartido (una DB, muchos tenants) — correcto para decenas/cientos de agencias con equipos chicos.
**Trade-offs:** (+) Aislamiento por defecto, imposible olvidar el `WHERE org_id`. (−) Requiere índice en `org_id` en toda tabla y disciplina en `WITH CHECK` para inserts. Los jobs con service-role saltan RLS → deben filtrar por `org_id` manualmente.

**Example:**
```sql
-- Índice obligatorio para performance
create index on metric_facts (org_id, member_id, activity_date);

alter table metric_facts enable row level security;

create policy tenant_isolation on metric_facts
  using ( org_id = (select auth.jwt() ->> 'org_id')::uuid )
  with check ( org_id = (select auth.jwt() ->> 'org_id')::uuid );
-- envolver auth.jwt() en subquery (select ...) → 100x en tablas grandes
```

### Pattern 2: Modelo canónico de `metric_facts` con discriminador `source`

**What:** Manual y GHL escriben al MISMO grano de hecho (member, fecha, tipo de actividad, línea de oferta, valor) con `source ∈ {manual, ghl, reconciled}` y un `dedupe_key`. Los roll-ups agregan sobre esta única tabla.
**When to use:** Siempre que haya ingesta dual que deba coexistir y reconciliarse.
**Trade-offs:** (+) Un solo pipeline de agregación; la reconciliación manual-vs-GHL es una consulta comparativa, no dos sistemas paralelos. (+) Auditable (se ve el origen de cada número). (−) Requiere política de precedencia clara cuando ambas fuentes reportan el mismo hecho.

**Example:**
```typescript
// dedupe_key idempotente por evento GHL
// p.ej. `ghl:appointment:${appointmentId}:booked`
// El upsert por dedupe_key hace la ingesta idempotente ante reintentos.
await supabase.from('metric_facts').upsert(fact, { onConflict: 'dedupe_key' });
```

### Pattern 3: Roll-ups híbridos — daily materializado, períodos altos on-read

**What:** `daily_metrics` (por miembro/rol/oferta) es la única agregación pre-calculada, recomputada incrementalmente al cambiar facts del día. Semanal/mensual/trimestral/anual se computan sumando dailies en lectura (cacheados).
**When to use:** Volúmenes de agencia (decenas de miembros, cientos de facts/día). No hace falta materializar cada período.
**Trade-offs:** (+) Simplicidad; una sola tabla derivada que invalidar. (+) Recalcular un día es barato. (−) Consultas anuales suman ~365 filas/miembro — trivial a esta escala; revisar solo si un tenant crece a miles de miembros.

**Example:**
```
metric_facts (grano evento) → daily_metrics (materializado, source of truth de roll-up)
                                   ↓ (SUM on read, cached)
                          weekly / monthly / quarterly / yearly
```

### Pattern 4: IA como tool-caller sobre un data-access acotado (no SQL libre)

**What:** El copiloto NL y el analista no reciben la DB; reciben herramientas tipadas (`get_member_metrics`, `compare_periods`, `get_funnel_rates`) que ya filtran por `org_id`. El modelo elige qué llamar; el sistema ejecuta con RLS del tenant.
**When to use:** Toda capacidad de IA que consulte datos del tenant.
**Trade-offs:** (+) Imposible fuga cross-tenant o SQL malicioso; respuestas ancladas a datos reales (menos alucinación). (−) Hay que diseñar el catálogo de tools por adelantado; consultas fuera del catálogo no son posibles (aceptable en v1).

## Data Flow

### Ingesta dual → métrica (direccional)

```
[Carga manual del miembro]                 [Actividad en GHL]
        │                                          │ (InboundMessage, OutboundMessage,
        ▼                                          │  AppointmentCreate/Update,
 Server Action (valida, org_id de sesión)          │  OpportunityStatusUpdate)
        │                                          ▼
        │                              Edge Function receptor de webhook
        │                              (verifica firma Ed25519 X-GHL-Signature,
        │                               responde 2xx rápido, encola)
        │                                          │
        │                              GHL adapter: mapea evento → fact(s)
        │                              + dedupe_key + source='ghl'
        ▼                                          ▼
        └──────────────►  metric_facts  ◄──────────┘   (upsert idempotente)
                              │
                              ▼
                    daily_metrics (roll-up incremental)
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        Dashboard        Pacing engine    Anomaly scanner
        (roll-ups)       (goal-vs-actual) (scheduled)
                                                │ desvío detectado
                                                ▼
                                    AI Orchestrator (explica/prioriza)
                                                ▼
                                    Notification dispatcher
                                        → GHL workflow / Slack
```

### Flujo request-time de IA (copiloto NL)

```
[Usuario pregunta en lenguaje natural]
        ↓
Route Handler /api/ai (sesión → org_id)
        ↓
AI Orchestrator → Claude (con catálogo de tools tenant-scoped)
        ↓ tool_use: get_member_metrics(member, period)
Data-access API (ejecuta con RLS del tenant)
        ↓ resultado
Claude sintetiza respuesta anclada a datos
        ↓
[Respuesta al usuario]
```

### Key Data Flows

1. **Reconciliación manual-vs-GHL:** job programado compara facts `manual` vs `ghl` del mismo grano; cuando GHL confirma un hecho cargado manualmente, produce un fact `reconciled` (precedencia configurable) y marca discrepancias para revisión en UI. GHL nunca sobreescribe silenciosamente lo manual.
2. **Idempotencia de webhooks:** `ghl_events` guarda `event_id` procesados; el upsert por `dedupe_key` absorbe los reintentos de GHL (hasta 12 con backoff exponencial). Retornar 2xx SIEMPRE para no disparar el circuit breaker (<90% éxito sobre 10k pausa el endpoint).
3. **Polling como red de seguridad:** pg_cron cada N minutos consulta la REST de GHL por deltas (por si un webhook se perdió), usando el mismo `dedupe_key` → sin duplicados. Los webhooks son el camino primario; el polling es reconciliación de brechas.
4. **Pacing:** job diario (o on-read) proyecta ritmo = actual acumulado / esperado-a-la-fecha del período contra `goals`; alimenta la vista "voy adelantado/atrasado" y el scanner de anomalías.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0-1k usuarios (docenas de agencias) | Monolito Next.js + Supabase alcanza. Roll-up daily materializado + períodos on-read. Webhooks + polling backup. |
| 1k-100k usuarios | Mover jobs pesados a cola (Supabase Queues / Edge Functions dedicadas). Cachear roll-ups de períodos altos. Rate-limit y batch de llamadas Claude; presupuesto por tenant. |
| 100k+ usuarios | Particionar `metric_facts` por `org_id`/tiempo; materializar períodos altos; posible read-replica para dashboards. Aislar el pipeline de IA en su propio servicio. |

### Scaling Priorities

1. **Primer cuello — llamadas a Claude (costo/latencia):** batch de digests del analista, cache de respuestas del copiloto por tenant/período, usar Sonnet para tareas frecuentes y reservar Opus para análisis profundo. Presupuesto y rate-limit por tenant desde v1.
2. **Segundo cuello — recomputo de roll-ups en ingestas ráfaga (webhooks GHL):** recomputo incremental por (miembro, día) afectado, no full-table; debounce de eventos del mismo día antes de recalcular.

## Anti-Patterns

### Anti-Pattern 1: Filtrar por tenant en la aplicación en vez de RLS

**What people do:** Confiar en `WHERE org_id = ?` en cada query del código.
**Why it's wrong:** Un solo query olvidado = fuga cross-tenant. Los jobs con service-role son especialmente peligrosos.
**Do this instead:** RLS por defecto en toda tabla + índice en `org_id`. En jobs service-role, filtrar explícito por `org_id` y encapsular en un data-access que nunca acepta queries sin tenant.

### Anti-Pattern 2: Dar a la IA acceso directo a la DB o SQL generado

**What people do:** Text-to-SQL libre sobre la base del tenant.
**Why it's wrong:** Riesgo de fuga cross-tenant, inyección, alucinación de tablas/columnas, y respuestas no auditables.
**Do this instead:** Tool-calling sobre un catálogo acotado que ya respeta RLS. El modelo elige la herramienta; el sistema ejecuta con la sesión del tenant.

### Anti-Pattern 3: Materializar todos los períodos de roll-up desde el día 1

**What people do:** Tablas separadas materializadas para weekly/monthly/quarterly/yearly con triggers en cadena.
**Why it's wrong:** Complejidad de invalidación exponencial; bugs de doble conteo; premature optimization a escala de agencia.
**Do this instead:** Un solo `daily_metrics` materializado; períodos altos on-read cacheados. Materializar más solo cuando un tenant lo justifique.

### Anti-Pattern 4: Tratar el webhook GHL como fuente única de verdad

**What people do:** Asumir entrega exactly-once y sobreescribir lo manual con lo de GHL.
**Why it's wrong:** Los webhooks se pierden/reintentan (at-least-once); GHL puede reportar distinto a lo que el humano contó → destruye confianza en los números (el Core Value).
**Do this instead:** `dedupe_key` idempotente + polling backup + capa de reconciliación que preserva ambas fuentes y marca discrepancias en vez de pisar.

### Anti-Pattern 5: Mensajería saliente propia

**What people do:** Enviar emails/WhatsApp de alertas directo desde la app.
**Why it's wrong:** Viola la regla Maze; fragmenta la comunicación fuera de GHL.
**Do this instead:** Dispatcher único que emite a un GHL workflow (inbound webhook trigger) o a Slack. La app decide QUÉ notificar; GHL/Slack entregan.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| **GoHighLevel** | OAuth por tenant (cada agencia conecta su cuenta). Webhooks del OAuth app (InboundMessage, OutboundMessage, AppointmentCreate/Update, OpportunityCreate/StatusUpdate, ContactCreate/Update) + REST v2 para polling/backfill | Firma Ed25519 `X-GHL-Signature` (legacy RSA `X-WH-Signature` deprecado 2026-07-01). Hasta 12 reintentos con backoff. Circuit breaker <90% éxito/10k → responder 2xx SIEMPRE y rápido. Scopes se congelan al ir live |
| **Anthropic Claude** | API server-side. Sonnet para tareas frecuentes (copiloto, mapeo), Opus para análisis profundo. Tool-calling para acceso a datos | Presupuesto/rate-limit por tenant. Nunca exponer key al cliente. Structured outputs para digests |
| **Slack** | Vía dispatcher, para alertas internas del equipo | Reutiliza el bot Maze existente; nunca canal primario de cliente |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Ingesta ↔ Motor de métricas | Escritura a `metric_facts` (desacoplado); roll-up recomputa async | Ingesta no calcula tasas; solo persiste hechos |
| Motor de métricas ↔ IA | IA lee vía tools sobre roll-ups, nunca escribe facts | IA es read-only sobre datos del tenant |
| Anomaly scanner ↔ Notification dispatcher | Evento de alerta → dispatcher (una dirección) | Scanner no conoce el canal; el dispatcher decide GHL vs Slack |
| Jobs (service-role) ↔ Data layer | Saltan RLS → filtran `org_id` explícito | Frontera de mayor riesgo; encapsular en data-access tenant-aware |

## Build Order (dependencias)

Orden sugerido por dependencias, alineado con el Core Value ("funciona con o sin GHL"):

1. **Fundaciones de tenancy** — orgs/teams/members/roles, Supabase Auth, Custom Access Token Hook (claim `org_id`+`role`), RLS + índices. *(Todo depende de esto.)*
2. **Modelo canónico de métricas + ingesta manual + roll-up daily + dashboard** — el producto ya entrega valor SIN GHL. Paridad con la planilla + roll-up automático de setters (mejora #3). *(Depende de 1.)*
3. **Metas & pacing** — goal-vs-actual y ritmo (mejora #1). *(Depende de 2: necesita roll-ups.)*
4. **Integración GHL** — OAuth por tenant, receptor de webhooks (firma+idempotencia), GHL adapter (mapeo→facts), polling backup, reconciliación manual-vs-GHL (mejora #2). *(Depende de 2: escribe al mismo `metric_facts`.)*
5. **Capa de IA — orquestador + tools tenant-scoped**, empezando por copiloto NL y analista/coach (leen roll-ups existentes). El auto-mapeo IA asiste la config de la integración del paso 4. *(Depende de 2/4: necesita datos y catálogo de métricas.)*
6. **Anomalías/alertas + notification dispatcher** — scanner programado sobre pacing/roll-ups → IA prioriza → dispatcher a GHL/Slack. *(Depende de 3, 5 y del dispatcher.)*

**Nota de dependencia crítica:** el paso 2 define `metric_facts` — es el contrato que consumen ingesta GHL (4), IA (5) y alertas (6). Estabilizar ese esquema antes de construir hacia arriba evita retrabajo en cascada.

## Sources

- [HighLevel Webhook Integration Guide](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/index.html) — eventos nativos, firma Ed25519 (`X-GHL-Signature`), 12 reintentos con backoff, circuit breaker, requisito 2xx, binding a OAuth app — HIGH
- [HighLevel Webhook Category Docs](https://marketplace.gohighlevel.com/docs/category/webhook/index.html) — catálogo de eventos (Contact/Opportunity/Appointment/Conversation) — HIGH
- [Supabase — RLS Performance & Best Practices](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) — índice en tenant col, subquery-wrap de `auth.jwt()`/`auth.uid()`, patrón de membership — HIGH
- [Supabase — Custom Claims & RBAC](https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac) — Custom Access Token Auth Hook para inyectar `org_id`/`role` — HIGH
- [MakerKit — Supabase RLS Best Practices for Multi-Tenant](https://makerkit.dev/blog/tutorials/supabase-rls-best-practices) — patrón org_id + WITH CHECK — MEDIUM
- Contexto interno Maze: GHL location `siM5ZYQ90OgKoshnqLeC`, MCP GHL propio, Slack bot, regla "nunca mensajería propia", stack Next.js+Supabase (maze-growth, maze-scheduler) — HIGH (contexto de proyecto)

---
*Architecture research for: SaaS multi-tenant de sales tracking con ingesta dual GHL + IA Claude*
*Researched: 2026-06-30*
