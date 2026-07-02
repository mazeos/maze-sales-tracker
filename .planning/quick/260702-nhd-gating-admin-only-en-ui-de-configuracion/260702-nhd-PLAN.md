---
phase: quick-260702-nhd
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [index.html]
autonomous: true
requirements: [GATING-ADMIN-UI]
must_haves:
  truths:
    - "Un colaborador (IS_ADMIN=false) ve Configuraciones y Metas con toda la info visible pero sin poder editar"
    - "Los inputs y selects de Configuraciones y Metas quedan disabled para no-admin"
    - "Los botones de mutación (Quitar, Agregar al equipo) se ocultan para no-admin"
    - "El botón 'Editar sus números' sigue visible para un colaborador SOLO en su propia fila"
    - "Se muestra un aviso 'Solo el admin puede editar esta sección' en ambas vistas para no-admin"
    - "Los handlers globales hacen early-return si !IS_ADMIN (bloqueo vía DevTools)"
    - "El aviso se ve legible en tema claro y oscuro (contraste WCAG >=4.5)"
  artifacts:
    - path: index.html
      provides: "Gating admin-only en renderTeam() y renderGoals() + guards en handlers"
      contains: "adminNotice"
  key_links:
    - from: "renderTeam / renderGoals"
      to: "IS_ADMIN"
      via: "condicional que agrega disabled/oculta botones"
      pattern: "IS_ADMIN"
    - from: "setAgName/setMode/setTz/setMemberName/setMemberRole/setCommission/addMember/delMember/setGoal"
      to: "IS_ADMIN"
      via: "early-return guard"
      pattern: "if\\(!IS_ADMIN\\)\\s*return"
---

<objective>
Hacer read-only para colaboradores (IS_ADMIN=false) las vistas **Configuraciones** (`renderTeam`) y **Metas** (`renderGoals`) del Maze Sales Tracker. La info sigue visible (transparencia del equipo), pero la edición se bloquea en dos capas: (1) UI — inputs/selects `disabled`, botones de mutación ocultos, aviso visible; (2) defensa en profundidad — los handlers globales hacen early-return si no es admin, evitando la edición vía DevTools que hoy falla silencioso contra la RLS de Supabase.

Purpose: Hoy la RLS bloquea los writes en backend pero la UI deja intentar y muestra un toast "guardado" mentiroso. Esto alinea la UI con los permisos reales.
Output: `index.html` modificado (misma app self-contained, vanilla JS).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md
@index.html

<interfaces>
<!-- Estado de auth (ya existente en index.html) -->
- `let ME=null, IS_ADMIN=false;` (línea ~343) — se setea en boot(): `IS_ADMIN=prof.role==='admin'` (línea ~1125). `ME.id` = id del profile logueado.
- Patrón de gating ya existente en renderTable() (línea ~892): `const canEdit=IS_ADMIN||(ME&&state.tblMember===ME.id);` y en la celda `... ${canEdit?'':'readonly'}`.

<!-- Vistas objetivo -->
- `renderTeam()` (línea ~969): sección Agencia (nombre, modo de equipo, zona horaria), lista de miembros (nombre, rol, comisión, "Editar sus números", "Quitar"), y sección "Agregar miembro".
- `renderGoals()` (línea ~1024): 3 inputs de metas semanales (cierres, cash_nuevo, agendados).

<!-- Handlers globales a proteger (líneas ~1008-1036) -->
- `window.setAgName`, `window.setMode`, `window.setTz`, `window.setMemberName`, `window.setMemberRole`, `window.setCommission`, `window.addMember`, `window.delMember`, `window.setGoal`

<!-- Tokens de tema (líneas 12-14 dark, 234-255 light[data-theme="light"]) -->
- `--surface-2`, `--line`, `--muted`, `--ink`, `--amber:#F5B14C`. En tema claro el texto amber legible usado por el proyecto es `#7d5300` (ver `.tag.warn` override, línea ~254). `--danger:#F2555A`.
- El tema se aplica con `body[data-theme="light"]` sobrescribiendo las variables CSS.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: UI read-only + aviso en Configuraciones y Metas</name>
  <files>index.html</files>
  <action>
Agregar gating de UI para no-admin en `renderTeam()` (~línea 969) y `renderGoals()` (~línea 1024), reutilizando el patrón `canEdit` ya presente en renderTable().

1. **Helper de aviso.** Crear una función `function adminNotice(){ return IS_ADMIN ? '' : '<div class="admin-lock">🔒 <span>Solo el admin puede editar esta sección. Puedes ver los datos del equipo, pero no modificarlos.</span></div>'; }` colocada cerca de las utilidades (p.ej. junto a `info()` ~línea 1088). Copy en castellano neutro/venezolano con tuteo ("Puedes", "modificarlos") — NUNCA voseo, y NO tocar los textos rioplatenses existentes ("Editá", "Poné").

2. **CSS `.admin-lock`.** Agregar en el bloque `<style>` (junto a `.empty`/`.badge`, ~línea 108) usando SOLO tokens existentes para que funcione en ambos temas:
   `.admin-lock{display:flex;gap:9px;align-items:flex-start;background:rgba(245,177,76,.10);border:1px solid rgba(245,177,76,.35);color:var(--amber);font-size:12.5px;line-height:1.45;padding:10px 13px;border-radius:11px;margin-bottom:16px}`
   Y una override de tema claro para cumplir contraste WCAG >=4.5 (mismo color que el proyecto ya usa para warn en claro), en el bloque `body[data-theme="light"]` (~línea 234-255):
   `body[data-theme="light"] .admin-lock{color:#7d5300;background:rgba(245,177,76,.16)}`

3. **renderTeam() gating.** Definir al inicio `const ro = !IS_ADMIN;` (read-only). Aplicar:
   - Insertar `${adminNotice()}` justo después del `<h2 class="view">…</h2>` de la vista (antes del primer `<div class="section">`).
   - Sección Agencia: agregar `${ro?'disabled':''}` a los 3 controles: input nombre agencia, select modo de equipo (`setMode`), select zona horaria (`setTz`).
   - Lista de miembros: agregar `${ro?'disabled':''}` al input `cfg-name` (`setMemberName`), al select `cfg-role` (`setMemberRole`) y al input de comisión (`setCommission`, dentro de `line2`).
   - Botón "Editar sus números" (`editMemberData`): mantenerlo pero SOLO visible en la propia fila del colaborador — renderizarlo condicional: `${(IS_ADMIN || (ME && m.id===ME.id)) ? '<button class="btn ghost sm" onclick="editMemberData(...)" ...>Editar sus números</button>' : ''}`.
   - Botón "Quitar" (`delMember`): ocultar para no-admin → `${IS_ADMIN ? '<button class="btn danger sm" onclick="delMember(...)">Quitar</button>' : ''}`.
   - Sección "Agregar miembro": ocultar el bloque completo para no-admin → envolver ese `<div class="section">…</div>` en `${IS_ADMIN ? '…' : ''}`.

4. **renderGoals() gating.** Definir `const ro=!IS_ADMIN;`. Insertar `${adminNotice()}` después del `<h2 class="view">…</h2>` (antes del `<div class="cap-wrap">`). Agregar `${ro?'disabled':''}` a los 3 inputs (`setGoal` de cierres, cash_nuevo, agendados).

Respetar el estilo existente: template literals, clases CSS existentes (`.inp`, `.btn`, `.section`, `.field`), sin frameworks. No introducir voseo en textos nuevos.
  </action>
  <verify>
    <automated>node -e "const h=require('fs').readFileSync('index.html','utf8'); const need=['adminNotice','.admin-lock','data-theme=\"light\"] .admin-lock']; for(const s of need){ if(!h.includes(s)){ console.error('FALTA: '+s); process.exit(1);} } if(!/function adminNotice\(\)\{ *return IS_ADMIN/.test(h)){console.error('adminNotice mal formado');process.exit(1);} console.log('OK task1');"</automated>
  </verify>
  <done>renderTeam() y renderGoals() muestran el aviso y dejan todos los controles disabled para no-admin; "Editar sus números" solo en la propia fila; "Quitar" y "Agregar miembro" ocultos para no-admin; admin ve todo editable como antes. El aviso legible en ambos temas.</done>
</task>

<task type="auto">
  <name>Task 2: Guards early-return en handlers globales (defensa en profundidad)</name>
  <files>index.html</files>
  <action>
Agregar un early-return `if(!IS_ADMIN) return;` como PRIMERA sentencia dentro de cada uno de estos handlers globales (líneas ~1008-1036), para que la edición vía consola/DevTools no llegue a `save()`/`pushToSupabase()` (evita el toast "guardado" mentiroso contra la RLS):

- `window.setAgName` (~1008)
- `window.setMode` (~1009)
- `window.setTz` (~1010)
- `window.setMemberName` (~1011)
- `window.setMemberRole` (~1012)
- `window.setCommission` (~1013)
- `window.addMember` (~1015)
- `window.delMember` (~1021)
- `window.setGoal` (~1036)

NO tocar `window.editMemberData` (solo navega a la Tabla, que ya tiene su propio gating `canEdit`), ni `bump`/`setMoney`/`tblEdit` (edición de datos propios, gating ya existente). NO tocar `addSale`/`delSale`.

Mantener el estilo de una sola línea de los handlers; el guard va inmediatamente tras la apertura de la arrow function, antes de cualquier lectura del DOM o mutación de DB.
  </action>
  <verify>
    <automated>node -e "const h=require('fs').readFileSync('index.html','utf8'); const fns=['setAgName','setMode','setTz','setMemberName','setMemberRole','setCommission','addMember','delMember','setGoal']; let bad=[]; for(const f of fns){ const re=new RegExp('window\\\\.'+f+'=[^;]*?\\\\{[^}]*?if\\\\(!IS_ADMIN\\\\)\\\\s*return'); if(!re.test(h)) bad.push(f);} if(bad.length){console.error('SIN guard: '+bad.join(', '));process.exit(1);} console.log('OK task2 — guards en todos los handlers');"</automated>
  </verify>
  <done>Los 9 handlers hacen early-return si !IS_ADMIN. editMemberData, bump, setMoney, tblEdit, addSale, delSale quedan intactos. Un admin sigue editando normal.</done>
</task>

</tasks>

<verification>
- Cargar index.html como admin: Configuraciones y Metas totalmente editables, sin aviso.
- Cargar como colaborador (IS_ADMIN=false): aviso visible, todos los inputs/selects disabled, "Quitar" y "Agregar miembro" ausentes, "Editar sus números" solo en su propia fila.
- Probar en consola con IS_ADMIN=false: llamar `setGoal('cierres',5)` no muta ni muestra toast "Meta guardada".
- Alternar tema claro/oscuro: el aviso `.admin-lock` legible en ambos (contraste >=4.5).
</verification>

<success_criteria>
- Información del equipo VISIBLE para todos; edición bloqueada para no-admin en UI y en handlers.
- Cero regresiones para el admin.
- Copy nuevo en castellano neutro con tuteo; textos rioplatenses existentes intactos.
- Sin nuevas dependencias; app sigue self-contained.
</success_criteria>

<output>
Actualizar `index.html`. No se requiere SUMMARY para tarea quick salvo que el orquestador lo pida.
</output>
