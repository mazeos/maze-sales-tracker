# Maze Sales Tracker IA

App web multi-tenant que reemplaza el tracker de ventas en planilla ("CAMINO DIGITAL") por un sistema con IA. Trackea el embudo completo de un equipo de ventas — **setter → triage → closer** — y convierte la actividad diaria en métricas confiables y decisiones accionables, con o sin GHL conectado.

Producto standalone pensado para los clientes de mentoring de Maze Funnels.

## Estado

Fase de diseño. Este repo contiene por ahora:

- **`index.html`** — maqueta estática del dashboard + captura móvil (datos de ejemplo). Es lo que se sirve en vivo.
- **`.planning/`** — planificación GSD: contexto, investigación, requisitos v1 (33) y roadmap de 5 fases.
- **`mockups/`** — fuente de diseño de la maqueta.

## Entornos (GitOps Maze)

| Rama | Entorno | URL |
|------|---------|-----|
| `main` | Producción | https://sales-tracker.mazefunnels.io |
| `develop` | Pruebas | https://sales-tracker-test.mazefunnels.io |

Flujo: se trabaja en `feature/*` → merge a `develop` (deploy automático a pruebas) → PR a `main` (deploy automático a producción). El deploy lo dispara el robot reutilizable `mazeos/maze-infra` vía el recepcionista del VPS (nginx:alpine + Traefik).

## Roadmap v1 (resumen)

1. Fundaciones multi-tenant + diccionario de datos
2. Núcleo de tracking manual (embudo + tasas + log de ventas)
3. Roll-ups y dashboard
4. Metas y pacing
5. IA Coach / Analista

Detalle completo en `.planning/ROADMAP.md`.
