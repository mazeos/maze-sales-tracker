# Requirements: Maze Sales Tracker IA

**Defined:** 2026-06-30
**Core Value:** Convertir la actividad diaria de un equipo de ventas en métricas confiables y decisiones accionables — funcionando con o sin GHL conectado.

## v1 Requirements

Alcance del primer milestone: **paridad total con la planilla "CAMINO DIGITAL" + los diferenciadores que no dependen de GHL** (metas/pacing, diccionario embebido, 1 IA coach). La auto-carga desde GHL y las otras 3 IAs se difieren a v2 — la investigación es clara en que el dato confiable va primero.

### Cuentas y Tenancy

- [ ] **TEN-01**: El dueño puede crear una cuenta de agencia (tenant) y quedar como owner
- [ ] **TEN-02**: El owner puede invitar miembros y asignarles rol (setter / triage / closer)
- [ ] **TEN-03**: Los datos de cada agencia están aislados: un usuario solo ve los datos de su agencia
- [ ] **TEN-04**: El usuario puede iniciar sesión y la sesión persiste entre refrescos del navegador
- [ ] **TEN-05**: Cada miembro ve la vista y los permisos correspondientes a su rol

### Captura manual

- [ ] **CAP-01**: Un setter puede registrar sus conteos del día (outbound, inbounds IG/Wpp-TikTok/Wpp-IG, bienvenidas, CTA, respuestas, seguimientos, links de agenda, agendados)
- [ ] **CAP-02**: Un triage puede registrar sus conteos del día (agendadas, asistencias, no-shows, pases a closer)
- [ ] **CAP-03**: Un closer puede registrar sus conteos del día (disponibilidad, llamadas, segundas llamadas, asistencias, ofertas, cancelados, no-shows, cierres, referidos)
- [ ] **CAP-04**: La captura es mobile-first y de baja fricción — la app funciona como el "contador" en vivo, no un formulario de fin de día
- [ ] **CAP-05**: El usuario solo carga conteos atómicos, nunca porcentajes (las tasas se derivan en backend)
- [ ] **CAP-06**: El usuario puede editar o corregir el registro de un día pasado

### Métricas y embudo

- [ ] **MET-01**: El sistema deriva todas las tasas del embudo a partir de los conteos (link→agenda, % lead→agenda, agenda→asistencia, % pases a closer, asistencia→cierre, % cierre, etc.)
- [ ] **MET-02**: El sistema soporta líneas de oferta (Membresía / Lite / High-Ticket) en las métricas de cierre
- [ ] **MET-03**: El sistema calcula el % de ocupación/disponibilidad del closer (base para futura detección de burnout)
- [ ] **MET-04**: El sistema distingue cash collected (nuevo / cuotas / reservas) de revenue facturado
- [ ] **MET-05**: El sistema soporta configuración de equipo: solo-setter / setter+closer / setter+triage+closer

### Log de ventas

- [ ] **SAL-01**: Un closer puede registrar una venta con cliente, programa, método de pago, monto facturado, cash collected, cuotas y reserva
- [ ] **SAL-02**: Cada venta guarda atribución completa: closer, triage, setter y fuente del lead
- [ ] **SAL-03**: El sistema agrega las ventas por programa / línea de oferta

### Roll-ups y Dashboard

- [ ] **DASH-01**: El sistema genera roll-ups diario / semanal / mensual / trimestral / anual automáticamente para todos los roles, **incluido el setter**
- [ ] **DASH-02**: Los roll-ups respetan la zona horaria de la agencia, no UTC
- [ ] **DASH-03**: El owner ve un dashboard de resumen legible del equipo de un solo golpe de vista
- [ ] **DASH-04**: El owner puede ver la performance de cada miembro individual
- [ ] **DASH-05**: El usuario puede comparar períodos (esta semana vs la anterior, este mes vs el anterior)

### Metas y pacing

- [ ] **GOAL-01**: El owner puede fijar metas por rol / persona / período
- [ ] **GOAL-02**: El dashboard muestra goal-vs-actual (cuánto falta para la meta)
- [ ] **GOAL-03**: El sistema muestra pacing: si el equipo/persona va adelantado o atrasado según el ritmo del período

### Diccionario de datos embebido

- [ ] **DICT-01**: Cada métrica tiene su definición accesible dentro de la app (tooltip / ayuda contextual)
- [ ] **DICT-02**: Las definiciones salen de una sola fuente y son consistentes en toda la app

### IA Coach / Analista

- [ ] **AI-01**: La IA lee los agregados del período y genera un resumen/interpretación en lenguaje natural
- [ ] **AI-02**: La IA da recomendaciones accionables señalando el cuello de botella del embudo por persona/equipo
- [ ] **AI-03**: La IA nunca inventa cifras: solo redacta sobre agregados pre-computados (tool use tipado, sin SQL crudo)
- [ ] **AI-04**: El uso de tokens de IA se puede acotar e instrumentar por tenant

## v2 Requirements

Reconocidos y diferidos. No entran en el roadmap de v1.

### Integración GoHighLevel

- **GHL-01**: El owner conecta su cuenta GHL vía OAuth 2.0 Marketplace App
- **GHL-02**: El sistema auto-carga métricas desde conversaciones, citas y oportunidades de GHL
- **GHL-03**: Manual y GHL escriben al mismo modelo `metric_facts` con dedup/idempotencia (nunca se suman)
- **GHL-04**: Reconciliación por pull como fuente de verdad + webhooks como optimización
- **GHL-05**: Resolución de precedencia manual vs GHL por métrica

### IA avanzada

- **AI2-01**: IA de alertas/anomalías (burnout de closer, caídas de tasa, no-shows en alza) vía Slack/GHL
- **AI2-02**: IA de consultas en lenguaje natural (copiloto del dashboard)
- **AI2-03**: IA de auto-mapeo de eventos GHL → métricas del embudo por línea de oferta

### Comercialización del SaaS

- **BIZ-01**: Billing/suscripción de la propia app para venderla a clientes

## Out of Scope

Excluido explícitamente para prevenir scope creep.

| Feature | Reason |
|---------|--------|
| Ser un CRM | Se integra con GHL, no lo reemplaza |
| Facturar/cobrar dentro de la app | Vive en GHL/Stripe; acá solo se registra el resultado |
| App móvil nativa | v1 es web responsive (mobile-first en la captura) |
| Gamificación / leaderboards públicos | Riesgo de incentivar métricas de vanidad — el pecado de la planilla |
| IA que calcula o fabrica cifras | La IA solo redacta sobre agregados pre-computados (evita alucinación y fuga cross-tenant) |
| Cargar porcentajes a mano | Causa raíz de la varianza 12%↔91% de la planilla original |

## Traceability

Se completa durante la creación del roadmap.

| Requirement | Phase | Status |
|-------------|-------|--------|
| (pendiente de mapeo por el roadmapper) | — | Pending |

**Coverage:**
- v1 requirements: 31 total
- Mapped to phases: 0 (pendiente)
- Unmapped: 31 ⚠️

---
*Requirements defined: 2026-06-30*
*Last updated: 2026-06-30 after initial definition*
