# Sincronizar usuarios de HighLevel estando de visita en otra org — Design

**Fecha:** 2026-07-13
**Rama base:** `feature/super-entrar-org` (depende de `effectiveOrg`)
**Rama:** `feature/sync-usuarios-ghl-visita`

## Problema

Un super-admin no puede traer al tracker los usuarios nuevos que un cliente crea en su
subcuenta de HighLevel.

La tarjeta **Configuraciones → Equipo desde HighLevel** (que lista los usuarios de la
subcuenta y permite importarlos) solo se renderiza si se cumplen tres condiciones:
`IS_ADMIN` && `GHL_STATUS.connected` && **`!visiting`**. El caso real donde se necesita
cae siempre en el tercero:

- En **Camino Digital** (org de Clara) **no existe ningún perfil con rol `admin`** — Clara
  figura como `closer`. Nadie de esa org puede abrir Configuraciones.
- El único que puede gestionarla es el super-admin, y entra en **modo visita**
  (`SUPER_HOME !== null`), donde la tarjeta está ocultada a propósito.

El bloqueo se introdujo en el commit `4f87574` con una razón que **ya no aplica**: en ese
momento la mini-API resolvía siempre la org madre del super, así que mostrar los controles
habría hecho que operaran sobre la org equivocada. La rama `feature/super-entrar-org`
resolvió justamente eso con `effectiveOrg`, pero lo aplicó a seis endpoints operativos y
dejó afuera los de equipo.

## Arquitectura

Se extiende el patrón existente, sin introducir ninguna vía de autorización nueva.

```
Frontend (modo visita)                Mini-API
─────────────────────                 ────────
loadGhlUsers()   ──org_id en QS───▶   GET  /api/ghl/users
importGhlUser()  ──org_id en body─▶   POST /api/ghl/users/import
                                              │
                                              ▼
                                      effectiveOrg(auth, requested)
                                        └─ auth.is_super ? requested : auth.org_id
```

`is_super` es el gate; el `org_id` solo elige **sobre qué org** operar, nunca autoriza por
sí mismo. Un caller no-super que mande el override lo ve **ignorado** (opera sobre su
propia org). Idéntico contrato al de los seis handlers ya migrados.

### 1. Backend — `api/server.js`

| Handler | Auth | `requested` viene de |
|---|---|---|
| `listGhlUsers` (GET `/api/ghl/users`) | `admin` | `url.searchParams.get('org_id')` |
| `importGhlUser` (POST `/api/ghl/users/import`) | `admin` | `body.org_id` |

En ambos, computar la org efectiva al inicio del handler y reemplazar **todos** los usos de
`admin.org_id` por esa variable local.

**Crítico en el import:** la org efectiva es la que se escribe en el `org_id` del perfil
nuevo (y la que se usa para buscar perfiles preexistentes y membresías). Si se escapa un
`admin.org_id`, el usuario de Clara termina como miembro de la org madre del super.

Si `listGhlUsers` no recibe `url`, pasárselo desde el bloque de routing (que ya la tiene
parseada), igual que se hizo con `captureGhl`.

### 2. Frontend — `index.html`

- Dejar de ocultar `ghlTeamCard()` en modo visita (línea ~2203, hoy
  `${visiting ? '' : `${ghlCard()}${ghlTeamCard()}`}`).
- `loadGhlUsers()` (~1410): agregar `superOrgQS()` al fetch.
- `importGhlUser()` (~1438): envolver el body con `superOrgBody({...})`.

Los helpers `superOrgQS()` / `superOrgBody()` ya existen (rama `feature/super-entrar-org`).

### 3. Fuera de alcance — sigue oculto en modo visita

| Qué | Por qué |
|---|---|
| `ghlCard()` — conectar/desconectar OAuth de la org | Desconectar la integración del cliente por accidente es destructivo y no hace falta para sincronizar usuarios. |
| Alta manual de miembro (`addMemberForm`) | Con GHL conectado ya está deshabilitada por diseño (decisión 2026-07-04: GHL es la única fuente de verdad del equipo). |
| Baja manual (`Quitar`, `delMember`) | La reconciliación da de baja sola a quien ya no está en GHL. |
| Importación masiva ("importar todos los nuevos") | YAGNI: el import exige elegir rol por persona; equipos chicos. |
| Auto-refresh de la lista al abrir Configuraciones | Descartado en el brainstorming: cada apertura dispararía la reconciliación (que escribe). El refresh queda explícito. |

## Efecto aceptado: la reconciliación corre sobre la org visitada

`GET /api/ghl/users` **no es solo lectura**. Reconcilia y escribe:

1. **Auto-link** — perfil activo sin `ghl_user_id` cuyo email coincide exacto con un usuario
   GHL → se vincula.
2. **Huérfanos manuales** — perfil activo no-`admin` que quedó sin `ghl_user_id` tras el
   auto-link → baja automática (`active=false` + ban).
3. **Desvinculados** — perfil importado cuyo usuario ya no está en la subcuenta (o figura
   `deleted`) → baja automática.

Los perfiles con `role='admin'` nunca se dan de baja automáticamente.

Con el override, **abrir la tarjeta estando de visita dispara esa reconciliación sobre el
equipo del cliente**. Es el comportamiento que la app declara ("con GHL conectado, GHL es la
única fuente de verdad del equipo", decisión 2026-07-04) y que ya ocurre hoy en la org
propia — el perfil "Alejandro Vogeler" de Camino Digital está `active=false` porque una
reconciliación previa lo bajó por huérfano.

**Aprobado explícitamente por Alejandro (2026-07-13): la reconciliación corre completa
también en modo visita.** La alternativa considerada y descartada era listar sin dar de baja
cuando `is_super && org override`, dejando las bajas solo para el admin real de la org.

## Verificación

**Seguridad (criterio de aceptación crítico, bloqueante):**
Un JWT **no-super** que pegue a `/api/ghl/users?org_id=<org ajena>` debe responder con los
usuarios/estado de **su propia** org, ignorando el override. Si devolviera datos de la org
ajena, la seguridad está rota y se detiene el trabajo.

**Funcional (super):**
- `GET /api/ghl/users?org_id=<Camino Digital>` con JWT de super devuelve los usuarios de la
  subcuenta de Clara (`EwHiiqjOSOdzpl909IDY`), no los de la org madre
  (`siM5ZYQ90OgKoshnqLeC`). Sin override, devuelve los de la org madre. Distintos → funciona.
- Import con override: el perfil creado en `st_profiles` queda con
  `org_id = 7812d3f6-7c34-4729-8ca3-a3ebc3ed22a7` (Camino Digital), **no** con el de la org
  madre.

**e2e (queda para Ale, click-through visual):**
Entrar a Camino Digital como super → Configuraciones → aparece "Equipo desde HighLevel" →
"Cargar usuarios de HighLevel" lista el equipo de Clara → importar uno con su rol → figura
en Miembros del equipo de esa org → "Volver a tu equipo" y la lista vuelve a ser la propia.

## Constraints

- Base Supabase **compartida** por todos los tenants (Clara corre en prod). Deploy solo a
  `sales-tracker-test.mazefunnels.io`. **No promover a main/prod** sin QA de Ale.
- Idioma de la UI: castellano rioplatense.
- Sin dependencias nuevas: `api/server.js` es Node sin deps, `index.html` es vanilla JS.
