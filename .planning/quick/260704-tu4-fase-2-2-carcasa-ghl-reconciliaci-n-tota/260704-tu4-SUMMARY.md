---
phase: quick-260704-tu4
plan: 01
subsystem: ghl-integration
tags: [ghl, reconciliacion, equipo, auto-link]
requires: [quick-260704-tiv]
provides:
  - "listGhlUsers con reconciliación total: auto-link por email + baja de huérfanos no-admin"
  - "Campo auto_linked en GET /api/ghl/users"
  - "UI: aviso de auto-vinculados + refresh inmediato del equipo"
affects: [api/server.js, index.html]
tech-stack:
  added: []
  patterns: ["reconciliación server-side con SERVICE_ROLE_KEY", "patrón PATCH+ban reutilizado para bajas"]
key-files:
  created: []
  modified: [api/server.js, index.html]
decisions:
  - "Paso 2 (baja de huérfanos) corre DESPUÉS del map de users — los huérfanos manuales no aparecen en la lista GHL, y deja el código más simple (opción sugerida por el plan)"
  - "autoLinkedBox se renderiza ANTES de removedBox (ambos visibles si ambos tienen contenido)"
metrics:
  duration: "~10 min"
  completed: "2026-07-04"
---

# Quick Task 260704-tu4: Fase 2.2 carcasa GHL — reconciliación total Summary

Con GHL conectado, `listGhlUsers` ahora auto-vincula por email exacto a todo perfil activo sin `ghl_user_id` y da de baja automáticamente a los huérfanos manuales no-admin — GHL queda como única fuente de verdad del equipo no-admin, con aviso y refresh instantáneo en la UI.

## Tareas completadas

| Task | Nombre | Commit | Archivos |
|------|--------|--------|----------|
| 1 | Reconciliación en listGhlUsers (auto-link + baja de huérfanos no-admin) | 611e61c | api/server.js |
| 2 | UI — aviso de auto-vinculados y refresh inmediato | f53c999 | index.html |

## Qué cambió

### api/server.js — listGhlUsers (GET /api/ghl/users)
Orden final del handler:
1. **Paso 1 — Auto-link (nuevo, ANTES del map de `users`):** por cada usuario GHL con email, si existe un perfil activo sin `ghl_user_id` con ese email exacto (via `emailToProfile`, emails de GoTrue admin), PATCH solo `{ghl_user_id}` (role/name/active/contraseña intactos). Error → console.error + continue (queda "vinculable"). Éxito → mutación local (`p.ghl_user_id`, `byGhlId.set`, `emailToProfile.delete`) para que el map lo saque "importado", `auto_linked.push(p.name)` + log de auditoría. Guard: si `byGhlId.has(u.id)`, se salta (ghl_user_id ya tomado).
2. **Map de `users`** (sin cambios de lógica).
3. **Paso 2 — Baja de huérfanos manuales (nuevo, después del map):** perfil con `active !== false`, sin `ghl_user_id` y `role !== 'admin'` → PATCH `{active:false}` + PUT ban `87600h` best-effort (patrón existente), `p.active = false` local, `removed.push(p.name)` + log "huérfano manual con GHL conectado". **EXCEPCIÓN INAMOVIBLE: los admin nunca se dan de baja.**
4. **Paso 3 — Baja de desvinculados:** loop existente sin cambios de lógica.
5. **Respuesta:** `{ access_code, users, removed, auto_linked }` — `auto_linked` solo lleva nombres. Log resumen incluye `auto_linked=N`. Comentario de cabecera actualizado (reconciliación total).

### index.html
- `GHL_AUTO_LINKED=[]` como estado (junto a `GHL_REMOVED`), reseteado en `disconnectGhl`.
- `autoLinkedBox` en `ghlTeamCard` (patrón `admin-lock`, nombres con `esc()`, singular/plural en castellano), renderizado antes de `removedBox`.
- `loadGhlUsers`: `GHL_AUTO_LINKED=data.auto_linked||[]` y refresh `if(GHL_REMOVED.length || GHL_AUTO_LINKED.length) await loadFromSupabase()` — bajas y vinculaciones se reflejan en "Miembros del equipo" al instante.
- `importGhlUser` y el resto del flujo: intactos.

## Verificación

- `node --check api/server.js` — pasa.
- API arranca sin env GHL: log `"La API arranca en modo manual"` + `"escuchando en el puerto 3987"` — sin crash.
- `grep auto_linked api/server.js` — acumulador (l.653), push (l.676), sendJSON (l.765). ✓
- `grep GHL_AUTO_LINKED index.html` — declaración, reset en disconnect, box, asignación desde data, condición de refresh. ✓
- Revisión de código: auto-link corre ANTES del map (status "importado" correcto); baja de huérfanos excluye admin (`p.role !== 'admin'`, T-q2.2-01); paso 3 intacto.
- Sin deletions de archivos en los commits. Cero secretos (repo público). Contraseñas y flujo de import intactos.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — las mitigaciones del threat model del plan (T-q2.2-01..03) están implementadas: excepción admin inamovible, match server-side vía GoTrue con guard `byGhlId`, respuesta solo con nombres.

## Self-Check: PASSED

- api/server.js modificado y commiteado (611e61c) — FOUND
- index.html modificado y commiteado (f53c999) — FOUND
- Commits verificados en git log — FOUND
