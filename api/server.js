// server.js — Mini-API de provisioning de miembros e integración GHL para Maze Sales Tracker.
//
// Sin dependencias npm: usa solo módulos nativos (`http`, `crypto`) y el `fetch` global de Node 22.
// Gestiona auth users + perfiles con la SERVICE_ROLE_KEY (bypassea RLS), por lo que TODO
// filtrado por org_id se hace acá, a mano, y toda operación exige que el caller sea admin.
//
// Rutas:
//   POST   /api/members            -> crea auth user + perfil (alta real, la persona puede loguearse)
//   DELETE /api/members/{id}       -> soft-delete: active=false + ban del auth user (conserva histórico)
//   GET    /api/oauth/start        -> inicia el flujo OAuth de GHL (redirect a chooselocation)
//   GET    /api/oauth/callback     -> recibe el code de GHL, intercambia tokens y guarda la integración
//   GET    /api/integrations/ghl   -> estado de conexión (sin tokens, jamás)
//   DELETE /api/integrations/ghl   -> desconecta la integración GHL de la org
//   GET    /api/ghl/users          -> lista los usuarios de la subcuenta GHL con su estado + reconcilia bajas
//   POST   /api/ghl/users/import   -> importa/vincula/reactiva un usuario GHL como miembro del tracker
//   GET    /api/ghl/calendars      -> calendarios GHL con closers sincronizados (para elegir el de llamadas)
//   POST   /api/integrations/ghl/calendar -> guarda/desconfigura el calendario de llamadas de la org
//   GET    /api/ghl/leads          -> leads con cita en el calendario de llamadas de la org (cualquier miembro activo)
//   GET    /api/capture/ghl        -> autocompletar Cargar día del closer (citas GHL + ventas del día)
//   POST   /api/shadow/run         -> corre la sombra de auto-carga de la org (admin; body {date?})
//   POST   /api/sales/ghl          -> cierra el ciclo de la venta en GHL: custom fields + tag + oportunidad + Slack
//   POST   /api/me/password        -> el usuario logueado cambia su propia contraseña
//   GET    /api/orgs               -> lista todas las orgs del tracker (SOLO super-admins de Maze)
//   POST   /api/orgs               -> alta de una org + su admin (SOLO super-admins de Maze)
//   DELETE /api/orgs/{orgId}       -> elimina una org completa (datos + perfiles, JAMÁS auth users; SOLO super-admins)
//   POST   /api/orgs/{orgId}/members/{uid}/login-link -> magic link para entrar como ese miembro (SOLO super-admins)
//   GET    /api/platform/settings  -> estado del token de agencia GHL (solo hint, SOLO super-admins)
//   POST   /api/platform/settings  -> guarda/borra el token de agencia GHL, validado en vivo (SOLO super-admins)
//   GET    /api/platform/locations -> busca subcuentas de la agencia GHL por nombre/email/id (SOLO super-admins)

import http from 'node:http';
import crypto from 'node:crypto';
import { computeMemberKpis } from './metrics.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.ANON_KEY || '';
const PORT = parseInt(process.env.PORT || '3000', 10);

// Super-admins de la plataforma (equipo Maze): lista de emails separada por comas.
// Los emails reales NUNCA van al código (repo público): solo por env. Lista vacía
// = gestión de organizaciones deshabilitada (fail-closed 403).
const SUPER_ADMINS = (process.env.SUPER_ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.toLowerCase().trim())
  .filter(Boolean);

// Env vars de la integración GHL (opcionales: la API arranca igual sin ellas).
// Los valores reales NUNCA van al código (repo público): solo por env.
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID || '';
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const GHL_ENABLED = !!(GHL_CLIENT_ID && GHL_CLIENT_SECRET && PUBLIC_URL);
const GHL_REDIRECT_URI = PUBLIC_URL + '/api/oauth/callback';

// Scopes que pide la app del Marketplace (space-separated).
const GHL_SCOPES = 'users.readonly calendars.readonly calendars/events.readonly contacts.readonly contacts.write opportunities.readonly opportunities.write conversations.readonly conversations/message.readonly locations.readonly';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('[api] Faltan env vars: SUPABASE_URL, SERVICE_ROLE_KEY y/o ANON_KEY. La API no puede arrancar.');
  process.exit(1);
}

if (!GHL_ENABLED) {
  console.log('[api] Integración GHL no configurada (faltan GHL_CLIENT_ID/GHL_CLIENT_SECRET/PUBLIC_URL). La API arranca en modo manual.');
}

// ---------- Env vars del módulo Ventas-GHL (todas opcionales) ----------
// GHL_PIT + GHL_LOCATION: modo "instancia dedicada" (ej. Clara) — fallback cuando
// la org no tiene integración OAuth en st_integrations. Los IDs de custom fields
// y del pipeline entran por env en JSON (repo público: CERO IDs en el código).
const GHL_PIT = process.env.GHL_PIT || '';
const GHL_LOCATION = process.env.GHL_LOCATION || '';
const GHL_CALENDAR = process.env.GHL_CALENDAR || '';
const SLACK_TOKEN = process.env.SLACK_TOKEN || '';
const SLACK_WINS_CHANNEL = process.env.SLACK_WINS_CHANNEL || '';
// Shared secret de la app del Marketplace: GHL cifra los datos del usuario con
// esta clave y nos los pasa por postMessage cuando el tracker corre embebido
// en una Custom Page. Sin la key, el SSO queda deshabilitado (fail-closed).
const GHL_SSO_KEY = process.env.GHL_SSO_KEY || '';
const GHL_BASE = 'https://services.leadconnectorhq.com';

// Parseo tolerante: si el env falta o el JSON es inválido, la constante queda null
// y el paso correspondiente se saltea en runtime. NUNCA crashear el arranque.
function parseJsonEnv(name, aviso) {
  const raw = process.env[name] || '';
  if (!raw) {
    console.log(`[api] ${name} no configurado/ inválido — se saltea el paso de ${aviso}`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.log(`[api] ${name} no configurado/ inválido — se saltea el paso de ${aviso}`);
    return null;
  }
}
// Claves esperadas: montoTotal, cantidadPagos, metodoPago, programa, montoReserva,
// fueReserva, primerPago, vendedor (IDs de custom fields del contacto GHL).
const GHL_CF = parseJsonEnv('GHL_CF_JSON', 'custom fields');
// Claves esperadas: pipelineId, stageReserva, stagePago (pipeline de onboarding).
const GHL_PIPELINE = parseJsonEnv('GHL_PIPELINE_JSON', 'oportunidad');

// Headers para la API de GHL. El token varía por org (OAuth o PIT), por eso es parámetro.
function ghlHeaders(token, version = '2021-07-28') {
  return { 'Authorization': 'Bearer ' + token, 'Version': version, 'Content-Type': 'application/json' };
}

const VALID_ROLES = ['setter', 'triage', 'closer'];

// Mapa canónico modo de equipo → roles permitidos (además de 'admin', SIEMPRE válido).
//   solo → setter | sc → setter, closer | full → setter, triage, closer
// El import desde GHL (ghl_user_id no-null) queda EXENTO del enforcement: GHL es la
// fuente de verdad del equipo cuando está conectado (decisión 2026-07-04). Esa exención
// se aplica en el trigger DB (migración 016); acá el alta manual siempre tiene ghl_user_id null.
const MODE_ROLES = { solo: ['setter'], sc: ['setter', 'closer'], full: ['setter', 'triage', 'closer'] };

function roleAllowedForMode(role, mode) {
  if (role === 'admin') return true;
  const allowed = MODE_ROLES[mode] || MODE_ROLES.full;
  return allowed.includes(role);
}

// ---------- Helpers de respuesta ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Lee el body completo y lo parsea como JSON. Devuelve {ok, data} o {ok:false} si es inválido.
function readJSONBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { tooBig = true; req.destroy(); } // guarda anti-payload gigante
    });
    req.on('end', () => {
      if (tooBig) return resolve({ ok: false });
      if (!raw) return resolve({ ok: true, data: {} });
      try { resolve({ ok: true, data: JSON.parse(raw) }); }
      catch { resolve({ ok: false }); }
    });
    req.on('error', () => resolve({ ok: false }));
  });
}

// Headers para llamar a Supabase con la service key (bypassea RLS).
function svcHeaders(extra = {}) {
  return {
    'apikey': SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Lee el team_mode de una org con service key. Fail-open a 'full' ante error de red
// (no dejamos que una lectura caída bloquee el alta/cambio; el trigger DB es el backstop).
async function readTeamMode(orgId) {
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_orgs?id=eq.' + encodeURIComponent(orgId) + '&select=team_mode',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) {
      console.warn(`[api] readTeamMode org=${orgId} status=${r.status} -> fail-open full`);
      return 'full';
    }
    const rows = await r.json().catch(() => null);
    const row = Array.isArray(rows) ? rows[0] : rows;
    return (row && row.team_mode) || 'full';
  } catch {
    console.warn(`[api] readTeamMode org=${orgId} network_error -> fail-open full`);
    return 'full';
  }
}

// ---------- Auth: valida un JWT (y opcionalmente exige role=admin) ----------
// checkUserToken recibe el token ('Bearer xxx' o el token pelado), lo valida contra
// GoTrue y devuelve { ok:true, uid } SIN exigir rol; si no, { ok:false, status, error }.
// checkAdminToken lo reutiliza y agrega el paso 2: perfil real + role=admin.
// requireAdmin(req) es el wrapper que lee el header Authorization.
async function checkUserToken(bearerToken) {
  let token = (bearerToken || '').trim();
  if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: 'Falta el token de sesión' };
  }
  const authHeader = 'Bearer ' + token;

  // Validar el JWT contra GoTrue (no confiamos en claims del cliente).
  let userRes;
  try {
    userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': ANON_KEY, 'Authorization': authHeader },
    });
  } catch {
    return { ok: false, status: 502, error: 'No se pudo validar la sesión con el servidor de auth' };
  }
  if (userRes.status !== 200) {
    return { ok: false, status: 401, error: 'Sesión inválida' };
  }
  const user = await userRes.json();
  const uid = user && user.id;
  if (!uid) {
    return { ok: false, status: 401, error: 'Sesión inválida' };
  }

  return { ok: true, uid, email: (user && user.email) || null };
}

// Multi-cuenta: resuelve el PERFIL ACTIVO de un login (st_user_state validado,
// o el único/primer perfil activo por user_id). Devuelve la fila del perfil o null.
async function resolveActiveProfile(authUid) {
  let stateRows = [];
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/st_user_state?user_id=eq.' + encodeURIComponent(authUid) + '&select=active_profile_id', { headers: svcHeaders() });
    stateRows = r.status === 200 ? await r.json().catch(() => []) : [];
  } catch { /* fallback abajo */ }
  const pr = await fetch(
    SUPABASE_URL + '/rest/v1/st_profiles?user_id=eq.' + encodeURIComponent(authUid)
      + '&select=id,org_id,role,name,active,ghl_user_id&order=created_at.asc',
    { headers: svcHeaders() }
  );
  if (pr.status !== 200) throw new Error('perfiles ilegibles');
  const profs = (await pr.json().catch(() => [])).filter((p) => p.active !== false);
  if (!profs.length) return null;
  const wanted = stateRows[0] && stateRows[0].active_profile_id;
  return profs.find((p) => p.id === wanted) || profs[0];
}

async function checkAdminToken(bearerToken) {
  // 1. Validar el JWT (mismo paso que cualquier usuario logueado).
  const usr = await checkUserToken(bearerToken);
  if (!usr.ok) return usr;

  // 2. Perfil ACTIVO del caller (multi-cuenta) y exigir role=admin.
  let prof;
  try { prof = await resolveActiveProfile(usr.uid); } catch {
    return { ok: false, status: 502, error: 'No se pudo leer el perfil del usuario' };
  }
  // Super-admins (SUPER_ADMIN_EMAILS): permisos de admin en CUALQUIER org,
  // sin importar el rol de su membresía activa.
  const isSuper = !!(usr.email && SUPER_ADMINS.includes(String(usr.email).toLowerCase()));
  if (!prof || (prof.role !== 'admin' && !isSuper)) {
    return { ok: false, status: 403, error: 'Solo el admin puede gestionar miembros' };
  }

  // uid = id del PERFIL (semántica histórica: en cuentas pre-multicuenta coincide con el login)
  return { ok: true, uid: prof.id, auth_uid: usr.uid, org_id: prof.org_id, is_super: isSuper };
}

function requireAdmin(req) {
  return checkAdminToken(req.headers['authorization'] || '');
}

// ---------- Auth: cualquier miembro ACTIVO del equipo (no solo admin) ----------
// Reusa checkUserToken (JWT contra GoTrue) y lee el perfil con la service key.
// Devuelve { ok, uid, org_id, role, name } o { ok:false, status, error }.
async function requireMember(req) {
  const usr = await checkUserToken(req.headers['authorization'] || '');
  if (!usr.ok) return usr;

  let prof;
  try { prof = await resolveActiveProfile(usr.uid); } catch {
    return { ok: false, status: 502, error: 'No se pudo leer el perfil' };
  }
  if (!prof) {
    return { ok: false, status: 403, error: 'Tu usuario no está activo en el equipo' };
  }
  // uid = id del PERFIL activo (los consumidores lo usan como member_id)
  const isSuper = !!(usr.email && SUPER_ADMINS.includes(String(usr.email).toLowerCase()));
  return { ok: true, uid: prof.id, auth_uid: usr.uid, org_id: prof.org_id, role: prof.role, name: prof.name, is_super: isSuper };
}

// Org efectiva para acciones de la mini-API. Un super-admin puede apuntar a
// otra org pasando ?org_id= (GET) o body.org_id (POST); cualquier otro caller
// queda atado a su propia org (el override se ignora). is_super es el gate:
// el org_id solo elige sobre qué org operar, nunca autoriza.
function effectiveOrg(auth, requestedOrgId) {
  return (auth && auth.is_super && requestedOrgId) ? String(requestedOrgId) : auth.org_id;
}

// ---------- Auth: super-admin de la plataforma (equipo Maze) ----------
// Valida el JWT contra GoTrue y exige que el email del usuario esté en
// SUPER_ADMIN_EMAILS. NO toca st_profiles: el super-admin es de plataforma y
// puede no tener perfil en ninguna org. No reusa checkUserToken porque ese
// helper descarta el email (y obligaría a una segunda llamada a GoTrue).
async function requireSuperAdmin(req) {
  // Lista vacía → fail-closed sin llamar a la red (habilita el smoke test local).
  if (!SUPER_ADMINS.length) {
    return { ok: false, status: 403, error: 'Solo el equipo de Maze puede gestionar organizaciones' };
  }

  let token = (req.headers['authorization'] || '').trim();
  if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: 'Falta el token de sesión' };
  }

  let userRes;
  try {
    userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token },
    });
  } catch {
    return { ok: false, status: 502, error: 'No se pudo validar la sesión con el servidor de auth' };
  }
  if (userRes.status !== 200) {
    return { ok: false, status: 401, error: 'Sesión inválida' };
  }
  const user = await userRes.json().catch(() => null);
  const uid = user && user.id;
  if (!uid) {
    return { ok: false, status: 401, error: 'Sesión inválida' };
  }

  const email = typeof (user && user.email) === 'string' ? user.email.toLowerCase().trim() : '';
  if (!email || !SUPER_ADMINS.includes(email)) {
    return { ok: false, status: 403, error: 'Solo el equipo de Maze puede gestionar organizaciones' };
  }

  return { ok: true, uid, email };
}

// ---------- Helpers OAuth GHL ----------
// Redirect 302 simple (navegaciones del browser, no fetch).
function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

// State firmado con HMAC-SHA256 (secreto: SERVICE_ROLE_KEY). Lleva el org_id y un
// timestamp; el callback solo confía en un state cuya firma verifique y que tenga
// menos de 10 minutos de vida. Así nadie puede forjar un callback para otra org.
function signState(org) {
  const payload = Buffer.from(JSON.stringify({ org, ts: Date.now() })).toString('base64url');
  const firma = crypto.createHmac('sha256', SERVICE_ROLE_KEY).update(payload).digest('base64url');
  return payload + '.' + firma;
}

function verifyState(state) {
  try {
    const parts = String(state || '').split('.');
    if (parts.length !== 2) return { ok: false };
    const [payload, firma] = parts;
    const esperada = crypto.createHmac('sha256', SERVICE_ROLE_KEY).update(payload).digest('base64url');
    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.org || typeof data.ts !== 'number') return { ok: false };
    if (Date.now() - data.ts >= 10 * 60 * 1000) return { ok: false }; // expira a los 10 min
    return { ok: true, org: data.org };
  } catch {
    return { ok: false };
  }
}

// Trae la fila completa de st_integrations de una org (solo server-side: incluye
// tokens, JAMÁS pasar esta fila al browser). Devuelve la fila o null (también
// null en error de red: el caller decide cómo responder).
async function getIntegration(orgId) {
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_integrations?org_id=eq.' + encodeURIComponent(orgId) + '&select=*',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return null;
    const rows = await r.json().catch(() => null);
    return Array.isArray(rows) ? (rows[0] || null) : null;
  } catch {
    return null;
  }
}

// ---------- Settings de plataforma (st_platform_settings, deny-all) ----------
// Key/value global de la plataforma. Solo la service role lee/escribe esta
// tabla (RLS sin policies). El valor del PIT jamás sale de la API ni va a logs.
const PIT_KEY = 'ghl_agency_pit'; // el NOMBRE de la key, no el valor — no es un secreto

// Lee un setting. Devuelve el value o null (también null en error de red —
// mismo patrón que getIntegration: el caller decide cómo responder).
async function getPlatformSetting(key) {
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_platform_settings?key=eq.' + encodeURIComponent(key) + '&select=value',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return null;
    const rows = await r.json().catch(() => null);
    const row = Array.isArray(rows) ? rows[0] : null;
    return (row && typeof row.value === 'string') ? row.value : null;
  } catch {
    return null;
  }
}

// Guarda (upsert) un setting. Devuelve true/false según éxito.
async function setPlatformSetting(key, value) {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/st_platform_settings?on_conflict=key', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// Borra un setting. Idempotente: true aunque la key no existiera.
async function deletePlatformSetting(key) {
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_platform_settings?key=eq.' + encodeURIComponent(key),
      { method: 'DELETE', headers: svcHeaders({ 'Prefer': 'return=minimal' }) }
    );
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// Refresca el access_token de GHL si está por vencer (a menos de 5 min).
// Queda listo para las fases siguientes de sync; hoy ninguna ruta crítica lo consume.
async function refreshGhlToken(integration, force = false) {
  // Guard defensivo: una fila pre-vinculada (pending) no tiene tokens — jamás
  // postear refresh_token: undefined a GHL.
  if (!integration.refresh_token) throw new Error('Integración sin tokens (pendiente de autorizar)');
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at).getTime() : 0;
  // `force` (usado tras un 401) salta el chequeo de tiempo: el token dice estar
  // vigente por fecha pero GHL lo rechazó, así que hay que refrescar igual.
  if (!force && expiresAt - Date.now() >= 5 * 60 * 1000) {
    return integration.access_token; // todavía sirve, no hace falta refresh
  }

  const tokenRes = await fetch('https://services.leadconnectorhq.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GHL_CLIENT_ID,
      client_secret: GHL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: integration.refresh_token,
      user_type: 'Location',
    }),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (tokenRes.status < 200 || tokenRes.status >= 300 || !tok.access_token) {
    console.error(`[api] refreshGhlToken org=${integration.org_id} fail status=${tokenRes.status}`);
    throw new Error('No se pudo refrescar el token de GHL');
  }

  // Persistir los tokens nuevos (refresh token rotado de un solo uso).
  const patchRes = await fetch(
    SUPABASE_URL + '/rest/v1/st_integrations?org_id=eq.' + encodeURIComponent(integration.org_id),
    {
      method: 'PATCH',
      headers: svcHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        token_expires_at: new Date(Date.now() + (tok.expires_in || 0) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (patchRes.status < 200 || patchRes.status >= 300) {
    console.error(`[api] refreshGhlToken org=${integration.org_id} patch_fail status=${patchRes.status}`);
    throw new Error('No se pudo guardar el token refrescado de GHL');
  }

  return tok.access_token;
}

// ---------- Credenciales GHL por org (módulo Ventas-GHL) ----------
// Resolución multi-tenant: (1) integración OAuth de la org en st_integrations
// (token refrescado — el Error de refresh burbujea al caller, que responde 502);
// (2) fallback GHL_PIT + GHL_LOCATION por env (instancia dedicada); (3) null.
// Devuelve también la fila de la integración (`integration`, null en modo PIT)
// para que los callers lean config por org (ej. calendar_id) SIN una segunda
// llamada a getIntegration. OJO: la fila incluye tokens — jamás pasarla al browser.
async function getGhlCreds(orgId) {
  const integration = await getIntegration(orgId);
  // Fila pre-vinculada SIN tokens (pending) = NO conectada: cae al fallback
  // env PIT o null, como si no hubiera integración.
  if (integration && integration.access_token) {
    return { token: await refreshGhlToken(integration), locationId: integration.location_id, integration };
  }
  if (GHL_PIT && GHL_LOCATION) {
    return { token: GHL_PIT, locationId: GHL_LOCATION, integration: null };
  }
  return null;
}

// ---------- Llamada a GHL con auto-recuperación ante 401 ----------
// Envuelve un fetch a la API de GHL: si el token vigente es rechazado (401 —
// típico de un token revocado o restaurado con fecha válida pero contenido
// inválido), fuerza un refresh y reintenta UNA sola vez. `doFetch(token)` debe
// construir y ejecutar el fetch con el token que recibe. Solo aplica a
// integraciones OAuth (creds.integration); en modo PIT no hay refresh token, se
// devuelve la respuesta tal cual. Muta creds.token con el valor refrescado para
// que los usos posteriores del mismo creds ya usen el token nuevo.
async function ghlWithRetry(creds, doFetch) {
  let resp = await doFetch(creds.token);
  if (resp.status === 401 && creds && creds.integration) {
    try {
      const fresh = await refreshGhlToken(creds.integration, true);
      creds.token = fresh;
      resp = await doFetch(fresh);
    } catch (e) {
      console.error(`[api] ghlWithRetry refresh_on_401 fail org=${creds.integration.org_id}: ${e.message}`);
      // Devolver la 401 original: el caller ya la maneja (502/error de UI).
    }
  }
  return resp;
}

// ---------- GET /api/ghl/leads ----------
// Leads con cita en el calendario de llamadas (últimos 14 días + próximos 7)
// para asociar la venta. El calendario se resuelve POR ORG: el elegido en
// Configuraciones (st_integrations.calendar_id) manda; si la org no eligió,
// fallback al env GHL_CALENDAR (modo PIT / instancia dedicada); sin ninguno → 501.
// Cache en memoria POR ORG (60s) — una cache global filtraría leads entre tenants.
const leadsCache = new Map(); // orgId -> { at, data }
async function ghlLeads(req, res, member, url) {
  const orgId = effectiveOrg(member, url.searchParams.get('org_id'));
  let creds;
  try {
    creds = await getGhlCreds(orgId);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo refrescar el acceso a GHL. Probá de nuevo.' });
  }
  if (!creds) return sendJSON(res, 501, { error: 'GHL no está configurado en esta instancia' });
  const calendarId = (creds.integration && creds.integration.calendar_id) || GHL_CALENDAR;
  if (!calendarId) return sendJSON(res, 501, { error: 'Elegí el calendario de llamadas en Configuraciones → Integración HighLevel' });

  const now = Date.now();
  const cached = leadsCache.get(orgId);
  if (cached && cached.data && now - cached.at < 60000) {
    return sendJSON(res, 200, { leads: cached.data, cached: true });
  }

  let events = [];
  try {
    const start = now - 14 * 86400000, end = now + 7 * 86400000;
    const evRes = await ghlWithRetry(creds, (t) => fetch(
      `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(creds.locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${start}&endTime=${end}`,
      { headers: ghlHeaders(t, '2021-04-15') }
    ));
    const ev = await evRes.json().catch(() => ({}));
    events = ev.events || [];
  } catch {
    return sendJSON(res, 502, { error: 'No se pudieron leer las citas de GHL' });
  }

  // Dedupe por contacto, quedarse con la cita más reciente. Se saltean canceladas/inválidas.
  const byContact = new Map();
  for (const e of events) {
    if (!e.contactId) continue;
    const st = String(e.appointmentStatus || '').toLowerCase();
    if (['cancelled', 'invalid'].includes(st)) continue;
    const prev = byContact.get(e.contactId);
    if (!prev || String(e.startTime) > String(prev.startTime)) byContact.set(e.contactId, e);
  }

  const leads = [];
  for (const [cid, e] of byContact) {
    try {
      const cRes = await ghlWithRetry(creds, (t) => fetch(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, { headers: ghlHeaders(t) }));
      const c = (await cRes.json().catch(() => ({}))).contact || {};
      leads.push({
        id: cid,
        name: (() => { const w = [c.firstName, c.lastName].filter(Boolean).join(' ').split(/\s+/); return w.filter((x, i) => i === 0 || x.toLowerCase() !== w[i - 1].toLowerCase()).join(' ') || c.email || 'Sin nombre'; })(),
        email: c.email || '', phone: c.phone || '',
        cita: e.startTime || '', estado: e.appointmentStatus || '',
      });
    } catch { /* contacto ilegible: lo salteamos */ }
  }
  leads.sort((a, b) => String(b.cita).localeCompare(String(a.cita)));
  leadsCache.set(orgId, { at: now, data: leads });
  return sendJSON(res, 200, { leads });
}

// ---------- GET /api/capture/ghl ----------
// Autocompletar Cargar día (Fase 3 carcasa). SOLO closers en v1:
// - llamadas/asistencias/no_shows: citas del calendario de la org del día pedido,
//   SOLO las asignadas al ghl_user_id del closer (sin assignedUserId = no certera, se ignora).
// - cierres/cash_nuevo: st_sales del closer ese día (fuente: el propio tracker).
// El día se corta en la TZ de la org. Nada se escribe acá: la UI aplica los valores
// y el usuario guarda por el flujo normal (la RLS de st_entries manda).
function tzDayRange(dateStr, tz) {
  const utcMidnight = new Date(dateStr + 'T00:00:00Z').getTime();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMidnight)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const offset = asUtc - utcMidnight; // cuánto adelanta el tz respecto de UTC
  const start = utcMidnight - offset;
  return { start, end: start + 86400000 };
}

async function captureGhl(req, res, member, url) {
  const orgId = effectiveOrg(member, url.searchParams.get('org_id'));
  const date = String(url.searchParams.get('date') || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, 400, { error: 'Fecha inválida (YYYY-MM-DD)' });

  // Target: uno mismo, o cualquier miembro de la org si el caller es admin.
  const targetId = url.searchParams.get('member_id') || member.uid;
  if (targetId !== member.uid && member.role !== 'admin' && !member.is_super) {
    return sendJSON(res, 403, { error: 'Solo el admin puede autocompletar el día de otro miembro' });
  }

  let prof;
  try {
    const pr = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(targetId)
        + '&org_id=eq.' + encodeURIComponent(orgId) + '&select=id,role,active,ghl_user_id',
      { headers: svcHeaders() }
    );
    prof = (await pr.json().catch(() => []))[0];
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo leer el perfil del miembro' });
  }
  if (!prof || prof.active === false) return sendJSON(res, 404, { error: 'Miembro no encontrado o inactivo' });

  let creds;
  try { creds = await getGhlCreds(orgId); } catch {
    return sendJSON(res, 502, { error: 'No se pudo refrescar el acceso a GHL. Probá de nuevo.' });
  }
  if (!creds) return sendJSON(res, 501, { error: 'GHL no está configurado en esta instancia' });
  const calendarId = (creds.integration && creds.integration.calendar_id) || GHL_CALENDAR;
  // El calendario de llamadas es del closer; el setter no lo necesita (usa sus agenda cals).
  if (prof.role === 'closer' && !calendarId) return sendJSON(res, 501, { error: 'Elegí el calendario de llamadas en Configuraciones → Integración HighLevel' });

  // TZ de la org para cortar el día donde corresponde.
  let tz = 'America/Argentina/Buenos_Aires';
  try {
    const or_ = await fetch(SUPABASE_URL + '/rest/v1/st_orgs?id=eq.' + encodeURIComponent(orgId) + '&select=tz',
      { headers: svcHeaders() });
    const orow = (await or_.json().catch(() => []))[0];
    if (orow && orow.tz) tz = orow.tz;
  } catch { /* fallback al default */ }

  const metrics = {};

  // Citas del día asignadas al closer (solo si tiene ghl_user_id vinculado).
  if (prof.role === 'closer' && prof.ghl_user_id) {
    let events = [];
    try {
      const { start, end } = tzDayRange(date, tz);
      const evRes = await ghlWithRetry(creds, (t) => fetch(
        `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(creds.locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${start}&endTime=${end}`,
        { headers: ghlHeaders(t, '2021-04-15') }
      ));
      const ev = await evRes.json().catch(() => ({}));
      events = ev.events || [];
    } catch {
      return sendJSON(res, 502, { error: 'No se pudieron leer las citas de GHL' });
    }
    let llamadas = 0, asistencias = 0, noShows = 0;
    for (const e of events) {
      if (e.deleted) continue;
      if (e.assignedUserId !== prof.ghl_user_id) continue; // sin asignación certera no cuenta
      const st = String(e.appointmentStatus || '').toLowerCase();
      if (['cancelled', 'invalid'].includes(st)) continue;
      llamadas++;
      if (st === 'showed') asistencias++;
      if (st === 'noshow') noShows++;
    }
    metrics.llamadas = { value: llamadas, source: 'ghl' };
    metrics.asistencias = { value: asistencias, source: 'ghl' };
    metrics.no_shows = { value: noShows, source: 'ghl' };
  }

  // Cierres y cash desde las ventas del tracker (fuente de verdad interna). Solo closer.
  if (prof.role === 'closer') {
    try {
      const sr = await fetch(
        SUPABASE_URL + '/rest/v1/st_sales?org_id=eq.' + encodeURIComponent(orgId)
          + '&closer_id=eq.' + encodeURIComponent(targetId) + '&sale_date=eq.' + encodeURIComponent(date) + '&select=cash',
        { headers: svcHeaders() }
      );
      const sales = await sr.json().catch(() => null);
      if (Array.isArray(sales)) {
        metrics.cierres = { value: sales.length, source: 'ventas' };
        metrics.cash_nuevo = { value: sales.reduce((a, s) => a + (+s.cash || 0), 0), source: 'ventas' };
      }
    } catch { /* sin ventas legibles: se omiten esas métricas */ }
  }

  // Setter / triage: KPIs de conversaciones del día vía el motor completo (mismo del modo sombra).
  if (prof.role !== 'closer' && prof.ghl_user_id) {
    const cfgRows = await svcGet('st_kpi_config?org_id=eq.' + encodeURIComponent(orgId) + '&kpi=eq._config&select=config');
    const bookingDomains = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.booking_domains) || [];
    const agendaCalendarIds = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.agenda_calendar_ids) || [];
    let result;
    try {
      result = await computeMemberKpis({
        ghlBase: GHL_BASE, token: creds.token, locationId: creds.locationId,
        calendarId, tz, date,
        member: { id: targetId, role: prof.role, ghl_user_id: prof.ghl_user_id },
        salesRows: [], cuotasRows: [], bookingDomains, agendaCalendarIds,
      });
    } catch {
      return sendJSON(res, 502, { error: 'No se pudieron calcular los KPIs de GHL' });
    }
    for (const [k, v] of Object.entries(result.values || {})) {
      metrics[k] = { value: v, source: 'ghl' };
    }
  }

  return sendJSON(res, 200, { date, member_id: targetId, role: prof.role, metrics });
}

// ---------- Auto-carga Fase A: modo sombra ----------
// Calcula los KPIs auto de cada miembro (closer/setter) y los guarda en
// st_shadow_metrics JUNTO al valor manual del momento. NO toca st_entries
// (la graduación/escritura es Fase B). Corre por scheduler nocturno (23:40
// hora local de cada org) o a demanda vía POST /api/shadow/run (admin).
async function svcGet(pathq) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + pathq, { headers: svcHeaders() });
  return r.status === 200 ? r.json().catch(() => []) : [];
}

async function runShadowForOrg(orgId, dateStr) {
  const orgs = await svcGet('st_orgs?id=eq.' + encodeURIComponent(orgId) + '&select=id,tz');
  const org = orgs[0];
  if (!org) throw new Error('org inexistente');
  const tz = org.tz || 'America/Argentina/Buenos_Aires';
  const date = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

  let creds = null;
  try { creds = await getGhlCreds(orgId); } catch { /* sin GHL utilizable: solo KPIs internos */ }
  const calendarId = (creds && creds.integration && creds.integration.calendar_id) || GHL_CALENDAR || null;

  // Miembros con rol comercial: setter/triage/closer directos, o admins que
  // además venden (sales_role). El rol efectivo (comercial) es lo que mide el motor.
  const members = await svcGet('st_profiles?org_id=eq.' + encodeURIComponent(orgId)
    + '&select=id,role,sales_role,ghl_user_id,active');
  const activos = members
    .filter((m) => m.active !== false)
    .map((m) => ({ ...m, role: m.role === 'admin' ? m.sales_role : m.role }))
    .filter((m) => m.role === 'setter' || m.role === 'closer');
  const salesRows = await svcGet('st_sales?org_id=eq.' + encodeURIComponent(orgId) + '&select=id,closer_id,sale_date,cash,reserva,facturado');
  const cuotasRows = await svcGet('st_cuotas?org_id=eq.' + encodeURIComponent(orgId) + '&select=sale_id,status,paid_date,paid_amount');
  const cfgRows = await svcGet('st_kpi_config?org_id=eq.' + encodeURIComponent(orgId) + '&kpi=eq._config&select=config');
  const bookingDomains = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.booking_domains) || [];
  const agendaCalendarIds = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.agenda_calendar_ids) || [];

  const rows = [];
  for (const m of activos) {
    let kpis = {}, kpiContacts = {};
    try {
      const kpiResult = await computeMemberKpis({
        ghlBase: GHL_BASE, token: creds ? creds.token : null, locationId: creds ? creds.locationId : null,
        calendarId: creds ? calendarId : null, tz, date, member: m, salesRows, cuotasRows, bookingDomains, agendaCalendarIds,
      });
      kpis = kpiResult.values;
      kpiContacts = kpiResult.contacts;
    } catch (e) {
      console.warn('[shadow] member', m.id, 'falló:', e.message);
      continue;
    }
    const ents = await svcGet('st_entries?member_id=eq.' + encodeURIComponent(m.id) + '&entry_date=eq.' + encodeURIComponent(date) + '&select=metrics');
    const manual = (ents[0] && ents[0].metrics) || {};
    for (const [kpi, val] of Object.entries(kpis)) {
      rows.push({ org_id: orgId, member_id: m.id, metric_date: date, kpi, auto_value: val, manual_value: manual[kpi] == null ? null : +manual[kpi], contacts: kpiContacts[kpi] || null, computed_at: new Date().toISOString() });
    }
  }
  if (rows.length) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/st_shadow_metrics?on_conflict=member_id,metric_date,kpi', {
      method: 'POST',
      headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(rows),
    });
    if (r.status >= 300) throw new Error('upsert sombra falló: ' + r.status);
  }
  return { org_id: orgId, date, members: activos.length, rows: rows.length };
}

async function shadowRun(req, res, admin) {
  const parsed = await readJSONBody(req);
  const date = (parsed.ok && parsed.data && parsed.data.date) ? String(parsed.data.date) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, 400, { error: 'Fecha inválida (YYYY-MM-DD)' });
  const orgId = effectiveOrg(admin, parsed.ok && parsed.data && parsed.data.org_id);
  try {
    const summary = await runShadowForOrg(orgId, date);
    return sendJSON(res, 200, { ok: true, ...summary });
  } catch (e) {
    return sendJSON(res, 502, { error: 'La corrida sombra falló: ' + e.message });
  }
}

// Scheduler: cada 10 min revisa qué orgs están en su ventana 23:40–23:59 local
// y corre la sombra del día (una vez por org por fecha, control en memoria).
const shadowLastRun = new Map(); // orgId -> 'YYYY-MM-DD'
async function shadowTick() {
  try {
    const orgs = await svcGet('st_orgs?select=id,tz');
    for (const o of orgs) {
      const tz = o.tz || 'America/Argentina/Buenos_Aires';
      const now = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date());
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      const [hh, mm] = now.split(':').map(Number);
      if (hh === 23 && mm >= 40 && shadowLastRun.get(o.id) !== today) {
        shadowLastRun.set(o.id, today);
        runShadowForOrg(o.id, today).then((s) => console.log('[shadow]', o.id, s.rows, 'filas')).catch((e) => console.warn('[shadow]', o.id, e.message));
      }
    }
  } catch (e) { console.warn('[shadow] tick falló:', e.message); }
}
setInterval(shadowTick, 10 * 60 * 1000);

// ---------- Calendarios GHL de la org (Fase 2.3) ----------
// Devuelve DOS listas de la subcuenta GHL:
//  - `allCalendars`: TODOS los calendarios (para el multi-select de "agendas del
//    setter" — el setter agenda en cualquier calendario, no depende de closers).
//  - `calendars`: solo los atendidos por un closer YA sincronizado en el tracker
//    (para el "Calendario de llamadas" del closer, que asocia ventas).
// Recibe las creds ya resueltas (token vigente) y el org_id. Lanza Error en
// fallas de red/status (el caller responde 502/500 genérico).
async function listOrgCalendars(creds, orgId) {
  // a. Closers sincronizados de la org: activos (active null cuenta como activo,
  //    patrón existente) y con ghl_user_id. Map ghl_user_id -> nombre.
  const profRes = await fetch(
    SUPABASE_URL + '/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(orgId)
      + '&role=eq.closer&select=name,active,ghl_user_id',
    { headers: svcHeaders() }
  );
  if (profRes.status !== 200) throw new Error('No se pudieron leer los closers de la org');
  const profs = await profRes.json().catch(() => null);
  if (!Array.isArray(profs)) throw new Error('Respuesta inválida al leer los closers');
  const closerByGhlId = new Map();
  for (const p of profs) {
    if (p.active !== false && p.ghl_user_id) closerByGhlId.set(p.ghl_user_id, p.name);
  }

  // b. Calendarios de la subcuenta (misma versión de API que los events).
  //    SIEMPRE se traen: el multi-select de agenda los necesita todos, aunque
  //    la org no tenga closers sincronizados.
  const calRes = await ghlWithRetry(creds, (t) => fetch(
    GHL_BASE + '/calendars/?locationId=' + encodeURIComponent(creds.locationId),
    { headers: ghlHeaders(t, '2021-04-15') }
  ));
  if (calRes.status < 200 || calRes.status >= 300) {
    console.error(`[api] listOrgCalendars org=${orgId} ghl_fail status=${calRes.status}`);
    throw new Error('No se pudo hablar con HighLevel');
  }
  const body = await calRes.json().catch(() => ({}));
  const all = Array.isArray(body && body.calendars) ? body.calendars : [];

  // c. TODOS los calendarios (para agenda del setter): id/name, sin filtro.
  const allCalendars = all.filter((c) => c && c.id).map((c) => ({ id: c.id, name: c.name || 'Sin nombre' }));

  // d. Solo calendarios con algún closer sincronizado en teamMembers (para el
  //    "Calendario de llamadas"). Respuesta mínima: id/name/closers.
  const calendars = [];
  for (const c of all) {
    if (!c || !c.id || !Array.isArray(c.teamMembers)) continue;
    const closers = [];
    for (const tm of c.teamMembers) {
      const nombre = tm && closerByGhlId.get(tm.userId);
      if (nombre && !closers.includes(nombre)) closers.push(nombre);
    }
    if (!closers.length) continue;
    calendars.push({ id: c.id, name: c.name || 'Sin nombre', closers });
  }
  return { calendars, allCalendars, sinClosers: closerByGhlId.size === 0 };
}

// ---------- GET /api/ghl/calendars ----------
// Calendarios elegibles para "Calendario de llamadas" + el actualmente elegido.
// Solo admin. Nunca expone tokens ni datos de otras orgs.
async function listGhlCalendars(req, res, admin, url) {
  const orgId = effectiveOrg(admin, url.searchParams.get('org_id'));
  let creds;
  try {
    creds = await getGhlCreds(orgId);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo refrescar el acceso a GHL. Probá de nuevo.' });
  }
  if (!creds) return sendJSON(res, 409, { error: 'Conectá tu cuenta de HighLevel primero' });

  let listado;
  try {
    listado = await listOrgCalendars(creds, orgId);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel. Probá de nuevo.' });
  }

  // Calendarios de agenda del setter ya guardados (para que la UI marque los checkboxes).
  let agendaCalendarIds = [];
  try {
    const cfgRows = await svcGet('st_kpi_config?org_id=eq.' + encodeURIComponent(orgId) + '&kpi=eq._config&select=config');
    agendaCalendarIds = (cfgRows[0] && cfgRows[0].config && cfgRows[0].config.agenda_calendar_ids) || [];
  } catch { /* best-effort: si falla, la UI arranca sin marcados */ }

  const out = {
    calendars: listado.calendars,
    all_calendars: listado.allCalendars,
    selected: (creds.integration && creds.integration.calendar_id) || null,
    selected_name: (creds.integration && creds.integration.calendar_name) || null,
    agenda_calendar_ids: agendaCalendarIds,
  };
  if (listado.sinClosers) out.hint = 'Importá primero a tus closers desde Equipo desde HighLevel';
  console.log(`[api] GET /api/ghl/calendars admin=${admin.uid} org=${orgId} n=${listado.calendars.length} -> 200`);
  return sendJSON(res, 200, out);
}

// ---------- POST /api/integrations/ghl/calendar ----------
// Guarda (o desconfigura) el calendario de llamadas de la org. NUNCA confía en
// el body: el calendar_id se re-valida contra la lista filtrada server-side
// (closers de la org) y el calendar_name sale de la respuesta de GHL.
async function setGhlCalendar(req, res, admin) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'JSON inválido' });
  const raw = parsed.data && parsed.data.calendar_id;
  const calendarId = typeof raw === 'string' ? raw.trim() : '';

  // Desconfigurar: calendar_id vacío → limpiar y volver al fallback env.
  // Idempotente: ok aunque la org no tuviera fila en st_integrations.
  if (calendarId === '') {
    try {
      const patchRes = await fetch(
        SUPABASE_URL + '/rest/v1/st_integrations?org_id=eq.' + encodeURIComponent(admin.org_id),
        {
          method: 'PATCH',
          headers: svcHeaders({ 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ calendar_id: null, calendar_name: null, updated_at: new Date().toISOString() }),
        }
      );
      if (patchRes.status < 200 || patchRes.status >= 300) {
        return sendJSON(res, 500, { error: 'No se pudo guardar el calendario' });
      }
    } catch {
      return sendJSON(res, 500, { error: 'No se pudo guardar el calendario' });
    }
    leadsCache.delete(admin.org_id); // los leads cacheados eran del calendario anterior
    console.log(`[api] POST /api/integrations/ghl/calendar admin=${admin.uid} org=${admin.org_id} cleared -> 200`);
    return sendJSON(res, 200, { ok: true });
  }

  // Configurar: exige integración OAuth propia (el modo PIT no tiene fila donde
  // persistir; el calendario de una instancia dedicada se maneja por env).
  let creds;
  try {
    creds = await getGhlCreds(admin.org_id);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo refrescar el acceso a GHL. Probá de nuevo.' });
  }
  if (!creds) return sendJSON(res, 409, { error: 'Conectá tu cuenta de HighLevel primero' });
  if (!creds.integration) return sendJSON(res, 409, { error: 'Conectá tu cuenta de HighLevel primero' });

  let listado;
  try {
    listado = await listOrgCalendars(creds, admin.org_id);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel. Probá de nuevo.' });
  }
  const cal = listado.calendars.find((c) => c.id === calendarId);
  if (!cal) return sendJSON(res, 400, { error: 'Ese calendario no está disponible' });

  try {
    const patchRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_integrations?org_id=eq.' + encodeURIComponent(admin.org_id),
      {
        method: 'PATCH',
        headers: svcHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ calendar_id: cal.id, calendar_name: cal.name, updated_at: new Date().toISOString() }),
      }
    );
    if (patchRes.status < 200 || patchRes.status >= 300) {
      return sendJSON(res, 500, { error: 'No se pudo guardar el calendario' });
    }
  } catch {
    return sendJSON(res, 500, { error: 'No se pudo guardar el calendario' });
  }
  leadsCache.delete(admin.org_id); // los leads cacheados eran del calendario anterior
  console.log(`[api] POST /api/integrations/ghl/calendar admin=${admin.uid} org=${admin.org_id} saved -> 200`);
  return sendJSON(res, 200, { ok: true, calendar_name: cal.name });
}

// ---------- POST /api/integrations/ghl/agenda-calendars ----------
// Guarda los calendarios donde los SETTERS agendan llamadas (multi). Sus citas
// cuentan como "agendas" del setter en el motor. Distinto del "Calendario de
// llamadas" del closer (st_integrations.calendar_id), que se maneja aparte.
// NUNCA confía en el body: cada calendar_id se re-valida contra la lista real de
// la subcuenta (listOrgCalendars). Persiste en st_kpi_config._config sin pisar
// el resto de la config (booking_domains, etc.).
async function setGhlAgendaCalendars(req, res, admin) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'JSON inválido' });
  const raw = parsed.data && parsed.data.calendar_ids;
  if (!Array.isArray(raw)) return sendJSON(res, 400, { error: 'calendar_ids debe ser una lista' });
  const wanted = [...new Set(raw.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean))];

  // Validar cada ID contra los calendarios reales de la subcuenta (salvo lista vacía = limpiar).
  if (wanted.length) {
    let creds;
    try {
      creds = await getGhlCreds(admin.org_id);
    } catch {
      return sendJSON(res, 502, { error: 'No se pudo refrescar el acceso a GHL. Probá de nuevo.' });
    }
    if (!creds) return sendJSON(res, 409, { error: 'Conectá tu cuenta de HighLevel primero' });
    let listado;
    try {
      listado = await listOrgCalendars(creds, admin.org_id);
    } catch {
      return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel. Probá de nuevo.' });
    }
    const validIds = new Set((listado.allCalendars || []).map((c) => c.id));
    const invalid = wanted.filter((id) => !validIds.has(id));
    if (invalid.length) return sendJSON(res, 400, { error: 'Uno o más calendarios no están disponibles' });
  }

  // Merge en el _config existente (no pisar booking_domains ni otras claves).
  const cfgRows = await svcGet('st_kpi_config?org_id=eq.' + encodeURIComponent(admin.org_id) + '&kpi=eq._config&select=config');
  const current = (cfgRows[0] && cfgRows[0].config) || {};
  const merged = { ...current, agenda_calendar_ids: wanted };
  try {
    const upsertRes = await fetch(SUPABASE_URL + '/rest/v1/st_kpi_config?on_conflict=org_id,kpi', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ org_id: admin.org_id, kpi: '_config', config: merged }),
    });
    if (upsertRes.status < 200 || upsertRes.status >= 300) {
      return sendJSON(res, 500, { error: 'No se pudieron guardar los calendarios de agenda' });
    }
  } catch {
    return sendJSON(res, 500, { error: 'No se pudieron guardar los calendarios de agenda' });
  }
  console.log(`[api] POST /api/integrations/ghl/agenda-calendars admin=${admin.uid} org=${admin.org_id} n=${wanted.length} -> 200`);
  return sendJSON(res, 200, { ok: true, agenda_calendar_ids: wanted });
}

// ---------- POST /api/sales/ghl ----------
// Cierra el ciclo de la venta en GHL: custom fields de onboarding + tag disparador
// + oportunidad en el pipeline + aviso a Slack. Todo best-effort por paso.
// Los IDs de custom fields (GHL_CF) y del pipeline (GHL_PIPELINE) vienen por env;
// si faltan, el paso se saltea sin fallar.
async function salesGhl(req, res, member) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'JSON inválido' });
  const b = parsed.data || {};
  const orgId = effectiveOrg(member, b.org_id);

  let creds;
  try {
    creds = await getGhlCreds(orgId);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo refrescar el acceso a GHL. Probá de nuevo.' });
  }
  if (!creds) return sendJSON(res, 501, { error: 'GHL no está configurado en esta instancia' });

  const contactId = typeof b.contactId === 'string' ? b.contactId.trim() : '';
  if (!contactId) return sendJSON(res, 400, { error: 'Falta el contacto de GHL' });

  const fueReserva = !!b.fueReserva;
  const result = { customFields: false, tag: false, opportunity: false, slack: false };

  // a. Custom fields de onboarding en el contacto (se saltea si GHL_CF no está configurado).
  if (GHL_CF) {
    const cf = [];
    const push = (id, v) => { if (id && v !== undefined && v !== null && String(v).trim() !== '') cf.push({ id, value: String(v) }); };
    push(GHL_CF.montoTotal, b.facturado);
    push(GHL_CF.cantidadPagos, b.cuotas);
    push(GHL_CF.metodoPago, b.metodo);
    push(GHL_CF.programa, b.programa);
    push(GHL_CF.primerPago, b.primerPago);
    push(GHL_CF.vendedor, b.vendedor || member.name);
    push(GHL_CF.fueReserva, fueReserva ? 'Si' : 'No');
    if (fueReserva) push(GHL_CF.montoReserva, b.reserva);
    try {
      const upRes = await ghlWithRetry(creds, (t) => fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
        method: 'PUT', headers: ghlHeaders(t), body: JSON.stringify({ customFields: cf }),
      }));
      result.customFields = upRes.status >= 200 && upRes.status < 300;
    } catch { /* best-effort, se reporta en result */ }
  }

  // b. Tag disparador del onboarding (venta-cerrada) o del seguimiento de seña (reserva).
  const tag = fueReserva ? 'reserva' : 'venta-cerrada';
  try {
    const tagRes = await ghlWithRetry(creds, (t) => fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
      method: 'POST', headers: ghlHeaders(t), body: JSON.stringify({ tags: [tag] }),
    }));
    result.tag = tagRes.status >= 200 && tagRes.status < 300;
  } catch { /* idem */ }

  // c. Oportunidad en el pipeline de onboarding (se saltea si GHL_PIPELINE no está configurado).
  if (GHL_PIPELINE && GHL_PIPELINE.pipelineId) {
    try {
      const oppRes = await ghlWithRetry(creds, (t) => fetch(`${GHL_BASE}/opportunities/`, {
        method: 'POST', headers: ghlHeaders(t),
        body: JSON.stringify({
          locationId: creds.locationId,
          pipelineId: GHL_PIPELINE.pipelineId,
          pipelineStageId: fueReserva ? GHL_PIPELINE.stageReserva : GHL_PIPELINE.stagePago,
          contactId,
          name: `${b.clienteNombre || 'Cliente'} — ${b.programa || 'Programa'}`,
          status: 'open',
          monetaryValue: +b.facturado || 0,
        }),
      }));
      result.opportunity = oppRes.status >= 200 && oppRes.status < 300;
    } catch { /* best-effort */ }
  }

  // d. Aviso a Slack (best-effort; deep-link white-label: app.mazefunnels.com, NUNCA app.gohighlevel.com).
  if (SLACK_TOKEN && SLACK_WINS_CHANNEL) {
    try {
      const emoji = fueReserva ? ':lock:' : ':tada:';
      const tipo = fueReserva ? 'Reserva (seña)' : 'Venta cerrada';
      const monto = fueReserva ? (b.reserva || 0) : (b.cash || 0);
      const txt = `${emoji} *${tipo}:* ${b.clienteNombre || 'Cliente'} — *$${monto}* cash · ${b.programa || 's/programa'} · closer: ${b.vendedor || member.name}\n<https://app.mazefunnels.com/v2/location/${creds.locationId}/contacts/detail/${contactId}|Abrir contacto en GHL>`;
      const sRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: SLACK_WINS_CHANNEL, text: txt, unfurl_links: false }),
      });
      const sJson = await sRes.json().catch(() => ({}));
      result.slack = !!sJson.ok;
    } catch { /* idem */ }
  }

  console.log(`[api] POST /api/sales/ghl member=${member.uid} contact=${contactId} tag=${tag} cf=${result.customFields} slack=${result.slack}`);
  return sendJSON(res, 200, { ok: true, tag, ...result });
}

// ---------- POST /api/members ----------
async function createMember(req, res, admin) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'El cuerpo de la solicitud no es un JSON válido' });

  const body = parsed.data || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const role = typeof body.role === 'string' ? body.role.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // Validaciones (mensajes en español latino, tuteo).
  if (!name) return sendJSON(res, 400, { error: 'Tienes que poner un nombre' });
  if (!email) return sendJSON(res, 400, { error: 'Tienes que poner un email' });
  if (!password) return sendJSON(res, 400, { error: 'Tienes que poner una contraseña' });
  if (password.length < 8) return sendJSON(res, 400, { error: 'La contraseña tiene que tener al menos 8 caracteres' });
  if (!VALID_ROLES.includes(role)) return sendJSON(res, 400, { error: 'El rol tiene que ser setter, triage o closer' });

  // Enforcement team_mode: el rol tiene que estar permitido por el modo de equipo de la org.
  // org_id sale del perfil admin validado, NO del body (anti cross-org). El alta manual
  // siempre tiene ghl_user_id null → nunca es la vía de import GHL (esa queda exenta).
  const mode = await readTeamMode(admin.org_id);
  if (!roleAllowedForMode(role, mode)) {
    return sendJSON(res, 400, { error: 'Este rol no está disponible para el modo de equipo de tu agencia.' });
  }

  // a. Crear el auth user.
  let authRes, authUser;
  try {
    authRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: svcHeaders(),
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    authUser = await authRes.json().catch(() => ({}));
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo crear el usuario en el servidor de auth' });
  }

  if (authRes.status === 422 || authRes.status === 409 ||
      (authUser && /already|registered|exists|duplicate/i.test(JSON.stringify(authUser)))) {
    console.log(`[api] POST /api/members admin=${admin.uid} email_dup -> 409`);
    return sendJSON(res, 409, { error: 'Ya existe un usuario con ese email' });
  }
  if (authRes.status < 200 || authRes.status >= 300 || !authUser || !authUser.id) {
    console.log(`[api] POST /api/members admin=${admin.uid} auth_fail status=${authRes.status} -> 500`);
    return sendJSON(res, 500, { error: 'No se pudo crear el usuario. Inténtalo de nuevo.' });
  }

  const newUid = authUser.id;

  // b. Insertar el perfil.
  let profRes, profRows;
  try {
    profRes = await fetch(SUPABASE_URL + '/rest/v1/st_profiles', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ id: newUid, user_id: newUid, org_id: admin.org_id, name, role, commission: 0 }),
    });
    profRows = await profRes.json().catch(() => null);
  } catch {
    profRes = { status: 500 };
  }

  // c. Rollback si el insert del perfil falló: borrar el auth user para no dejar huérfanos.
  if (profRes.status < 200 || profRes.status >= 300) {
    try {
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(newUid), {
        method: 'DELETE',
        headers: svcHeaders(),
      });
    } catch { /* best-effort rollback */ }
    console.log(`[api] POST /api/members admin=${admin.uid} profile_fail rollback uid=${newUid} -> 500`);
    return sendJSON(res, 500, { error: 'No se pudo guardar el perfil del miembro. No se creó nada.' });
  }

  const created = Array.isArray(profRows) ? profRows[0] : profRows;
  console.log(`[api] POST /api/members admin=${admin.uid} created uid=${newUid} role=${role} -> 200`);
  return sendJSON(res, 200, created || { id: newUid, org_id: admin.org_id, name, role, commission: 0, active: true });
}

// ---------- DELETE /api/members/{id} ----------
async function deleteMember(req, res, admin, id) {
  if (!id) return sendJSON(res, 400, { error: 'Falta el id del miembro' });

  // Verificar que el perfil existe y pertenece al MISMO org que el admin (anti cross-tenant).
  let tgtRes, tgtRows;
  try {
    tgtRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(id) + '&select=org_id',
      { headers: svcHeaders() }
    );
    tgtRows = await tgtRes.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo leer el perfil del miembro' });
  }
  const target = Array.isArray(tgtRows) ? tgtRows[0] : null;
  if (!target || target.org_id !== admin.org_id) {
    return sendJSON(res, 404, { error: 'Ese miembro no pertenece a tu equipo' });
  }

  // Soft-delete: active=false (conserva histórico).
  try {
    const patchRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(id),
      { method: 'PATCH', headers: svcHeaders({ 'Prefer': 'return=minimal' }), body: JSON.stringify({ active: false }) }
    );
    if (patchRes.status < 200 || patchRes.status >= 300) {
      console.log(`[api] DELETE /api/members admin=${admin.uid} patch_fail id=${id} status=${patchRes.status} -> 500`);
      return sendJSON(res, 500, { error: 'No se pudo dar de baja al miembro' });
    }
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo dar de baja al miembro' });
  }

  // Banear el auth user para que no pueda loguearse.
  try {
    await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: svcHeaders(),
      body: JSON.stringify({ ban_duration: '87600h' }), // ~10 años
    });
  } catch { /* el soft-delete ya impide que aparezca en la UI; el ban es best-effort */ }

  console.log(`[api] DELETE /api/members admin=${admin.uid} deactivated id=${id} -> 200`);
  return sendJSON(res, 200, { ok: true });
}

// ---------- GET /api/oauth/start ----------
// Es una navegación del browser (no fetch), así que el JWT llega por query ?token=.
// Valida admin con la misma lógica que requireAdmin y redirige al chooselocation de GHL.
async function oauthStart(req, res, url) {
  if (!GHL_ENABLED) {
    return sendJSON(res, 503, { error: 'Integración GHL no configurada' });
  }
  const admin = await checkAdminToken(url.searchParams.get('token') || '');
  if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });

  const authUrl = 'https://marketplace.gohighlevel.com/oauth/chooselocation'
    + '?response_type=code'
    + '&redirect_uri=' + encodeURIComponent(GHL_REDIRECT_URI)
    + '&client_id=' + GHL_CLIENT_ID
    + '&scope=' + encodeURIComponent(GHL_SCOPES)
    + '&state=' + signState(admin.org_id);

  console.log(`[api] GET /api/oauth/start org=${admin.org_id} -> redirect a GHL`);
  return redirect(res, authUrl);
}

// ---------- GET /api/oauth/callback ----------
// Viene de GHL, sin sesión de usuario: la autenticidad la da el state firmado.
async function oauthCallback(req, res, url) {
  if (!GHL_ENABLED) {
    return sendJSON(res, 503, { error: 'Integración GHL no configurada' });
  }

  // 1. Verificar el state (firma HMAC + expiración de 10 min).
  const st = verifyState(url.searchParams.get('state'));
  if (!st.ok) {
    console.log('[api] GET /api/oauth/callback state_invalido -> redirect ghl_error=state');
    return redirect(res, PUBLIC_URL + '/?ghl_error=state');
  }
  const orgId = st.org;

  // 2. Code de autorización.
  const code = url.searchParams.get('code');
  if (!code) {
    console.log(`[api] GET /api/oauth/callback org=${orgId} sin_code -> redirect ghl_error=code`);
    return redirect(res, PUBLIC_URL + '/?ghl_error=code');
  }

  // 3. Intercambiar el code por tokens.
  let tok;
  try {
    const tokenRes = await fetch('https://services.leadconnectorhq.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GHL_CLIENT_ID,
        client_secret: GHL_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        user_type: 'Location',
        redirect_uri: GHL_REDIRECT_URI,
      }),
    });
    tok = await tokenRes.json().catch(() => ({}));
    if (tokenRes.status < 200 || tokenRes.status >= 300 || !tok.access_token || !tok.locationId) {
      console.error(`[api] GET /api/oauth/callback org=${orgId} token_fail status=${tokenRes.status}`);
      return redirect(res, PUBLIC_URL + '/?ghl_error=token');
    }
  } catch {
    console.error(`[api] GET /api/oauth/callback org=${orgId} token_fetch_fail`);
    return redirect(res, PUBLIC_URL + '/?ghl_error=token');
  }

  // 3b. Guard de pre-vínculo: si la org tiene una subcuenta pre-asignada y el
  // admin autorizó OTRA, NO se guarda nada — el pre-vínculo solo puede
  // completarse con la subcuenta asignada. Logs con IDs, jamás tokens.
  const existing = await getIntegration(orgId);
  if (existing && existing.location_id && existing.location_id !== tok.locationId) {
    console.log(`[api] GET /api/oauth/callback org=${orgId} location_mismatch esperada=${existing.location_id} autorizada=${tok.locationId} -> redirect ghl_error=location_mismatch`);
    return redirect(res, PUBLIC_URL + '/?ghl_error=location_mismatch');
  }

  // 4. Nombre de la subcuenta (best-effort: si falla, usamos el locationId).
  let locationName = tok.locationId;
  try {
    const locRes = await fetch('https://services.leadconnectorhq.com/locations/' + encodeURIComponent(tok.locationId), {
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Version': '2021-07-28' },
    });
    if (locRes.status >= 200 && locRes.status < 300) {
      const locBody = await locRes.json().catch(() => null);
      if (locBody && locBody.location && locBody.location.name) locationName = locBody.location.name;
    }
  } catch { /* best-effort: nunca abortar la conexión por el nombre */ }

  // 5. UPSERT de la integración (una por org).
  try {
    const upsertRes = await fetch(SUPABASE_URL + '/rest/v1/st_integrations?on_conflict=org_id', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify({
        org_id: orgId,
        provider: 'ghl',
        location_id: tok.locationId,
        location_name: locationName,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        token_expires_at: new Date(Date.now() + (tok.expires_in || 0) * 1000).toISOString(),
        company_id: tok.companyId || null,
        scopes: tok.scope || null,
        connected_by: null, // el callback no tiene sesión de usuario; el dato clave es org_id
        updated_at: new Date().toISOString(),
      }),
    });
    if (upsertRes.status < 200 || upsertRes.status >= 300) {
      console.error(`[api] GET /api/oauth/callback org=${orgId} save_fail status=${upsertRes.status}`);
      return redirect(res, PUBLIC_URL + '/?ghl_error=save');
    }
  } catch {
    console.error(`[api] GET /api/oauth/callback org=${orgId} save_fetch_fail`);
    return redirect(res, PUBLIC_URL + '/?ghl_error=save');
  }

  console.log(`[api] GET /api/oauth/callback org=${orgId} location=${tok.locationId} -> connected`);
  return redirect(res, PUBLIC_URL + '/?ghl=connected');
}

// ---------- GET /api/integrations/ghl ----------
// Estado de conexión para la UI. El access_token se lee SOLO server-side para
// distinguir pending (fila pre-vinculada sin tokens) de conectada — JAMÁS
// viaja en la respuesta.
async function getGhlStatus(req, res, admin, url) {
  const orgId = effectiveOrg(admin, url.searchParams.get('org_id'));
  let rows;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_integrations?org_id=eq.' + encodeURIComponent(orgId)
        + '&select=location_id,location_name,created_at,access_token',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) {
      return sendJSON(res, 500, { error: 'No se pudo leer el estado de la integración' });
    }
    rows = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo leer el estado de la integración' });
  }

  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return sendJSON(res, 200, { connected: false });
  // Fila sin access_token = subcuenta pre-asignada, falta autorizar (pending).
  if (!row.access_token) {
    return sendJSON(res, 200, {
      connected: false,
      pending: true,
      location_id: row.location_id,
      location_name: row.location_name,
    });
  }
  return sendJSON(res, 200, {
    connected: true,
    location_id: row.location_id,
    location_name: row.location_name,
    connected_at: row.created_at,
  });
}

// ---------- DELETE /api/integrations/ghl ----------
// Desconecta la integración de la org. Idempotente: ok aunque no hubiera fila.
async function disconnectGhl(req, res, admin) {
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_integrations?org_id=eq.' + encodeURIComponent(admin.org_id),
      { method: 'DELETE', headers: svcHeaders({ 'Prefer': 'return=minimal' }) }
    );
    if (r.status < 200 || r.status >= 300) {
      console.log(`[api] DELETE /api/integrations/ghl admin=${admin.uid} fail status=${r.status} -> 500`);
      return sendJSON(res, 500, { error: 'No se pudo desconectar la integración' });
    }
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo desconectar la integración' });
  }
  console.log(`[api] DELETE /api/integrations/ghl admin=${admin.uid} org=${admin.org_id} -> 200`);
  return sendJSON(res, 200, { ok: true });
}

// ---------- Helpers de usuarios GHL ----------
// Trae la lista de usuarios de la subcuenta GHL con un access_token vigente.
// Excluye los deleted (a efectos de status Y de reconciliación cuentan como
// "no están en GHL"). Lanza Error si no se pudo hablar con HighLevel.
async function fetchGhlUsers(integration) {
  const token = await refreshGhlToken(integration); // lanza si el refresh falla
  const creds = { token, integration }; // para el retry-on-401 del helper compartido
  const r = await ghlWithRetry(creds, (t) => fetch(
    'https://services.leadconnectorhq.com/users/?locationId=' + encodeURIComponent(integration.location_id),
    { headers: { 'Authorization': 'Bearer ' + t, 'Version': '2021-07-28' } }
  ));
  if (r.status < 200 || r.status >= 300) {
    console.error(`[api] fetchGhlUsers org=${integration.org_id} fail status=${r.status}`);
    throw new Error('No se pudo hablar con HighLevel');
  }
  const body = await r.json().catch(() => ({}));
  const all = Array.isArray(body && body.users) ? body.users : [];
  return all.filter((u) => u && u.id && u.deleted !== true);
}

// Email de un auth user vía GoTrue admin, normalizado (lowercase + trim) y
// cacheado por request (Map uid -> email|null). Equipos chicos: pocas llamadas.
async function getAuthEmail(uid, cache) {
  if (cache.has(uid)) return cache.get(uid);
  let email = null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(uid), {
      headers: svcHeaders(),
    });
    if (r.status >= 200 && r.status < 300) {
      const u = await r.json().catch(() => null);
      if (u && typeof u.email === 'string') email = u.email.toLowerCase().trim();
    }
  } catch { /* best-effort: sin email no hay match posible */ }
  cache.set(uid, email);
  return email;
}

// Busca un auth user por email EXACTO vía GoTrue admin. Se usa listado paginado
// + filtro client-side (y no el query `?filter=`) porque ese filtro depende de
// la versión de GoTrue y no está garantizado en self-hosted. `emailNorm` llega
// ya normalizado (lowercase + trim). Recorre hasta 10 páginas de 100 y corta al
// encontrar. Cualquier error de red/status → null (el caller responde genérico).
async function findAuthUserByEmail(emailNorm) {
  for (let page = 1; page <= 10; page++) {
    let body;
    try {
      const r = await fetch(
        SUPABASE_URL + '/auth/v1/admin/users?page=' + page + '&per_page=100',
        { headers: svcHeaders() }
      );
      if (r.status < 200 || r.status >= 300) return null;
      body = await r.json().catch(() => null);
    } catch {
      return null;
    }
    const users = body && Array.isArray(body.users) ? body.users : [];
    const match = users.find((u) => u && typeof u.email === 'string' && u.email.toLowerCase().trim() === emailNorm);
    if (match) return match;
    if (users.length < 100) return null; // página incompleta o vacía: no hay más
  }
  return null;
}

// Nombre legible de un usuario GHL (name, o firstName + lastName).
function ghlUserName(u) {
  return u.name || [u.firstName, u.lastName].filter(Boolean).join(' ');
}

// Da de baja UN perfil de la org: soft-delete SIEMPRE (active=false, scoped a
// la org — no toca otras orgs) y ban en GoTrue SOLO si el auth user detrás no
// tiene NINGÚN OTRO perfil activo en NINGUNA otra org. El GoTrue es COMPARTIDO
// entre orgs y entre apps (tracker, CallIQ, etc.): banear sin este chequeo
// saca a la persona del login de TODO por una reconciliación de una sola org.
// `authUid` = p.user_id (columna del auth uid desde la migración 013, donde
// `st_profiles.id` pasó a ser gen_random_uuid()); fallback a p.id para
// perfiles viejos donde user_id vino null (ahí id==user_id por construcción).
// Fail-safe: si el chequeo cross-org falla por red, NO se banea (mejor un ban
// de menos que sacarle a alguien el acceso a otra org/app por error).
// Devuelve true si el soft-delete se aplicó (el caller lo cuenta como
// "removido" de esta org); el ban es best-effort y no cambia el resultado.
async function bajaPerfil(p, orgId, motivo) {
  try {
    const patchRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(p.id),
      { method: 'PATCH', headers: svcHeaders({ 'Prefer': 'return=minimal' }), body: JSON.stringify({ active: false }) }
    );
    if (patchRes.status < 200 || patchRes.status >= 300) {
      console.error(`[api] GET /api/ghl/users org=${orgId} baja_fail id=${p.id} status=${patchRes.status}`);
      return false;
    }
  } catch {
    console.error(`[api] GET /api/ghl/users org=${orgId} baja_fetch_fail id=${p.id}`);
    return false;
  }
  p.active = false; // consistencia del objeto local con la DB

  const authUid = p.user_id || p.id;
  let otherActive = true; // fail-safe: ante duda (error de red) NO banear
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?user_id=eq.' + encodeURIComponent(authUid)
        + '&org_id=neq.' + encodeURIComponent(orgId)
        + '&active=eq.true&select=id&limit=1',
      { headers: svcHeaders() }
    );
    if (r.status === 200) {
      const rows = await r.json().catch(() => null);
      otherActive = Array.isArray(rows) && rows.length > 0;
    }
  } catch { /* otherActive queda true: fail-safe, no banear */ }

  if (otherActive) {
    console.log(`[api] GET /api/ghl/users org=${orgId} baja_sin_ban id=${p.id} name=${p.name} ${motivo} (tiene perfiles activos en otra org, GoTrue es compartido)`);
  } else {
    try {
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(authUid), {
        method: 'PUT',
        headers: svcHeaders(),
        body: JSON.stringify({ ban_duration: '87600h' }), // ~10 años
      });
    } catch { /* best-effort: el soft-delete ya lo saca de la UI */ }
    console.log(`[api] GET /api/ghl/users org=${orgId} baja_auto id=${p.id} name=${p.name} ${motivo}`);
  }
  return true;
}

// ---------- GET /api/ghl/users ----------
// Lista los usuarios de la subcuenta GHL de la org con su estado respecto del
// tracker (nuevo / vinculable / importado / inactivo) y reconcilia TOTAL: con
// GHL conectado, GHL es la única fuente de verdad del equipo no-admin.
//   1. Auto-link: perfil activo sin ghl_user_id cuyo email coincide exacto con
//      un usuario GHL → se vincula (solo ghl_user_id) y sale "importado".
//   2. Huérfanos manuales: perfil activo no-admin que quedó sin ghl_user_id
//      tras el auto-link → baja automática (active=false + ban).
//   3. Desvinculados: perfil importado cuyo usuario ya no está en la subcuenta
//      (o figura deleted) → baja automática (active=false + ban).
// Los perfiles con role='admin' NUNCA se dan de baja automáticamente.
async function listGhlUsers(req, res, admin, url) {
  const orgId = effectiveOrg(admin, url.searchParams.get('org_id'));
  const integration = await getIntegration(orgId);
  // Una fila pending (sin access_token) todavía no puede listar usuarios.
  if (!integration || !integration.access_token) return sendJSON(res, 409, { error: 'Conectá tu cuenta de HighLevel primero' });

  let ghlUsers;
  try {
    ghlUsers = await fetchGhlUsers(integration);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel. Probá de nuevo.' });
  }

  // Perfiles de la org (filtrado manual por org_id: la service key bypassea RLS).
  let profs;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(orgId)
        + '&select=id,name,role,active,ghl_user_id,user_id',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return sendJSON(res, 500, { error: 'No se pudieron leer los perfiles del equipo' });
    profs = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudieron leer los perfiles del equipo' });
  }
  if (!Array.isArray(profs)) profs = [];

  // Emails SOLO de los perfiles sin ghl_user_id (para detectar "vinculable").
  // authUid: desde la migración 013 el uid de auth vive en `user_id`, no en
  // `id` (que ahora es gen_random_uuid()); fallback a `id` para perfiles
  // viejos donde `user_id` vino null.
  const emailCache = new Map();
  const emailToProfile = new Map();
  for (const p of profs) {
    if (p.ghl_user_id) continue;
    const email = await getAuthEmail(p.user_id || p.id, emailCache);
    if (email && !emailToProfile.has(email)) emailToProfile.set(email, p);
  }

  const byGhlId = new Map();
  for (const p of profs) { if (p.ghl_user_id) byGhlId.set(p.ghl_user_id, p); }

  // Reconciliación total — paso 1: auto-vincular por email exacto. Un perfil
  // activo sin ghl_user_id cuyo email (GoTrue admin, nunca el body del cliente)
  // coincide con un usuario GHL se vincula automáticamente: se setea SOLO
  // ghl_user_id (role/name/active/contraseña intactos). Corre ANTES del map de
  // `users` para que los recién vinculados salgan "importado", no "vinculable".
  const auto_linked = [];
  for (const u of ghlUsers) {
    const email = typeof u.email === 'string' ? u.email.toLowerCase().trim() : null;
    if (!email) continue;
    if (byGhlId.has(u.id)) continue; // ese ghl_user_id ya está tomado por otro perfil
    const p = emailToProfile.get(email);
    if (!p || p.ghl_user_id || p.active === false) continue;
    try {
      const patchRes = await fetch(
        SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(p.id),
        { method: 'PATCH', headers: svcHeaders({ 'Prefer': 'return=minimal' }), body: JSON.stringify({ ghl_user_id: u.id }) }
      );
      if (patchRes.status < 200 || patchRes.status >= 300) {
        console.error(`[api] GET /api/ghl/users org=${orgId} autolink_fail id=${p.id} status=${patchRes.status}`);
        continue;
      }
    } catch {
      console.error(`[api] GET /api/ghl/users org=${orgId} autolink_fetch_fail id=${p.id}`);
      continue;
    }
    p.ghl_user_id = u.id;
    byGhlId.set(u.id, p);
    emailToProfile.delete(email);
    auto_linked.push(p.name);
    console.log(`[api] GET /api/ghl/users org=${orgId} autolink id=${p.id} name=${p.name} ghl_user_id=${u.id}`);
  }

  // Estado de cada usuario GHL respecto del tracker.
  const users = ghlUsers.map((u) => {
    const email = typeof u.email === 'string' ? u.email.toLowerCase().trim() : null;
    const linked = byGhlId.get(u.id);
    let status = 'nuevo';
    if (linked) status = linked.active === false ? 'inactivo' : 'importado';
    else if (email && emailToProfile.has(email)) status = 'vinculable';
    return {
      ghl_user_id: u.id,
      name: ghlUserName(u),
      email: u.email || null,
      ghl_role: (u.roles && u.roles.role) || null,
      status,
    };
  });

  const ghlIds = new Set(ghlUsers.map((u) => u.id));
  const removed = [];

  // Reconciliación total — paso 2: huérfanos manuales. Con GHL conectado, todo
  // perfil activo no-admin que quedó sin ghl_user_id tras el auto-link no existe
  // en la subcuenta → baja automática (mismo patrón PATCH+ban del paso 3).
  // EXCEPCIÓN INAMOVIBLE: los perfiles con role='admin' NUNCA se dan de baja acá
  // — el admin de la org puede no ser usuario de la subcuenta GHL; sin esta
  // excepción el dueño se bloquearía a sí mismo al conectar. Corre DESPUÉS del
  // map de `users`: los huérfanos manuales no aparecen en la lista GHL.
  for (const p of profs) {
    const orphan = p.active !== false && !p.ghl_user_id && p.role !== 'admin';
    if (!orphan) continue;
    const ok = await bajaPerfil(p, orgId, '(huérfano manual con GHL conectado)');
    if (!ok) continue;
    removed.push(p.name);
  }

  // Reconciliación — paso 3, GHL manda (D-04): perfiles importados activos cuyo
  // usuario ya no está en la subcuenta (o figura deleted) → baja automática.
  for (const p of profs) {
    if (!p.ghl_user_id || p.active === false || ghlIds.has(p.ghl_user_id)) continue;
    const ok = await bajaPerfil(p, orgId, '(ya no está en GHL)');
    if (!ok) continue;
    removed.push(p.name);
  }

  console.log(`[api] GET /api/ghl/users admin=${admin.uid} users=${users.length} removed=${removed.length} auto_linked=${auto_linked.length} -> 200`);
  // access_code = Location ID (D-03: contraseña inicial del equipo). NUNCA tokens.
  // auto_linked/removed llevan solo nombres — jamás tokens ni emails de auth.
  return sendJSON(res, 200, { access_code: integration.location_id, users, removed, auto_linked });
}

// ---------- POST /api/ghl/users/import ----------
// Importa un usuario de la subcuenta GHL como miembro del tracker. NUNCA confía
// en name/email del body: re-consulta la lista GHL server-side y toma los datos
// reales de ahí. Según el caso: reactiva, vincula o crea.
const GHL_IMPORT_ROLES = ['setter', 'triage', 'closer', 'admin'];
async function importGhlUser(req, res, admin) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'El cuerpo de la solicitud no es un JSON válido' });
  const body = parsed.data || {};
  const orgId = effectiveOrg(admin, body.org_id);
  const ghlUserId = typeof body.ghl_user_id === 'string' ? body.ghl_user_id.trim() : '';
  const role = typeof body.role === 'string' ? body.role.trim() : '';
  if (!ghlUserId) return sendJSON(res, 400, { error: 'Falta el usuario de HighLevel a importar' });
  // Acá 'admin' SÍ es un rol válido (distinto de /api/members): se puede importar un admin.
  if (!GHL_IMPORT_ROLES.includes(role)) return sendJSON(res, 400, { error: 'El rol tiene que ser setter, triage, closer o admin' });

  const integration = await getIntegration(orgId);
  // Una fila pending (sin access_token) todavía no puede importar usuarios.
  if (!integration || !integration.access_token) return sendJSON(res, 409, { error: 'Conectá tu cuenta de HighLevel primero' });

  let ghlUsers;
  try {
    ghlUsers = await fetchGhlUsers(integration);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel. Probá de nuevo.' });
  }

  const ghlUser = ghlUsers.find((u) => u.id === ghlUserId);
  if (!ghlUser) return sendJSON(res, 404, { error: 'Ese usuario ya no está en HighLevel' });
  const name = ghlUserName(ghlUser);
  const email = typeof ghlUser.email === 'string' ? ghlUser.email.trim() : '';
  if (!email) return sendJSON(res, 400, { error: 'Ese usuario no tiene email en HighLevel' });

  // Perfiles de la org (para decidir: reactivar / vincular / crear).
  let profs;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(orgId)
        + '&select=id,name,role,active,ghl_user_id',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return sendJSON(res, 500, { error: 'No se pudieron leer los perfiles del equipo' });
    profs = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudieron leer los perfiles del equipo' });
  }
  if (!Array.isArray(profs)) profs = [];

  // a. Ya existe un perfil de la org con ese ghl_user_id.
  const existing = profs.find((p) => p.ghl_user_id === ghlUserId);
  if (existing && existing.active !== false) {
    return sendJSON(res, 409, { error: 'Ya está importado' });
  }
  if (existing) {
    // Reactivar: active=true + unban del auth user.
    try {
      const patchRes = await fetch(
        SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(existing.id),
        { method: 'PATCH', headers: svcHeaders({ 'Prefer': 'return=minimal' }), body: JSON.stringify({ active: true }) }
      );
      if (patchRes.status < 200 || patchRes.status >= 300) {
        return sendJSON(res, 500, { error: 'No se pudo reactivar al miembro' });
      }
    } catch {
      return sendJSON(res, 502, { error: 'No se pudo reactivar al miembro' });
    }
    try {
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(existing.id), {
        method: 'PUT',
        headers: svcHeaders(),
        body: JSON.stringify({ ban_duration: 'none' }),
      });
    } catch { /* best-effort unban */ }
    console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} reactivated id=${existing.id} ghl=${ghlUserId} -> 200`);
    return sendJSON(res, 200, { ok: true, reactivated: true });
  }

  // b. Perfil manual (sin ghl_user_id) con el mismo email → vincular sin tocar
  //    su contraseña ni el auth user: solo se agrega el ghl_user_id.
  const emailCache = new Map();
  const emailLower = email.toLowerCase();
  for (const p of profs) {
    if (p.ghl_user_id) continue;
    const pEmail = await getAuthEmail(p.id, emailCache);
    if (pEmail && pEmail === emailLower) {
      try {
        const patchRes = await fetch(
          SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(p.id),
          { method: 'PATCH', headers: svcHeaders({ 'Prefer': 'return=minimal' }), body: JSON.stringify({ ghl_user_id: ghlUserId }) }
        );
        if (patchRes.status < 200 || patchRes.status >= 300) {
          return sendJSON(res, 500, { error: 'No se pudo vincular al miembro' });
        }
      } catch {
        return sendJSON(res, 502, { error: 'No se pudo vincular al miembro' });
      }
      console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} linked id=${p.id} ghl=${ghlUserId} -> 200`);
      return sendJSON(res, 200, { ok: true, linked: true });
    }
  }

  // c. Crear: auth user con el Location ID como contraseña inicial (D-03).
  let authRes, authUser;
  try {
    authRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: svcHeaders(),
      body: JSON.stringify({ email, password: integration.location_id, email_confirm: true }),
    });
    authUser = await authRes.json().catch(() => ({}));
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo crear el usuario en el servidor de auth' });
  }
  if (authRes.status === 422 || authRes.status === 409 ||
      (authUser && /already|registered|exists|duplicate/i.test(JSON.stringify(authUser)))) {
    // El GoTrue es COMPARTIDO entre apps (tracker, CallIQ, etc.): que el email
    // ya exista en auth.users NO significa "otra organización del tracker".
    // Resolver contra el auth user real: vincular, rechazar o adoptar.
    const emailNorm = email.toLowerCase().trim();
    const existingAuth = await findAuthUserByEmail(emailNorm);
    if (!existingAuth || !existingAuth.id) {
      // Respuesta genérica: no filtrar información del auth compartido.
      console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} email_dup_sin_match -> 500`);
      return sendJSON(res, 500, { error: 'No se pudo crear el usuario. Inténtalo de nuevo.' });
    }
    const uid = existingAuth.id;

    // Multi-cuenta: buscar el perfil del login EN ESTA org (puede tener otros en otras orgs).
    let dupProf;
    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/st_profiles?user_id=eq.' + encodeURIComponent(uid)
          + '&org_id=eq.' + encodeURIComponent(orgId)
          + '&select=id,org_id,name,active,ghl_user_id',
        { headers: svcHeaders() }
      );
      if (r.status !== 200) return sendJSON(res, 502, { error: 'No se pudieron leer los perfiles del equipo' });
      const rows = await r.json().catch(() => null);
      dupProf = Array.isArray(rows) ? rows[0] : null;
    } catch {
      return sendJSON(res, 502, { error: 'No se pudieron leer los perfiles del equipo' });
    }

    // Sin perfil en ESTA org → crear la MEMBRESÍA (la cuenta puede vivir en otros equipos).
    if (!dupProf) {
      try {
        const insRes = await fetch(SUPABASE_URL + '/rest/v1/st_profiles', {
          method: 'POST',
          headers: svcHeaders({ 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ user_id: uid, org_id: orgId, name, role, commission: 0, ghl_user_id: ghlUserId }),
        });
        if (insRes.status >= 300) return sendJSON(res, 502, { error: 'No se pudo crear la membresía' });
      } catch {
        return sendJSON(res, 502, { error: 'No se pudo crear la membresía' });
      }
      console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} membresia_nueva uid=${uid} -> 200`);
      return sendJSON(res, 200, { ok: true, existing_account: true });
    }

    // Perfil en ESTA org → vincular (y reactivar + unban si estaba inactivo).
    if (dupProf) {
      const patch = { ghl_user_id: ghlUserId };
      if (!dupProf.name) patch.name = name;
      if (dupProf.active === false) patch.active = true;
      try {
        const patchRes = await fetch(
          SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(dupProf.id),
          { method: 'PATCH', headers: svcHeaders({ 'Prefer': 'return=minimal' }), body: JSON.stringify(patch) }
        );
        if (patchRes.status < 200 || patchRes.status >= 300) {
          return sendJSON(res, 500, { error: 'No se pudo vincular al miembro' });
        }
      } catch {
        return sendJSON(res, 500, { error: 'No se pudo vincular al miembro' });
      }
      if (dupProf.active === false) {
        try {
          await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(uid), {
            method: 'PUT',
            headers: svcHeaders(),
            body: JSON.stringify({ ban_duration: 'none' }),
          });
        } catch { /* best-effort unban */ }
      }
      console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} email_dup_linked id=${uid} ghl=${ghlUserId} -> 200`);
      return sendJSON(res, 200, { ok: true, linked: true });
    }

    // Sin perfil en NINGUNA org (cuenta de otra app del auth compartido) →
    // adoptar: crear el st_profile sobre el uid existente. CRÍTICO:
    // (1) JAMÁS tocar la contraseña ni ningún atributo del auth user — es una
    //     cuenta viva de otra app del mismo auth;
    // (2) si el INSERT falla, NO borrar el auth user — el rollback DELETE
    //     aplica solo a auth users recién creados por este endpoint.
    let adoptRes, adoptRows;
    try {
      adoptRes = await fetch(SUPABASE_URL + '/rest/v1/st_profiles', {
        method: 'POST',
        headers: svcHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify({ id: uid, user_id: uid, org_id: orgId, name, role, ghl_user_id: ghlUserId, commission: 0 }),
      });
      adoptRows = await adoptRes.json().catch(() => null);
    } catch {
      adoptRes = { status: 500 };
    }
    if (adoptRes.status < 200 || adoptRes.status >= 300) {
      console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} email_dup_profile_fail uid=${uid} -> 500`);
      return sendJSON(res, 500, { error: 'No se pudo guardar el perfil del miembro.' });
    }
    const adopted = Array.isArray(adoptRows) ? adoptRows[0] : adoptRows;
    console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} email_dup_adopted uid=${uid} role=${role} ghl=${ghlUserId} -> 200`);
    return sendJSON(res, 200, {
      ...(adopted || { id: uid, org_id: orgId, name, role, ghl_user_id: ghlUserId, commission: 0, active: true }),
      existing_account: true,
    });
  }
  if (authRes.status < 200 || authRes.status >= 300 || !authUser || !authUser.id) {
    console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} auth_fail status=${authRes.status} -> 500`);
    return sendJSON(res, 500, { error: 'No se pudo crear el usuario. Inténtalo de nuevo.' });
  }
  const newUid = authUser.id;

  // Insertar el perfil, con el mismo rollback que createMember si falla.
  let profRes, profRows;
  try {
    profRes = await fetch(SUPABASE_URL + '/rest/v1/st_profiles', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ id: newUid, user_id: newUid, org_id: orgId, name, role, ghl_user_id: ghlUserId, commission: 0 }),
    });
    profRows = await profRes.json().catch(() => null);
  } catch {
    profRes = { status: 500 };
  }
  if (profRes.status < 200 || profRes.status >= 300) {
    try {
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(newUid), {
        method: 'DELETE',
        headers: svcHeaders(),
      });
    } catch { /* best-effort rollback */ }
    console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} profile_fail rollback uid=${newUid} -> 500`);
    return sendJSON(res, 500, { error: 'No se pudo guardar el perfil del miembro. No se creó nada.' });
  }

  const created = Array.isArray(profRows) ? profRows[0] : profRows;
  console.log(`[api] POST /api/ghl/users/import admin=${admin.uid} created uid=${newUid} role=${role} ghl=${ghlUserId} -> 200`);
  return sendJSON(res, 200, created || { id: newUid, org_id: orgId, name, role, ghl_user_id: ghlUserId, commission: 0, active: true });
}

// ---------- POST /api/me/password ----------
// Cualquier usuario logueado cambia SU propia contraseña. El uid sale del JWT
// validado, jamás del body (nadie puede cambiar la contraseña de otro). Se hace
// server-side para no depender del flujo de re-auth del cliente.
async function changeMyPassword(req, res, usr) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'El cuerpo de la solicitud no es un JSON válido' });
  const body = parsed.data || {};
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) return sendJSON(res, 400, { error: 'La contraseña tiene que tener al menos 8 caracteres' });

  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(usr.uid), {
      method: 'PUT',
      headers: svcHeaders(),
      body: JSON.stringify({ password }),
    });
    if (r.status < 200 || r.status >= 300) {
      console.log(`[api] POST /api/me/password uid=${usr.uid} fail status=${r.status} -> 500`);
      return sendJSON(res, 500, { error: 'No se pudo cambiar la contraseña. Inténtalo de nuevo.' });
    }
  } catch {
    return sendJSON(res, 500, { error: 'No se pudo cambiar la contraseña. Inténtalo de nuevo.' });
  }

  console.log(`[api] POST /api/me/password uid=${usr.uid} -> 200`);
  return sendJSON(res, 200, { ok: true });
}

// ---------- GET /api/orgs ----------
// Lista todas las organizaciones del tracker con miembros activos, estado GHL
// y emails de sus admins. SOLO super-admins (requireSuperAdmin). De
// st_integrations se leen SOLO org_id y location_name — tokens jamás.
async function listOrgs(req, res, sa) {
  let orgs, profs, integrations;
  try {
    const orgsRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_orgs?select=id,name,created_at&order=created_at.asc',
      { headers: svcHeaders() }
    );
    if (orgsRes.status !== 200) return sendJSON(res, 500, { error: 'No se pudieron leer las organizaciones' });
    orgs = await orgsRes.json().catch(() => null);

    const profsRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?select=id,org_id,role,active',
      { headers: svcHeaders() }
    );
    if (profsRes.status !== 200) return sendJSON(res, 500, { error: 'No se pudieron leer las organizaciones' });
    profs = await profsRes.json().catch(() => null);

    const intsRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_integrations?select=org_id,location_name',
      { headers: svcHeaders() }
    );
    if (intsRes.status !== 200) return sendJSON(res, 500, { error: 'No se pudieron leer las organizaciones' });
    integrations = await intsRes.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudieron leer las organizaciones' });
  }
  if (!Array.isArray(orgs)) orgs = [];
  if (!Array.isArray(profs)) profs = [];
  if (!Array.isArray(integrations)) integrations = [];

  // Agrupar en memoria: perfiles por org + integración por org.
  const profsByOrg = new Map();
  for (const p of profs) {
    if (!profsByOrg.has(p.org_id)) profsByOrg.set(p.org_id, []);
    profsByOrg.get(p.org_id).push(p);
  }
  const intByOrg = new Map();
  for (const i of integrations) intByOrg.set(i.org_id, i);

  // Emails de admins vía GoTrue admin con UN cache compartido para todo el
  // request (pocas orgs: N+1 aceptable).
  const emailCache = new Map();
  const out = [];
  for (const o of orgs) {
    const orgProfs = profsByOrg.get(o.id) || [];
    const admins = [];
    for (const p of orgProfs) {
      if (p.role !== 'admin') continue;
      const email = await getAuthEmail(p.id, emailCache);
      if (email) admins.push(email);
    }
    const integ = intByOrg.get(o.id) || null;
    out.push({
      id: o.id,
      name: o.name,
      created_at: o.created_at,
      members_active: orgProfs.filter((p) => p.active !== false).length,
      ghl_connected: !!integ,
      ghl_location_name: (integ && integ.location_name) || null,
      admins,
    });
  }

  console.log(`[api] GET /api/orgs super=${sa.email} n=${out.length} -> 200`);
  return sendJSON(res, 200, { orgs: out });
}

// ---------- Helper compartido: alta/adopción del admin de una org ----------
// Fuente única de verdad para dar de alta un admin (POST /api/orgs y
// POST /api/orgs/{orgId}/admins). Resuelve el auth user (crear en GoTrue con
// email_confirm; si el email ya existe en el auth COMPARTIDO → adoptar la
// cuenta SIN tocar su contraseña, salvo que tenga perfil en alguna org del
// tracker → 409) e inserta el perfil admin en la org. Si el INSERT del perfil
// falla, borra el auth user SOLO si lo creó este helper (jamás una cuenta
// adoptada). NO rollbackea la org: eso es responsabilidad del caller.
// Passwords JAMÁS en logs.
// Retorno: {ok:true, uid, createdAuth, existingAccount} | {ok:false, status, error}
async function provisionOrgAdmin({ orgId, name, email, password }, logTag) {
  const emailNorm = email.toLowerCase().trim();
  let uid, createdAuth, existingAccount;

  // 1. Intentar crear el auth user.
  let authRes, authUser;
  try {
    authRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: svcHeaders(),
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    authUser = await authRes.json().catch(() => ({}));
  } catch {
    return { ok: false, status: 502, error: 'No se pudo crear el usuario en el servidor de auth' };
  }

  if (authRes.status === 422 || authRes.status === 409 ||
      (authUser && /already|registered|exists|duplicate/i.test(JSON.stringify(authUser)))) {
    // El GoTrue es COMPARTIDO entre apps: que el email exista NO implica una
    // org del tracker. Resolver contra el auth user real.
    const existingAuth = await findAuthUserByEmail(emailNorm);
    if (!existingAuth || !existingAuth.id) {
      // Respuesta genérica: no filtrar información del auth compartido.
      console.log(`[api] ${logTag} email_dup_sin_match -> 500`);
      return { ok: false, status: 500, error: 'No se pudo crear el usuario. Inténtalo de nuevo.' };
    }

    // ¿Tiene perfil en ALGUNA org del tracker? → conflicto real.
    let dupProf;
    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(existingAuth.id) + '&select=id,org_id',
        { headers: svcHeaders() }
      );
      if (r.status !== 200) return { ok: false, status: 500, error: 'No se pudo crear el usuario. Inténtalo de nuevo.' };
      const rows = await r.json().catch(() => null);
      dupProf = Array.isArray(rows) ? rows[0] : null;
    } catch {
      return { ok: false, status: 502, error: 'No se pudo crear el usuario. Inténtalo de nuevo.' };
    }
    if (dupProf) {
      console.log(`[api] ${logTag} email_dup_otra_org -> 409`);
      return { ok: false, status: 409, error: 'Ese email ya pertenece a otro equipo del tracker' };
    }

    // Sin perfil en ninguna org → adoptar la cuenta (de otra app del auth
    // compartido). JAMÁS tocar su contraseña ni ningún atributo del auth user.
    uid = existingAuth.id;
    createdAuth = false;
    existingAccount = true;
  } else if (authRes.status < 200 || authRes.status >= 300 || !authUser || !authUser.id) {
    console.log(`[api] ${logTag} auth_fail status=${authRes.status} -> 500`);
    return { ok: false, status: 500, error: 'No se pudo crear el usuario. Inténtalo de nuevo.' };
  } else {
    uid = authUser.id;
    createdAuth = true;
    existingAccount = false;
  }

  // 2. Crear el perfil admin en la org.
  let profRes;
  try {
    profRes = await fetch(SUPABASE_URL + '/rest/v1/st_profiles', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ id: uid, org_id: orgId, name, role: 'admin', commission: 0 }),
    });
  } catch {
    profRes = { status: 500 };
  }
  if (profRes.status < 200 || profRes.status >= 300) {
    // Rollback best-effort: el auth user SOLO si lo creó este helper (nunca
    // borrar una cuenta adoptada de otra app).
    if (createdAuth) {
      try {
        await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(uid), {
          method: 'DELETE',
          headers: svcHeaders(),
        });
      } catch { /* best-effort rollback */ }
    }
    console.log(`[api] ${logTag} profile_fail rollback org=${orgId} -> 500`);
    return { ok: false, status: 500, error: 'No se pudo crear el admin. No se creó nada.' };
  }

  return { ok: true, uid, createdAuth, existingAccount };
}

// ---------- POST /api/orgs ----------
// Alta de una organización + su admin. SOLO super-admins. Si el email del admin
// ya existe en el GoTrue COMPARTIDO (tracker, CallIQ…), se resuelve contra el
// auth user real: perfil en otra org → 409; sin perfil → se adopta la cuenta
// (JAMÁS se toca su contraseña, patrón importGhlUser). Rollback en toda rama de
// fallo post-creación: la org creada se borra y el auth user SOLO si fue creado
// por este endpoint (nunca borrar una cuenta adoptada).
async function createOrg(req, res, sa) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'El cuerpo de la solicitud no es un JSON válido' });

  const body = parsed.data || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const adminName = typeof body.admin_name === 'string' ? body.admin_name.trim() : '';
  const adminEmail = typeof body.admin_email === 'string' ? body.admin_email.trim() : '';
  let password = typeof body.admin_password === 'string' ? body.admin_password : '';
  const locationId = typeof body.location_id === 'string' ? body.location_id.trim() : '';

  // Validaciones (mensajes en español latino, tuteo).
  if (!name) return sendJSON(res, 400, { error: 'Tienes que poner el nombre de la organización' });
  if (!adminName) return sendJSON(res, 400, { error: 'Tienes que poner el nombre del admin' });
  if (!adminEmail || !/^\S+@\S+\.\S+$/.test(adminEmail)) {
    return sendJSON(res, 400, { error: 'El email del admin no es válido' });
  }
  if (password && password.length < 8) {
    return sendJSON(res, 400, { error: 'La contraseña tiene que tener al menos 8 caracteres' });
  }

  // Password autogenerada (14 chars sin caracteres confusos). NUNCA se loggea.
  let generated = false;
  if (!password) {
    let acc = '';
    while (acc.length < 14) {
      acc += crypto.randomBytes(24).toString('base64url').replace(/[-_0OoIl1]/g, '');
    }
    password = acc.slice(0, 14);
    generated = true;
  }

  // La subcuenta de HighLevel es OBLIGATORIA: toda org nace vinculada a una subcuenta.
  if (!locationId) return sendJSON(res, 400, { error: 'Tenés que vincular una subcuenta de HighLevel a la organización' });

  // Pre-vínculo de subcuenta: validaciones fail-fast ANTES de crear la org, así
  // no se complica el rollback existente. JAMÁS se confía en el body: la location
  // tiene que existir en la agencia y no estar ya vinculada.
  let locationName = null;
  if (locationId) {
    // 1. PIT de agencia configurado.
    const pit = await getPlatformSetting(PIT_KEY);
    if (!pit) return sendJSON(res, 409, { error: 'Configurá primero el token de agencia' });

    // 2. La location existe en la agencia (resultado completo, sin el slice de 20).
    let allLocations;
    try {
      allLocations = await searchAgencyLocations(pit, '');
    } catch {
      return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel. Probá de nuevo.' });
    }
    const loc = allLocations.find((l) => l.id === locationId);
    if (!loc) return sendJSON(res, 400, { error: 'Esa subcuenta no existe en tu agencia' });
    locationName = loc.name;

    // 3. NO está ya vinculada a otra org.
    try {
      const dupRes = await fetch(
        SUPABASE_URL + '/rest/v1/st_integrations?location_id=eq.' + encodeURIComponent(locationId) + '&select=org_id',
        { headers: svcHeaders() }
      );
      if (dupRes.status !== 200) return sendJSON(res, 500, { error: 'No se pudo verificar la subcuenta' });
      const dupRows = await dupRes.json().catch(() => null);
      const dup = Array.isArray(dupRows) ? dupRows[0] : null;
      if (dup) {
        let orgName = dup.org_id;
        try {
          const oRes = await fetch(
            SUPABASE_URL + '/rest/v1/st_orgs?id=eq.' + encodeURIComponent(dup.org_id) + '&select=name',
            { headers: svcHeaders() }
          );
          const oRows = oRes.status === 200 ? await oRes.json().catch(() => null) : null;
          const oRow = Array.isArray(oRows) ? oRows[0] : null;
          if (oRow && oRow.name) orgName = oRow.name;
        } catch { /* best-effort: el org_id de fallback alcanza para el mensaje */ }
        return sendJSON(res, 409, { error: 'Esa subcuenta ya está vinculada a ' + orgName });
      }
    } catch {
      return sendJSON(res, 502, { error: 'No se pudo verificar la subcuenta' });
    }
  }

  // a. Crear la org (tz y team_mode salen de los defaults del schema).
  let orgId;
  try {
    const orgRes = await fetch(SUPABASE_URL + '/rest/v1/st_orgs', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ name }),
    });
    const orgRows = await orgRes.json().catch(() => null);
    const orgRow = Array.isArray(orgRows) ? orgRows[0] : orgRows;
    if (orgRes.status < 200 || orgRes.status >= 300 || !orgRow || !orgRow.id) {
      console.log(`[api] POST /api/orgs super=${sa.email} org_fail status=${orgRes.status} -> 500`);
      return sendJSON(res, 500, { error: 'No se pudo crear la organización' });
    }
    orgId = orgRow.id;
  } catch {
    return sendJSON(res, 500, { error: 'No se pudo crear la organización' });
  }

  // Rollback best-effort de la org (para toda rama de fallo posterior).
  const rollbackOrg = async () => {
    try {
      await fetch(SUPABASE_URL + '/rest/v1/st_orgs?id=eq.' + encodeURIComponent(orgId), {
        method: 'DELETE',
        headers: svcHeaders({ 'Prefer': 'return=minimal' }),
      });
    } catch { /* best-effort rollback */ }
  };

  // b+c. Resolver el auth user del admin + perfil (helper compartido con
  // POST /api/orgs/{orgId}/admins). Toda rama de fallo del helper rollbackea
  // la org recién creada; el auth user lo maneja el propio helper.
  const prov = await provisionOrgAdmin(
    { orgId, name: adminName, email: adminEmail, password },
    `POST /api/orgs super=${sa.email}`
  );
  if (!prov.ok) {
    await rollbackOrg();
    return sendJSON(res, prov.status, { error: prov.error });
  }
  const { uid, createdAuth, existingAccount } = prov;

  // La password viaja UNA sola vez y solo si fue autogenerada para una cuenta
  // recién creada (si la cuenta ya existía, entra con su contraseña de siempre;
  // si vino en el body, el super-admin ya la conoce). Jamás en logs.
  const out = { org: { id: orgId, name }, admin_email: adminEmail, existing_account: existingAccount };
  if (generated && createdAuth) out.admin_password = password;

  // Pre-vínculo: fila en st_integrations SIN tokens (quedan null = pending).
  // El OAuth del admin del tenant completa el vínculo después. Si este INSERT
  // falla NO se aborta ni rollbackea: la org ya existe y es válida — se avisa
  // con un warning para que el super-admin reintente o conecte por OAuth.
  if (locationId) {
    let linked = false;
    try {
      const intRes = await fetch(SUPABASE_URL + '/rest/v1/st_integrations', {
        method: 'POST',
        headers: svcHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ org_id: orgId, provider: 'ghl', location_id: locationId, location_name: locationName }),
      });
      linked = intRes.status >= 200 && intRes.status < 300;
    } catch { /* best-effort: se reporta en el warning */ }
    if (linked) {
      out.location_id = locationId;
      out.location_name = locationName;
    } else {
      out.linked = false;
      out.warning = 'La organización se creó pero no se pudo asignar la subcuenta. Asignala de nuevo o conectá por OAuth.';
      console.log(`[api] POST /api/orgs super=${sa.email} prelink_fail org=${orgId} location=${locationId}`);
    }
  }

  console.log(`[api] POST /api/orgs super=${sa.email} created org=${orgId} admin=${uid} existing=${existingAccount} location=${locationId || '-'} -> 200`);
  return sendJSON(res, 200, out);
}

// ---------- GET /api/orgs/{orgId}/members ----------
// Miembros de una org (nombre, email, rol, activo, origen GHL/manual).
// SOLO super-admins. El email sale de GoTrue admin con cache por request.
async function listOrgMembers(req, res, sa, orgId) {
  // La org tiene que existir (evita responder listas vacías para ids basura).
  let orgRows;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_orgs?id=eq.' + encodeURIComponent(orgId) + '&select=id',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return sendJSON(res, 500, { error: 'No se pudo leer la organización' });
    orgRows = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo leer la organización' });
  }
  if (!Array.isArray(orgRows) || !orgRows[0]) {
    return sendJSON(res, 404, { error: 'Esa organización no existe' });
  }

  let profRows;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(orgId)
        + '&select=id,name,role,active,ghl_user_id&order=name.asc',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return sendJSON(res, 500, { error: 'No se pudieron leer los miembros' });
    profRows = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudieron leer los miembros' });
  }

  const profiles = Array.isArray(profRows) ? profRows : [];
  const emailCache = new Map(); // un Map por request (patrón getAuthEmail)
  const members = [];
  for (const p of profiles) {
    members.push({
      id: p.id,
      name: p.name,
      email: await getAuthEmail(p.id, emailCache),
      role: p.role,
      active: p.active !== false,
      ghl: !!p.ghl_user_id,
    });
  }

  console.log(`[api] GET /api/orgs/${orgId}/members super=${sa.email} count=${members.length} -> 200`);
  return sendJSON(res, 200, { members });
}

// ---------- PATCH /api/orgs/{orgId}/members/{uid} ----------
// Cambia rol y/o activo de un miembro. SOLO super-admins. Protección de último
// admin: ningún cambio puede dejar a la org sin al menos un admin activo.
// active=false banea el auth user (best-effort, patrón deleteMember);
// active=true lo desbanea.
async function patchOrgMember(req, res, sa, orgId, uid) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'El cuerpo de la solicitud no es un JSON válido' });
  const body = parsed.data || {};

  const hasRole = body.role !== undefined;
  const hasActive = body.active !== undefined;
  if (!hasRole && !hasActive) {
    return sendJSON(res, 400, { error: 'Tienes que mandar al menos un cambio (rol o activo)' });
  }
  const ROLES = ['admin', 'setter', 'triage', 'closer'];
  if (hasRole && !ROLES.includes(body.role)) {
    return sendJSON(res, 400, { error: 'Ese rol no es válido' });
  }
  // Enforcement team_mode: el super-admin no puede asignar un rol que el modo de equipo
  // de esa org no permita. Solo aplica cuando el body trae role; el flujo de active-only
  // no se toca. 'admin' siempre pasa (roleAllowedForMode). Fail-open a 'full' ante lectura caída.
  if (hasRole) {
    const mode = await readTeamMode(orgId);
    if (!roleAllowedForMode(body.role, mode)) {
      return sendJSON(res, 400, { error: 'Este rol no está disponible para el modo de equipo de tu agencia.' });
    }
  }
  if (hasActive && typeof body.active !== 'boolean') {
    return sendJSON(res, 400, { error: 'El campo activo tiene que ser verdadero o falso' });
  }

  // Perfiles de la org: valida pertenencia (anti cross-org, patrón deleteMember)
  // y alimenta la protección de último admin en una sola lectura.
  let profRows;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(orgId) + '&select=id,role,active',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return sendJSON(res, 500, { error: 'No se pudieron leer los miembros' });
    profRows = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudieron leer los miembros' });
  }
  const profiles = Array.isArray(profRows) ? profRows : [];
  const target = profiles.find((p) => p && p.id === uid);
  if (!target) {
    return sendJSON(res, 404, { error: 'Ese miembro no pertenece a esa organización' });
  }

  // Simular el cambio sobre el target: si la org queda sin ningún admin activo
  // (por degradar el rol O por desactivar), se rechaza.
  const nextRole = hasRole ? body.role : target.role;
  const nextActive = hasActive ? body.active : target.active !== false;
  const adminsActivos = profiles.filter((p) => {
    const role = p.id === uid ? nextRole : p.role;
    const active = p.id === uid ? nextActive : p.active !== false;
    return role === 'admin' && active;
  });
  if (!adminsActivos.length) {
    return sendJSON(res, 400, { error: 'La organización no puede quedar sin admin' });
  }

  // Aplicar el cambio (filtrado por id + org_id: defensa extra anti cross-org).
  const patch = {};
  if (hasRole) patch.role = body.role;
  if (hasActive) patch.active = body.active;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(uid)
        + '&org_id=eq.' + encodeURIComponent(orgId),
      { method: 'PATCH', headers: svcHeaders({ 'Prefer': 'return=minimal' }), body: JSON.stringify(patch) }
    );
    if (r.status < 200 || r.status >= 300) {
      console.log(`[api] PATCH /api/orgs/${orgId}/members super=${sa.email} patch_fail uid=${uid} status=${r.status} -> 500`);
      return sendJSON(res, 500, { error: 'No se pudo actualizar al miembro' });
    }
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo actualizar al miembro' });
  }

  // Ban/unban best-effort: el active=false ya bloquea vía checkUserToken.
  if (hasActive) {
    try {
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(uid), {
        method: 'PUT',
        headers: svcHeaders(),
        body: JSON.stringify({ ban_duration: body.active ? 'none' : '87600h' }),
      });
    } catch { /* best-effort: el soft-delete ya impide el acceso */ }
  }

  console.log(`[api] PATCH /api/orgs/${orgId}/members super=${sa.email} uid=${uid} role=${hasRole ? body.role : '-'} active=${hasActive ? body.active : '-'} -> 200`);
  return sendJSON(res, 200, { ok: true });
}

// ---------- POST /api/orgs/{orgId}/admins ----------
// Agrega un admin a una org EXISTENTE. SOLO super-admins. Reutiliza
// provisionOrgAdmin (misma lógica de alta/adopción que POST /api/orgs).
// La password autogenerada viaja UNA sola vez y solo si la cuenta es nueva.
async function addOrgAdmin(req, res, sa, orgId) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'El cuerpo de la solicitud no es un JSON válido' });
  const body = parsed.data || {};

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  let password = typeof body.password === 'string' ? body.password : '';

  if (!name) return sendJSON(res, 400, { error: 'Tienes que poner el nombre del admin' });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return sendJSON(res, 400, { error: 'El email del admin no es válido' });
  }
  if (password && password.length < 8) {
    return sendJSON(res, 400, { error: 'La contraseña tiene que tener al menos 8 caracteres' });
  }

  // Password autogenerada (14 chars sin caracteres confusos). NUNCA se loggea.
  let generated = false;
  if (!password) {
    let acc = '';
    while (acc.length < 14) {
      acc += crypto.randomBytes(24).toString('base64url').replace(/[-_0OoIl1]/g, '');
    }
    password = acc.slice(0, 14);
    generated = true;
  }

  // La org tiene que existir.
  let orgRows;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_orgs?id=eq.' + encodeURIComponent(orgId) + '&select=id',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return sendJSON(res, 500, { error: 'No se pudo leer la organización' });
    orgRows = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo leer la organización' });
  }
  if (!Array.isArray(orgRows) || !orgRows[0]) {
    return sendJSON(res, 404, { error: 'Esa organización no existe' });
  }

  const prov = await provisionOrgAdmin(
    { orgId, name, email, password },
    `POST /api/orgs/${orgId}/admins super=${sa.email}`
  );
  if (!prov.ok) return sendJSON(res, prov.status, { error: prov.error });

  const out = { admin_email: email, existing_account: prov.existingAccount };
  if (generated && prov.createdAuth) out.admin_password = password;

  console.log(`[api] POST /api/orgs/${orgId}/admins super=${sa.email} admin=${prov.uid} existing=${prov.existingAccount} -> 200`);
  return sendJSON(res, 200, out);
}

// ---------- DELETE /api/orgs/{orgId} ----------
// Elimina una organización COMPLETA: ventas, entradas, metas, integraciones y
// perfiles, y al final la org misma. SOLO super-admins. Borrado explícito tabla
// por tabla (aunque el schema tenga ON DELETE CASCADE) para contar filas y no
// depender del cascade.
//
// PROHIBIDO tocar auth.users / /auth/v1/admin/users acá: GoTrue es COMPARTIDO
// con otras apps de Maze — borrar el auth user rompería sus otras cuentas. Sin
// perfil en st_profiles el usuario ya no puede entrar al tracker (checkUserToken
// + requireMember lo bloquean), así que borrar el perfil alcanza.
async function deleteOrg(req, res, sa, orgId) {
  // La org tiene que existir (y de paso obtenemos el nombre para el log NO —
  // solo el id: nombres de orgs tampoco van a logs).
  let orgRows;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_orgs?id=eq.' + encodeURIComponent(orgId) + '&select=id,name',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return sendJSON(res, 500, { error: 'No se pudo leer la organización' });
    orgRows = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo leer la organización' });
  }
  if (!Array.isArray(orgRows) || !orgRows[0]) {
    return sendJSON(res, 404, { error: 'Esa organización no existe' });
  }

  // Borrado explícito en orden: datos → perfiles → org. Cada DELETE filtra
  // org_id=eq.{orgId} (anti cross-org) y pide return=representation para
  // contar las filas eliminadas.
  const pasos = [
    { tabla: 'st_sales', query: 'org_id=eq.' + encodeURIComponent(orgId), clave: 'sales' },
    { tabla: 'st_entries', query: 'org_id=eq.' + encodeURIComponent(orgId), clave: 'entries' },
    { tabla: 'st_goals', query: 'org_id=eq.' + encodeURIComponent(orgId), clave: 'goals' },
    { tabla: 'st_integrations', query: 'org_id=eq.' + encodeURIComponent(orgId), clave: 'integrations' },
    { tabla: 'st_profiles', query: 'org_id=eq.' + encodeURIComponent(orgId), clave: 'profiles' },
    { tabla: 'st_orgs', query: 'id=eq.' + encodeURIComponent(orgId), clave: 'orgs' },
  ];
  const deleted = {};
  for (const paso of pasos) {
    let r;
    try {
      r = await fetch(SUPABASE_URL + '/rest/v1/' + paso.tabla + '?' + paso.query, {
        method: 'DELETE',
        headers: svcHeaders({ 'Prefer': 'return=representation' }),
      });
    } catch {
      console.error(`[api] DELETE /api/orgs/${orgId} super=${sa.email} fail tabla=${paso.tabla} (red) -> 500 parcial`);
      return sendJSON(res, 500, { error: 'No se pudo completar la eliminación: falló al borrar ' + paso.tabla + ' y la organización quedó eliminada parcialmente. Volvé a intentar para terminar de borrarla.' });
    }
    if (r.status < 200 || r.status >= 300) {
      console.error(`[api] DELETE /api/orgs/${orgId} super=${sa.email} fail tabla=${paso.tabla} status=${r.status} -> 500 parcial`);
      return sendJSON(res, 500, { error: 'No se pudo completar la eliminación: falló al borrar ' + paso.tabla + ' y la organización quedó eliminada parcialmente. Volvé a intentar para terminar de borrarla.' });
    }
    const rows = await r.json().catch(() => null);
    deleted[paso.clave] = Array.isArray(rows) ? rows.length : 0;
  }

  console.log(`[api] DELETE /api/orgs/${orgId} super=${sa.email} deleted profiles=${deleted.profiles} sales=${deleted.sales} entries=${deleted.entries} -> 200`);
  return sendJSON(res, 200, { ok: true, deleted: { profiles: deleted.profiles, sales: deleted.sales, entries: deleted.entries } });
}

// ---------- POST /api/orgs/{orgId}/members/{uid}/login-link ----------
// Genera un magic link de GoTrue para entrar a la app COMO ese miembro
// (impersonación de soporte). SOLO super-admins. El link/token/email JAMÁS
// se loggean: solo orgId + uid + super-admin (repudiation trail sin secretos).
async function memberLoginLink(req, res, sa, orgId, uid) {
  if (!PUBLIC_URL) {
    return sendJSON(res, 503, { error: 'PUBLIC_URL no está configurada en el servidor' });
  }

  // Pertenencia: el uid tiene que ser un perfil de ESA org (anti cross-org).
  let profRows;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(uid)
        + '&org_id=eq.' + encodeURIComponent(orgId) + '&select=id,active',
      { headers: svcHeaders() }
    );
    if (r.status !== 200) return sendJSON(res, 500, { error: 'No se pudo leer el perfil del miembro' });
    profRows = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo leer el perfil del miembro' });
  }
  const prof = Array.isArray(profRows) ? profRows[0] : null;
  if (!prof) {
    return sendJSON(res, 404, { error: 'Ese miembro no pertenece a esa organización' });
  }
  if (prof.active === false) {
    return sendJSON(res, 400, { error: 'Ese miembro está inactivo' });
  }

  const email = await getAuthEmail(uid, new Map());
  if (!email) {
    return sendJSON(res, 404, { error: 'No se encontró el email de ese miembro' });
  }

  // Magic link vía GoTrue admin. JAMÁS loggear link/token/email de acá en más.
  let data;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: svcHeaders(),
      body: JSON.stringify({ type: 'magiclink', email, redirect_to: PUBLIC_URL }),
    });
    if (r.status < 200 || r.status >= 300) {
      return sendJSON(res, 502, { error: 'No se pudo generar el acceso' });
    }
    data = await r.json().catch(() => null);
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo generar el acceso' });
  }

  // GoTrue devuelve action_link/hashed_token al tope o anidados en .properties.
  const props = (data && data.properties) || {};
  const actionLink = (data && data.action_link) || props.action_link || '';
  const hashedToken = (data && data.hashed_token) || props.hashed_token || '';
  let link = actionLink;
  if (!link && hashedToken) {
    link = SUPABASE_URL + '/auth/v1/verify?token=' + encodeURIComponent(hashedToken)
      + '&type=magiclink&redirect_to=' + encodeURIComponent(PUBLIC_URL);
  }
  if (!link) {
    return sendJSON(res, 502, { error: 'No se pudo generar el acceso' });
  }

  console.log(`[api] POST /api/orgs/${orgId}/members/${uid}/login-link super=${sa.email} -> 200`);
  return sendJSON(res, 200, { link });
}

// ---------- GET /api/platform/settings ----------
// Estado del token de agencia GHL para la vista Plataforma. SOLO super-admins.
// El token completo JAMÁS sale en la respuesta ni en logs: solo un hint
// '····' + últimos 4 caracteres.
async function getPlatformSettings(req, res, sa) {
  const pit = await getPlatformSetting(PIT_KEY);
  console.log(`[api] GET /api/platform/settings super=${sa.email} set=${!!pit} -> 200`);
  return sendJSON(res, 200, {
    agency_pit_set: !!pit,
    agency_pit_hint: pit ? '····' + pit.slice(-4) : null,
  });
}

// ---------- GET /api/platform/location-details?id=xxx ----------
// Detalle de una subcuenta de la agencia para autocompletar el alta de org
// (nombre de la subcuenta + dueño + email). SOLO super-admins. Usa el PIT de
// agencia; el front nunca ve el token. Best-effort: si GHL falla, el front deja
// los campos como estén.
async function getLocationDetails(req, res, sa, url) {
  const locationId = (url.searchParams.get('id') || '').trim();
  if (!locationId) return sendJSON(res, 400, { error: 'Falta el id de la subcuenta' });
  const pit = await getPlatformSetting(PIT_KEY);
  if (!pit) return sendJSON(res, 409, { error: 'Configurá primero el token de agencia' });
  let body;
  try {
    const r = await fetch(GHL_BASE + '/locations/' + encodeURIComponent(locationId), { headers: ghlHeaders(pit) });
    if (r.status < 200 || r.status >= 300) {
      console.error(`[api] getLocationDetails fail status=${r.status} loc=${locationId}`);
      return sendJSON(res, 502, { error: 'No se pudo leer la subcuenta de HighLevel' });
    }
    body = await r.json().catch(() => ({}));
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel' });
  }
  const loc = (body && body.location) || {};
  const ownerName = [loc.firstName, loc.lastName].filter(Boolean).join(' ').trim();
  console.log(`[api] GET /api/platform/location-details super=${sa.email} loc=${locationId} -> 200`);
  return sendJSON(res, 200, { name: loc.name || '', owner_name: ownerName, email: loc.email || '' });
}

// ---------- POST /api/platform/settings ----------
// Guarda/reemplaza/borra el token de agencia GHL. SOLO super-admins.
// Antes de guardar se valida EN VIVO contra locations/search: un token que no
// puede listar subcuentas no sirve para nada acá. Body {agency_pit} vacío o
// null = borrar el token. JAMÁS loggear el valor: solo set/cleared + email.
async function setPlatformSettings(req, res, sa) {
  const parsed = await readJSONBody(req);
  if (!parsed.ok) return sendJSON(res, 400, { error: 'El cuerpo de la solicitud no es un JSON válido' });
  const raw = parsed.data && parsed.data.agency_pit;
  const pit = typeof raw === 'string' ? raw.trim() : '';

  // Vacío = borrar el token (queda "no configurada").
  if (!pit) {
    const ok = await deletePlatformSetting(PIT_KEY);
    if (!ok) return sendJSON(res, 500, { error: 'No se pudo borrar el token de agencia' });
    console.log(`[api] POST /api/platform/settings super=${sa.email} cleared -> 200`);
    return sendJSON(res, 200, { ok: true, agency_pit_set: false, agency_pit_hint: null });
  }

  // Validación en vivo: el token tiene que poder listar subcuentas.
  try {
    const testRes = await fetch(GHL_BASE + '/locations/search?limit=1', { headers: ghlHeaders(pit) });
    if (testRes.status < 200 || testRes.status >= 300) {
      console.log(`[api] POST /api/platform/settings super=${sa.email} invalid_pit status=${testRes.status} -> 400`);
      return sendJSON(res, 400, { error: 'Token de agencia inválido o sin permisos de locations' });
    }
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel. Probá de nuevo.' });
  }

  const ok = await setPlatformSetting(PIT_KEY, pit);
  if (!ok) return sendJSON(res, 500, { error: 'No se pudo guardar el token de agencia' });
  console.log(`[api] POST /api/platform/settings super=${sa.email} set -> 200`);
  return sendJSON(res, 200, { ok: true, agency_pit_set: true, agency_pit_hint: '····' + pit.slice(-4) });
}

// ---------- Subcuentas de la agencia (agency PIT) ----------
// Pagina GET /locations/search hasta 10 páginas de 100 (1000 locations máx —
// tope anti-DoS aceptado: agencia de un solo super-admin). Corta antes si una
// página vuelve incompleta. La lista completa se cachea en memoria 5 minutos
// (la agencia cambia poco); el filtro `q` se aplica sobre el cache, así el
// buscador con debounce no re-pagina GHL en cada tecla. Si una página responde
// no-2xx, lanza Error (el caller responde 502). Filtro `q` (lowercase/trim)
// contra name/email/id; q vacío = todas. Devuelve [{id,name,city,country}]
// ordenado alfabéticamente por nombre (localeCompare 'es', case-insensitive) —
// jamás el objeto crudo de GHL (email queda server-side, solo para filtrar).
let agencyLocationsCache = { at: 0, data: null };
async function searchAgencyLocations(pit, q) {
  let acc;
  if (agencyLocationsCache.data && Date.now() - agencyLocationsCache.at < 5 * 60 * 1000) {
    acc = agencyLocationsCache.data;
  } else {
    acc = [];
    for (let page = 0; page < 10; page++) {
      const r = await fetch(GHL_BASE + '/locations/search?limit=100&skip=' + (page * 100), {
        headers: ghlHeaders(pit),
      });
      if (r.status < 200 || r.status >= 300) {
        console.error(`[api] searchAgencyLocations fail status=${r.status} page=${page}`);
        throw new Error('No se pudo hablar con HighLevel');
      }
      const body = await r.json().catch(() => ({}));
      const locs = Array.isArray(body && body.locations) ? body.locations : [];
      acc.push(...locs);
      if (locs.length < 100) break; // página incompleta: no hay más
    }
    agencyLocationsCache = { at: Date.now(), data: acc };
  }

  const query = String(q || '').toLowerCase().trim();
  const filtered = query
    ? acc.filter((l) => l && (
        String(l.name || '').toLowerCase().includes(query)
        || String(l.email || '').toLowerCase().includes(query)
        || String(l.id || '').toLowerCase().includes(query)
      ))
    : acc.filter((l) => l && l.id);

  // Orden alfabético por nombre (es, case-insensitive). Es seguro ordenar
  // `filtered` in-place: .filter() ya devolvió un array nuevo, el cache
  // compartido (agencyLocationsCache.data) no se muta.
  filtered.sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id), 'es', { sensitivity: 'base' })
  );

  return filtered.map((l) => ({
    id: l.id,
    name: l.name || l.id,
    city: l.city || '',
    country: l.country || '',
  }));
}

// ---------- GET /api/platform/locations?q= ----------
// Buscador de subcuentas de la agencia para el alta de orgs. SOLO super-admins.
// Anota `linked_org`: si la location ya está vinculada a una org del tracker,
// el nombre de esa org (para deshabilitarla en la UI). Máximo 50 resultados;
// `total` = cantidad post-filtro pre-cap (para el header "Mostrando X de Y").
async function listAgencyLocations(req, res, sa, url) {
  const pit = await getPlatformSetting(PIT_KEY);
  if (!pit) return sendJSON(res, 409, { error: 'Configurá primero el token de agencia' });

  let locations;
  try {
    locations = await searchAgencyLocations(pit, url.searchParams.get('q') || '');
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo hablar con HighLevel. Probá de nuevo.' });
  }

  // Vínculos existentes: location_id -> nombre de la org (o el org_id de fallback).
  const linkedByLocation = new Map();
  try {
    const intsRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_integrations?select=org_id,location_id',
      { headers: svcHeaders() }
    );
    const ints = intsRes.status === 200 ? await intsRes.json().catch(() => null) : null;
    const orgsRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_orgs?select=id,name',
      { headers: svcHeaders() }
    );
    const orgs = orgsRes.status === 200 ? await orgsRes.json().catch(() => null) : null;
    const orgName = new Map();
    for (const o of (Array.isArray(orgs) ? orgs : [])) orgName.set(o.id, o.name);
    for (const i of (Array.isArray(ints) ? ints : [])) {
      if (i && i.location_id) linkedByLocation.set(i.location_id, orgName.get(i.org_id) || i.org_id);
    }
  } catch { /* best-effort: sin la anotación el buscador sigue sirviendo */ }

  const total = locations.length;
  const out = locations.slice(0, 50).map((l) => ({
    ...l,
    linked_org: linkedByLocation.get(l.id) || null,
  }));
  console.log(`[api] GET /api/platform/locations super=${sa.email} n=${out.length} total=${total} -> 200`);
  return sendJSON(res, 200, { locations: out, total });
}

// ---------- SSO desde GHL (Custom Page embebida) ----------
// GHL cifra los datos del usuario con CryptoJS.AES.encrypt(json, sharedSecret)
// y nos los pasa por postMessage. Ese formato es OpenSSL "Salted__": base64 de
// "Salted__"(8) + salt(8) + ciphertext. La key+iv se derivan con EVP_BytesToKey
// (MD5, sin iteraciones): D_i = MD5(D_{i-1} + password + salt), concatenar hasta
// 48 bytes → key=32, iv=16, luego AES-256-CBC.
function evpBytesToKey(password, salt, keyLen, ivLen) {
  const pass = Buffer.from(password, 'utf8');
  let d = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (d.length < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, pass, salt])).digest();
    d = Buffer.concat([d, prev]);
  }
  return { key: d.subarray(0, keyLen), iv: d.subarray(keyLen, keyLen + ivLen) };
}
function decryptGhlPayload(payloadB64, secret) {
  const raw = Buffer.from(String(payloadB64), 'base64');
  if (raw.length < 16 || raw.subarray(0, 8).toString('utf8') !== 'Salted__') {
    throw new Error('formato de payload inesperado');
  }
  const salt = raw.subarray(8, 16);
  const ciphertext = raw.subarray(16);
  const { key, iv } = evpBytesToKey(secret, salt, 32, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

// POST /api/sso/ghl — pública (el payload cifrado ES la credencial). Resuelve el
// usuario+subcuenta de GHL contra una membresía del tracker y devuelve un
// token_hash de magic link para que el frontend abra sesión sin contraseña.
async function ssoGhl(req, res) {
  if (!GHL_SSO_KEY) return sendJSON(res, 501, { error: 'SSO no está configurado en esta instancia' });
  const parsed = await readJSONBody(req);
  const payload = parsed.ok && parsed.data && parsed.data.payload;
  if (!payload) return sendJSON(res, 400, { error: 'Falta el payload de SSO' });

  let data;
  try { data = decryptGhlPayload(payload, GHL_SSO_KEY); } catch {
    return sendJSON(res, 401, { error: 'Payload de SSO inválido' });
  }
  const ghlUserId = data && (data.userId || data.user_id);
  const activeLocation = data && (data.activeLocation || data.locationId || data.location_id);
  const claimEmail = data && data.email ? String(data.email).toLowerCase().trim() : '';
  if (!ghlUserId || !activeLocation) {
    return sendJSON(res, 400, { error: 'El payload de SSO no trae usuario o subcuenta' });
  }

  // Subcuenta GHL → org del tracker (por la integración autorizada).
  let orgId = null;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/st_integrations?location_id=eq.'
      + encodeURIComponent(activeLocation) + '&select=org_id', { headers: svcHeaders() });
    const rows = r.status === 200 ? await r.json().catch(() => []) : [];
    orgId = rows[0] && rows[0].org_id;
  } catch { /* cae a 403 abajo */ }
  if (!orgId) return sendJSON(res, 403, { error: 'Esta subcuenta no tiene un equipo del tracker vinculado' });

  // Perfil del usuario en esa org: primero por ghl_user_id, luego por email del login.
  let prof = null;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(orgId)
      + '&ghl_user_id=eq.' + encodeURIComponent(ghlUserId) + '&select=id,user_id,active', { headers: svcHeaders() });
    const rows = r.status === 200 ? await r.json().catch(() => []) : [];
    prof = rows.find((p) => p.active !== false) || null;
  } catch { /* sigue con el fallback por email */ }

  let authUid = prof && prof.user_id;
  if (!prof && claimEmail) {
    const authUser = await findAuthUserByEmail(claimEmail);
    if (authUser && authUser.id) {
      authUid = authUser.id;
      try {
        const r = await fetch(SUPABASE_URL + '/rest/v1/st_profiles?org_id=eq.' + encodeURIComponent(orgId)
          + '&user_id=eq.' + encodeURIComponent(authUid) + '&select=id,user_id,active', { headers: svcHeaders() });
        const rows = r.status === 200 ? await r.json().catch(() => []) : [];
        prof = rows.find((p) => p.active !== false) || null;
      } catch { /* 403 abajo */ }
    }
  }
  if (!prof || !authUid) {
    return sendJSON(res, 403, { error: 'Tu usuario de GHL no está habilitado en este equipo del tracker' });
  }

  // Email real del login (el magic link se emite contra ese email).
  const email = await getAuthEmail(authUid, new Map());
  if (!email) return sendJSON(res, 403, { error: 'No se encontró la cuenta del usuario' });

  // Dejar el perfil de ESTA org como activo (multi-cuenta) antes de loguear.
  try {
    await fetch(SUPABASE_URL + '/rest/v1/st_user_state?on_conflict=user_id', {
      method: 'POST',
      headers: svcHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify({ user_id: authUid, active_profile_id: prof.id, updated_at: new Date().toISOString() }),
    });
  } catch { /* best-effort: el boot igual cae al selector si falla */ }

  // Magic link vía GoTrue admin. JAMÁS loggear el token de acá en más.
  let token = '';
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/admin/generate_link', {
      method: 'POST', headers: svcHeaders(),
      body: JSON.stringify({ type: 'magiclink', email, redirect_to: PUBLIC_URL }),
    });
    if (r.status < 200 || r.status >= 300) return sendJSON(res, 502, { error: 'No se pudo generar el acceso' });
    const d = await r.json().catch(() => null);
    const props = (d && d.properties) || {};
    token = (d && d.hashed_token) || props.hashed_token || '';
  } catch {
    return sendJSON(res, 502, { error: 'No se pudo generar el acceso' });
  }
  if (!token) return sendJSON(res, 502, { error: 'No se pudo generar el acceso' });

  return sendJSON(res, 200, { ok: true, token_hash: token });
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Health-check simple (sin auth).
    if (req.method === 'GET' && path === '/api/health') {
      return sendJSON(res, 200, { ok: true });
    }

    // SSO desde GHL: pública (el payload cifrado ES la credencial).
    if (req.method === 'POST' && path === '/api/sso/ghl') {
      return ssoGhl(req, res);
    }

    // Rutas de la integración GHL.
    if (req.method === 'GET' && path === '/api/oauth/start') {
      return oauthStart(req, res, url);
    }

    if (req.method === 'GET' && path === '/api/oauth/callback') {
      return oauthCallback(req, res, url);
    }

    if (path === '/api/integrations/ghl' && (req.method === 'GET' || req.method === 'DELETE')) {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return req.method === 'GET' ? getGhlStatus(req, res, admin, url) : disconnectGhl(req, res, admin);
    }

    if (req.method === 'GET' && path === '/api/ghl/users') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return listGhlUsers(req, res, admin, url);
    }

    if (req.method === 'POST' && path === '/api/ghl/users/import') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return importGhlUser(req, res, admin);
    }

    if (req.method === 'GET' && path === '/api/ghl/calendars') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return listGhlCalendars(req, res, admin, url);
    }

    if (req.method === 'POST' && path === '/api/integrations/ghl/calendar') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return setGhlCalendar(req, res, admin);
    }

    if (req.method === 'POST' && path === '/api/integrations/ghl/agenda-calendars') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return setGhlAgendaCalendars(req, res, admin);
    }

    // Rutas del módulo Ventas-GHL: cualquier miembro ACTIVO del equipo (no solo admin).
    if (req.method === 'GET' && path === '/api/ghl/leads') {
      const member = await requireMember(req);
      if (!member.ok) return sendJSON(res, member.status, { error: member.error });
      return ghlLeads(req, res, member, url);
    }

    if (req.method === 'GET' && path === '/api/capture/ghl') {
      const member = await requireMember(req);
      if (!member.ok) return sendJSON(res, member.status, { error: member.error });
      return captureGhl(req, res, member, url);
    }

    if (req.method === 'POST' && path === '/api/shadow/run') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return shadowRun(req, res, admin);
    }

    if (req.method === 'POST' && path === '/api/sales/ghl') {
      const member = await requireMember(req);
      if (!member.ok) return sendJSON(res, member.status, { error: member.error });
      return salesGhl(req, res, member);
    }

    if (req.method === 'POST' && path === '/api/me/password') {
      const usr = await checkUserToken(req.headers['authorization'] || '');
      if (!usr.ok) return sendJSON(res, usr.status, { error: usr.error });
      return changeMyPassword(req, res, usr);
    }

    // Gestión de organizaciones: SOLO super-admins de la plataforma (equipo Maze).
    if (path === '/api/orgs' && (req.method === 'GET' || req.method === 'POST')) {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return req.method === 'GET' ? listOrgs(req, res, sa) : createOrg(req, res, sa);
    }

    // Gestión de miembros por org: SOLO super-admins (mismo guard fail-closed).
    const orgMembersMatch = path.match(/^\/api\/orgs\/([^/]+)\/members$/);
    if (orgMembersMatch && req.method === 'GET') {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return listOrgMembers(req, res, sa, decodeURIComponent(orgMembersMatch[1]));
    }

    // Impersonación: se evalúa ANTES que orgMemberMatch (aunque su regex
    // /members\/([^/]+)$/ no matchea /login-link, el orden queda explícito).
    const orgLoginLinkMatch = path.match(/^\/api\/orgs\/([^/]+)\/members\/([^/]+)\/login-link$/);
    if (orgLoginLinkMatch && req.method === 'POST') {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return memberLoginLink(req, res, sa, decodeURIComponent(orgLoginLinkMatch[1]), decodeURIComponent(orgLoginLinkMatch[2]));
    }

    const orgMemberMatch = path.match(/^\/api\/orgs\/([^/]+)\/members\/([^/]+)$/);
    if (orgMemberMatch && req.method === 'PATCH') {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return patchOrgMember(req, res, sa, decodeURIComponent(orgMemberMatch[1]), decodeURIComponent(orgMemberMatch[2]));
    }

    const orgAdminsMatch = path.match(/^\/api\/orgs\/([^/]+)\/admins$/);
    if (orgAdminsMatch && req.method === 'POST') {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return addOrgAdmin(req, res, sa, decodeURIComponent(orgAdminsMatch[1]));
    }

    const orgMatch = path.match(/^\/api\/orgs\/([^/]+)$/);
    if (orgMatch && req.method === 'DELETE') {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return deleteOrg(req, res, sa, decodeURIComponent(orgMatch[1]));
    }

    // Vista Plataforma: SOLO super-admins (mismo guard fail-closed que /api/orgs).
    if (path === '/api/platform/settings' && (req.method === 'GET' || req.method === 'POST')) {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return req.method === 'GET' ? getPlatformSettings(req, res, sa) : setPlatformSettings(req, res, sa);
    }

    if (req.method === 'GET' && path === '/api/platform/locations') {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return listAgencyLocations(req, res, sa, url);
    }

    if (req.method === 'GET' && path === '/api/platform/location-details') {
      const sa = await requireSuperAdmin(req);
      if (!sa.ok) return sendJSON(res, sa.status, { error: sa.error });
      return getLocationDetails(req, res, sa, url);
    }

    // Todo lo demás bajo /api/members exige admin.
    const isMembersRoot = path === '/api/members';
    const memberIdMatch = path.match(/^\/api\/members\/([^/]+)$/);

    if (isMembersRoot && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      return createMember(req, res, admin);
    }

    if (memberIdMatch && req.method === 'DELETE') {
      const admin = await requireAdmin(req);
      if (!admin.ok) return sendJSON(res, admin.status, { error: admin.error });
      const id = decodeURIComponent(memberIdMatch[1]);
      return deleteMember(req, res, admin, id);
    }

    return sendJSON(res, 404, { error: 'Ruta no encontrada' });
  } catch (err) {
    console.error('[api] error inesperado:', err && err.message);
    return sendJSON(res, 500, { error: 'Error interno del servidor' });
  }
});

server.listen(PORT, () => {
  console.log(`[api] Mini-API de miembros escuchando en el puerto ${PORT}`);
});
