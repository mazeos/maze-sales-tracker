# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-30)

**Core value:** Convertir la actividad diaria de un equipo de ventas en métricas confiables y decisiones accionables — funcionando con o sin GHL conectado.
**Current focus:** Phase 1 — Fundaciones multi-tenant y diccionario

## Current Position

Phase: 1 of 5 (Fundaciones multi-tenant y diccionario)
Plan: 0 of TBD in current phase
Status: Ready to plan
Last activity: 2026-07-04 - Completed quick task 260704-r0e: Fase 2 carcasa GHL — Usuarios desde HighLevel

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: —
- Trend: —

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Phase 1]: Multi-tenancy con RLS a nivel DB desde el día 1 — retrofittearlo es un rewrite; test de aislamiento cross-tenant en CI
- [Phase 1]: Modelo canónico `metric_facts` (source + dedupe_key) como contrato del que dependen roll-ups, IA y futura auto-carga GHL
- [Phase 2]: Cargar conteos atómicos y derivar tasas en backend (nunca cargar %) — causa raíz de la varianza 12%↔91% de la planilla
- [Phase 5]: La IA nunca calcula cifras: solo redacta sobre agregados pre-computados (tool use tipado, no SQL crudo)

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

- REQUIREMENTS.md declaraba "31 requisitos v1" pero hay 33 IDs reales; el roadmap mapea los 33. Traceability actualizada en consecuencia.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260702-nhd | Gating admin-only en UI de Configuraciones y Metas | 2026-07-02 | e94bf33 | [260702-nhd-gating-admin-only-en-ui-de-configuracion](./quick/260702-nhd-gating-admin-only-en-ui-de-configuracion/) |
| 260702-onz | Mini-API de provisioning de miembros (alta/baja server-side) | 2026-07-02 | 147f6de | [260702-onz-mini-api-de-provisioning-de-miembros-alt](./quick/260702-onz-mini-api-de-provisioning-de-miembros-alt/) |
| 260704-p9c | Integración GHL Fase 1 — Conexión OAuth de subcuenta desde Configuraciones | 2026-07-04 | 06ff588 | [260704-p9c-integraci-n-ghl-fase-1-conexi-n-oauth-de](./quick/260704-p9c-integraci-n-ghl-fase-1-conexi-n-oauth-de/) |
| 260704-r0e | Fase 2 carcasa GHL — Usuarios desde HighLevel (import + código de acceso + sync) | 2026-07-04 | (merge) | [260704-r0e-fase-2-carcasa-ghl-usuarios-desde-highle](./quick/260704-r0e-fase-2-carcasa-ghl-usuarios-desde-highle/) |

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| v2 | Integración GoHighLevel (GHL-01..05) | Deferred | Roadmap init |
| v2 | IA avanzada: alertas/anomalías + copiloto NL (AI2-01..03) | Deferred | Roadmap init |
| v2 | Billing/suscripción del SaaS (BIZ-01) | Deferred | Roadmap init |

## Session Continuity

Last session: 2026-06-30
Stopped at: ROADMAP.md y STATE.md creados, traceability de REQUIREMENTS.md actualizada
Resume file: None
