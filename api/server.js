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

import http from 'node:http';
import crypto from 'node:crypto';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.ANON_KEY || '';
const PORT = parseInt(process.env.PORT || '3000', 10);

// Env vars de la integración GHL (opcionales: la API arranca igual sin ellas).
// Los valores reales NUNCA van al código (repo público): solo por env.
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID || '';
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const GHL_ENABLED = !!(GHL_CLIENT_ID && GHL_CLIENT_SECRET && PUBLIC_URL);
const GHL_REDIRECT_URI = PUBLIC_URL + '/api/oauth/callback';

// Scopes que pide la app del Marketplace (space-separated).
const GHL_SCOPES = 'users.readonly calendars.readonly calendars/events.readonly contacts.readonly contacts.write opportunities.readonly opportunities.write conversations/message.readonly locations.readonly';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('[api] Faltan env vars: SUPABASE_URL, SERVICE_ROLE_KEY y/o ANON_KEY. La API no puede arrancar.');
  process.exit(1);
}

if (!GHL_ENABLED) {
  console.log('[api] Integración GHL no configurada (faltan GHL_CLIENT_ID/GHL_CLIENT_SECRET/PUBLIC_URL). La API arranca en modo manual.');
}

const VALID_ROLES = ['setter', 'triage', 'closer'];

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

// ---------- Auth: valida un JWT y exige role=admin ----------
// checkAdminToken recibe el token ('Bearer xxx' o el token pelado) y devuelve
// { ok:true, uid, org_id } si el caller es admin; si no, { ok:false, status, error }.
// requireAdmin(req) es el wrapper que lee el header Authorization.
async function checkAdminToken(bearerToken) {
  let token = (bearerToken || '').trim();
  if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: 'Falta el token de sesión' };
  }
  const authHeader = 'Bearer ' + token;

  // 1. Validar el JWT contra GoTrue (no confiamos en claims del cliente).
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

  // 2. Leer el perfil real del caller con la service key y exigir role=admin.
  let profRes;
  try {
    profRes = await fetch(
      SUPABASE_URL + '/rest/v1/st_profiles?id=eq.' + encodeURIComponent(uid) + '&select=org_id,role',
      { headers: svcHeaders() }
    );
  } catch {
    return { ok: false, status: 502, error: 'No se pudo leer el perfil del usuario' };
  }
  if (profRes.status !== 200) {
    return { ok: false, status: 403, error: 'Solo el admin puede gestionar miembros' };
  }
  const profs = await profRes.json();
  const prof = Array.isArray(profs) ? profs[0] : null;
  if (!prof || prof.role !== 'admin') {
    return { ok: false, status: 403, error: 'Solo el admin puede gestionar miembros' };
  }

  return { ok: true, uid, org_id: prof.org_id };
}

function requireAdmin(req) {
  return checkAdminToken(req.headers['authorization'] || '');
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

// Refresca el access_token de GHL si está por vencer (a menos de 5 min).
// Queda listo para las fases siguientes de sync; hoy ninguna ruta crítica lo consume.
async function refreshGhlToken(integration) {
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at).getTime() : 0;
  if (expiresAt - Date.now() >= 5 * 60 * 1000) {
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
      body: JSON.stringify({ id: newUid, org_id: admin.org_id, name, role, commission: 0 }),
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
// Estado de conexión para la UI. NUNCA incluye access_token/refresh_token:
// el select pide solo las columnas públicas.
async function getGhlStatus(req, res, admin) {
  let rows;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/st_integrations?org_id=eq.' + encodeURIComponent(admin.org_id)
        + '&select=location_id,location_name,created_at',
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

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Health-check simple (sin auth).
    if (req.method === 'GET' && path === '/api/health') {
      return sendJSON(res, 200, { ok: true });
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
      return req.method === 'GET' ? getGhlStatus(req, res, admin) : disconnectGhl(req, res, admin);
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
