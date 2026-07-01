# Roadmap: Maze Sales Tracker IA

## Overview

El viaje va del cimiento al diferenciador, respetando una cadena de dependencias no negociable: primero el aislamiento multi-tenant (RLS) y el diccionario de datos que fijan las reglas del juego; después el núcleo de tracking manual que entrega el Core Value completo **sin GHL** (el dueño ve su embudo real); luego el dashboard agregado que lo hace legible de un golpe de vista; después metas y pacing (el diferenciador #1 no-IA); y al final la IA coach, que solo redacta sobre agregados ya pre-computados. El dato confiable va siempre antes que la IA. La integración GHL y las otras 3 IAs quedan diferidas a v2.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Fundaciones multi-tenant y diccionario** - Cuentas de agencia aisladas, roles y definiciones embebidas sobre el modelo canónico de datos
- [ ] **Phase 2: Núcleo de tracking manual** - Captura mobile-first del embudo completo, log de ventas y tasas derivadas para los 3 roles
- [ ] **Phase 3: Roll-ups y dashboard** - Agregados temporales por rol y vista de resumen legible del equipo
- [ ] **Phase 4: Metas y pacing** - Objetivos por rol/persona y vista goal-vs-actual con ritmo del período
- [ ] **Phase 5: IA Coach / Analista** - Interpretación en lenguaje natural del embudo con recomendaciones accionables, sin inventar cifras

## Phase Details

### Phase 1: Fundaciones multi-tenant y diccionario
**Goal**: El dueño de una agencia puede crear su espacio aislado, armar su equipo con roles, y todo el sistema arranca sobre un modelo de datos y definiciones únicas
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: TEN-01, TEN-02, TEN-03, TEN-04, TEN-05, MET-05, DICT-01, DICT-02
**Success Criteria** (what must be TRUE):
  1. El dueño puede registrarse, crear su agencia y quedar como owner
  2. El owner puede invitar miembros y asignarles rol (setter / triage / closer) según la configuración de su equipo (solo-setter / setter+closer / setter+triage+closer)
  3. Un usuario logueado en una agencia no puede ver ni acceder a datos de otra agencia (aislamiento verificado)
  4. La sesión persiste entre refrescos del navegador y cada miembro ve la vista propia de su rol
  5. Cada métrica del sistema tiene su definición accesible desde una sola fuente consistente
**Plans**: TBD
**UI hint**: yes

### Phase 2: Núcleo de tracking manual
**Goal**: Cada miembro registra su actividad diaria como un contador en vivo y el sistema deriva el embudo completo con sus tasas — el producto entrega el Core Value sin GHL
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: CAP-01, CAP-02, CAP-03, CAP-04, CAP-05, CAP-06, MET-01, MET-02, MET-03, MET-04, SAL-01, SAL-02, SAL-03
**Success Criteria** (what must be TRUE):
  1. Un setter, un triage y un closer pueden registrar sus conteos del día desde el móvil con baja fricción, cargando solo conteos atómicos (nunca porcentajes) y pudiendo corregir un día pasado
  2. El sistema deriva automáticamente todas las tasas del embudo (link→agenda, agenda→asistencia, pases a closer, asistencia→cierre, % de ocupación del closer, etc.) a partir de esos conteos
  3. Un closer puede registrar una venta con atribución completa (closer, triage, setter, fuente del lead), distinguiendo cash collected (nuevo/cuotas/reservas) de revenue facturado
  4. Las métricas de cierre y las ventas se agregan por línea de oferta (Membresía / Lite / High-Ticket)
**Plans**: TBD
**UI hint**: yes

### Phase 3: Roll-ups y dashboard
**Goal**: El owner ve el estado real del equipo de un golpe de vista, con agregados temporales correctos para todos los roles
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04, DASH-05
**Success Criteria** (what must be TRUE):
  1. El sistema genera roll-ups diario / semanal / mensual / trimestral / anual automáticamente para todos los roles, incluido el setter
  2. Los roll-ups respetan la zona horaria de la agencia (no UTC), sin corrimientos de fecha
  3. El owner ve un dashboard de resumen legible del equipo de un solo golpe de vista y puede abrir la performance de cada miembro individual
  4. El usuario puede comparar períodos (esta semana vs la anterior, este mes vs el anterior)
**Plans**: TBD
**UI hint**: yes

### Phase 4: Metas y pacing
**Goal**: El owner fija objetivos y el dashboard muestra cuánto falta y si el equipo va adelantado o atrasado según el ritmo del período
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: GOAL-01, GOAL-02, GOAL-03
**Success Criteria** (what must be TRUE):
  1. El owner puede fijar metas por rol / persona / período
  2. El dashboard muestra goal-vs-actual (cuánto falta para la meta) por persona y equipo
  3. El sistema muestra pacing consciente del ritmo del período: si va adelantado o atrasado según lo transcurrido
**Plans**: TBD
**UI hint**: yes

### Phase 5: IA Coach / Analista
**Goal**: La IA lee los agregados del período y entrega una interpretación accionable en lenguaje natural, señalando el cuello de botella, sin nunca inventar cifras
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: AI-01, AI-02, AI-03, AI-04
**Success Criteria** (what must be TRUE):
  1. El usuario puede pedir un resumen del período y la IA genera una interpretación en lenguaje natural de los agregados
  2. La IA da recomendaciones accionables señalando el cuello de botella del embudo por persona/equipo
  3. Toda cifra que menciona la IA es trazable a un agregado pre-computado — la IA nunca calcula ni fabrica números (tool use tipado, sin SQL crudo)
  4. El uso de tokens de IA se puede acotar e instrumentar por tenant
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Fundaciones multi-tenant y diccionario | 0/TBD | Not started | - |
| 2. Núcleo de tracking manual | 0/TBD | Not started | - |
| 3. Roll-ups y dashboard | 0/TBD | Not started | - |
| 4. Metas y pacing | 0/TBD | Not started | - |
| 5. IA Coach / Analista | 0/TBD | Not started | - |
