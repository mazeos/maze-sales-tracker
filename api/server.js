// server.js — Mini-API de provisioning de miembros para Maze Sales Tracker.
//
// Sin dependencias npm: usa solo el módulo nativo `http` y el `fetch` global de Node 22.
// Gestiona auth users + perfiles con la SERVICE_ROLE_KEY (bypassea RLS), por lo que TODO
// filtrado por org_id se hace acá, a mano, y toda operación exige que el caller sea admin.
//
// Rutas (todas bajo /api/members):
//   POST   /api/members       -> crea auth user + perfil (alta real, la persona puede loguearse)
//   DELETE /api/members/{id}   -> soft-delete: active=false + ban del auth user (conserva histórico)

import http from 'node:http';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.ANON_KEY || '';
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('[api] Faltan env vars: SUPABASE_URL, SERVICE_ROLE_KEY y/o ANON_KEY. La API no puede arrancar.');
  process.exit(1);
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

// ---------- Middleware de auth: valida el JWT del caller y exige role=admin ----------
// Devuelve { ok:true, uid, org_id } si el caller es admin; si no, { ok:false, status, error }.
async function requireAdmin(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, error: 'Falta el token de sesión' };
  }

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

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Health-check simple (sin auth).
    if (req.method === 'GET' && path === '/api/health') {
      return sendJSON(res, 200, { ok: true });
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
