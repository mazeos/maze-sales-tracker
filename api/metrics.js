// metrics.js — Cálculo de KPIs auto del Maze Sales Tracker (Fase A: modo sombra).
// Lógica validada KPI por KPI el 2026-07-05 contra escenarios simulados y datos
// reales (prototipo /root/sombra.js del VPS). Módulo puro: recibe contexto, devuelve valores.
// REGLA DE ORO: GHL no respeta startTime/endTime del query — re-filtrar SIEMPRE
// client-side en la TZ de la org. Solo mensajes humanos (source app) cuentan.

export function tzDayRange(dateStr, tz) {
  const utcMidnight = new Date(dateStr + 'T00:00:00Z').getTime();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMidnight)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const start = utcMidnight - (asUtc - utcMidnight);
  return { start, end: start + 86400000 };
}

// throttle simple: ~10 req/s + 1 reintento en 429
let lastReq = 0;
async function ghlFetch(url, headers) {
  const wait = Math.max(0, lastReq + 100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  let res = await fetch(url, { headers });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    lastReq = Date.now();
    res = await fetch(url, { headers });
  }
  return res.json().catch(() => ({}));
}

function kpisCitas(events, userId, { start, end }, prevShowedContacts, bump) {
  const inDay = (iso) => { const t = new Date(iso).getTime(); return t >= start && t < end; };
  const evs = events.filter((e) => !e.deleted && e.assignedUserId === userId && inDay(e.startTime));
  const st = (e) => String(e.appointmentStatus || '').toLowerCase();
  const validas = evs.filter((e) => !['cancelled', 'invalid'].includes(st(e)));
  for (const e of validas) {
    bump('llamadas', e.contactId);
    if (st(e) === 'showed') bump('asistencias', e.contactId);
    if (st(e) === 'noshow') bump('no_shows', e.contactId);
    if (prevShowedContacts.has(e.contactId)) bump('segundas', e.contactId);
  }
  for (const e of evs.filter((e) => st(e) === 'cancelled')) bump('cancelados', e.contactId);
  return {
    llamadas: validas.length,
    asistencias: validas.filter((e) => st(e) === 'showed').length,
    no_shows: validas.filter((e) => st(e) === 'noshow').length,
    cancelados: evs.filter((e) => st(e) === 'cancelled').length,
    segundas: validas.filter((e) => prevShowedContacts.has(e.contactId)).length,
  };
}

// Canal de una conversación
const IG_TYPES = new Set(['TYPE_INSTAGRAM']);
const WA_TYPES = new Set(['TYPE_WHATSAPP', 'TYPE_SMS', 'TYPE_CUSTOM_SMS']);
const TK_TYPES = new Set(['TYPE_TIKTOK']);

export async function computeMemberKpis(ctx) {
  const { ghlBase, token, locationId, calendarId, tz, date, member, salesRows, cuotasRows, bookingDomains, agendaCalendarIds } = ctx;
  const range = tzDayRange(date, tz);
  const inDay = (iso) => { const t = new Date(iso).getTime(); return t >= range.start && t < range.end; };
  const out = {};

  // Desglose de contactos por KPI: kpi -> Map(contactId -> count). Se puebla en
  // paralelo a los conteos de `out` y se resuelve a nombres al final.
  const contactsByKpi = {};
  const bump = (kpi, contactId) => {
    if (!contactId) return;
    const m = contactsByKpi[kpi] || (contactsByKpi[kpi] = new Map());
    m.set(contactId, (m.get(contactId) || 0) + 1);
  };
  const contactNames = new Map(); // contactId -> nombre (cache de los ya traídos)
  const nombreDe = (cc) => {
    const w = [cc.firstName, cc.lastName].filter(Boolean).join(' ').trim();
    return w || cc.email || cc.phone || 'Sin nombre';
  };

  // ---------- Ventas y cuotas (fuente: el propio tracker, filas ya provistas) ----------
  if (member.role === 'closer') {
    const mySales = salesRows.filter((s) => s.closer_id === member.id && s.sale_date === date);
    out.cierres = mySales.length;
    out.cash_nuevo = mySales.reduce((a, s) => a + (+s.cash || 0), 0);
    out.reservas = mySales.reduce((a, s) => a + (+s.reserva || 0), 0);
    out.revenue = mySales.reduce((a, s) => a + (+s.facturado || 0), 0);
    const mySaleIds = new Set(salesRows.filter((s) => s.closer_id === member.id).map((s) => s.id));
    out.cash_cuotas = cuotasRows
      .filter((c) => c.status === 'pagada' && c.paid_date === date && mySaleIds.has(c.sale_id))
      .reduce((a, c) => a + (+c.paid_amount || 0), 0);
  }

  if (!member.ghl_user_id || !token) return { values: out, contacts: {} }; // sin vínculo GHL: solo KPIs internos
  const H = { Authorization: 'Bearer ' + token, Version: '2021-04-15', Accept: 'application/json' };

  // ---------- Citas (closer) ----------
  if (member.role === 'closer' && calendarId) {
    const ev = await ghlFetch(`${ghlBase}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${range.start}&endTime=${range.end}`, H);
    const prevEv = await ghlFetch(`${ghlBase}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${range.start - 30 * 86400000}&endTime=${range.start}`, H);
    const prevShowed = new Set((prevEv.events || [])
      .filter((e) => !e.deleted && new Date(e.startTime).getTime() < range.start && String(e.appointmentStatus || '').toLowerCase() === 'showed')
      .map((e) => e.contactId));
    Object.assign(out, kpisCitas(ev.events || [], member.ghl_user_id, range, prevShowed, bump));
  }

  // ---------- Conversaciones (setter) ----------
  if (member.role === 'setter') {
    Object.assign(out, { outbound: 0, inbound_ig: 0, inbound_wpp_tk: 0, inbound_wpp_ig: 0, inbound_wpp_sin_canal: 0, respuestas: 0, seg_ig: 0, seg_wpp: 0, links_ig: 0, links_wpp: 0, outbound_tk: 0, resp_tk: 0, inbound_tk: 0, seg_tk: 0, bienvenidas: 0, agend_ig: 0, agend_wpp: 0 });
    // paginación hacia atrás hasta cubrir el inicio del día
    let all = [], cursor = null;
    for (let page = 0; page < 20; page++) {
      const url = `${ghlBase}/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=100&sortBy=last_message_date&sort=desc` + (cursor ? `&startAfterDate=${cursor}` : '');
      const res = await ghlFetch(url, H);
      const convs = res.conversations || [];
      if (!convs.length) break;
      all.push(...convs);
      const oldest = convs[convs.length - 1].lastMessageDate;
      if (oldest < range.start) break; // ya cubrimos el día
      cursor = oldest;
    }
    // toda conversación con actividad desde el inicio del día (los mensajes se
    // re-filtran por inDay adentro; una con actividad posterior también puede
    // contener mensajes del día pedido)
    const mias = all.filter((c) => c.lastMessageDate >= range.start && c.assignedTo === member.ghl_user_id);
    const humanOut = (m) => m.direction === 'outbound' && (m.source === 'app' || !m.source);
    // bienvenida = saliente automatizado (ManyChat), el opuesto de humanOut
    const autoOut = (m) => m.direction === 'outbound' && !!m.source && m.source !== 'app';
    const domRe = bookingDomains && bookingDomains.length
      ? new RegExp(bookingDomains.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
      : null;
    // Agendas: contactos a los que el setter les envió un link de agenda hoy, con su canal.
    // Ventana de atribución link → cita (parámetro; ver cruce post-loop).
    const AGENDA_WINDOW_DAYS = 7;
    const linkedContacts = new Map(); // contactId -> 'ig' | 'wpp'
    for (const c of mias) {
      const mm = await ghlFetch(`${ghlBase}/conversations/${encodeURIComponent(c.id)}/messages?limit=100`, H);
      const msgs = ((mm.messages && mm.messages.messages) || []).slice().sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
      if (!msgs.length) continue;
      const todays = msgs.filter((m) => inDay(m.dateAdded));
      if (!todays.length) continue;
      const type = msgs[0].messageType || c.lastMessageType || '';
      const isIg = IG_TYPES.has(type), isWa = WA_TYPES.has(type), isTk = TK_TYPES.has(type);
      // Traer el contacto para leer su fecha de alta (esNuevo) y, en WhatsApp, el
      // canal por utm_source. Una vez por conversación; cachea el nombre para el desglose.
      let esNuevo = false, waCanal = null;
      if (c.contactId) {
        const contact = await ghlFetch(`${ghlBase}/contacts/${encodeURIComponent(c.contactId)}`, H);
        const cc = contact.contact || {};
        contactNames.set(c.contactId, nombreDe(cc));
        esNuevo = cc.dateAdded ? inDay(cc.dateAdded) : false;
        if (isWa) {
          const cf = (cc.customFields || []).find((f) => String(f.key || f.name || '').toLowerCase().includes('utm_source'));
          const src = String((cf && cf.value) || (cc.tags || []).find((t) => String(t).startsWith('origen:')) || '').toLowerCase();
          if (src.includes('tiktok')) waCanal = 'tk'; else if (src.includes('instagram')) waCanal = 'ig';
        }
      }
      const abrioSetter = humanOut(msgs[0]) && inDay(msgs[0].dateAdded);
      const primerEntrante = msgs[0].direction === 'inbound';
      if (esNuevo && abrioSetter) {
        // outbound: apertura a un lead NUEVO (todos los canales)
        if (isTk) { out.outbound_tk++; bump('outbound_tk', c.contactId); } else { out.outbound++; bump('outbound', c.contactId); }
      } else if (esNuevo && primerEntrante) {
        // inbound: lead NUEVO que escribió primero (por canal)
        if (isIg) { out.inbound_ig++; bump('inbound_ig', c.contactId); }
        else if (isTk) { out.inbound_tk++; bump('inbound_tk', c.contactId); }
        else if (isWa) {
          if (waCanal === 'tk') { out.inbound_wpp_tk++; bump('inbound_wpp_tk', c.contactId); }
          else if (waCanal === 'ig') { out.inbound_wpp_ig++; bump('inbound_wpp_ig', c.contactId); }
          else { out.inbound_wpp_sin_canal++; bump('inbound_wpp_sin_canal', c.contactId); }
        }
      } else if (!esNuevo && todays.some((m) => m.direction === 'inbound')) {
        // respuesta: contacto que YA existía te escribe hoy
        if (isTk) { out.resp_tk++; bump('resp_tk', c.contactId); } else { out.respuestas++; bump('respuestas', c.contactId); }
      }
      // bienvenida: apertura automática (ManyChat) de hoy — solo IG (donde corre ManyChat)
      if (isIg && autoOut(msgs[0]) && inDay(msgs[0].dateAdded)) { out.bienvenidas++; bump('bienvenidas', c.contactId); }
      // seguimiento: saliente humano de hoy en conversación que NO abrió hoy
      if (!inDay(msgs[0].dateAdded) && todays.some(humanOut)) {
        if (isIg) { out.seg_ig++; bump('seg_ig', c.contactId); } else if (isWa) { out.seg_wpp++; bump('seg_wpp', c.contactId); } else if (isTk) { out.seg_tk++; bump('seg_tk', c.contactId); }
      }
      // links de agenda enviados hoy (content-match del dominio de la org)
      if (domRe) {
        const n = todays.filter((m) => humanOut(m) && domRe.test(m.body || '')).length;
        if (isIg) out.links_ig += n; else if (isWa) out.links_wpp += n;
        if (n > 0 && (isIg || isWa)) {
          linkedContacts.set(c.contactId, isIg ? 'ig' : 'wpp');
          for (let k = 0; k < n; k++) bump(isIg ? 'links_ig' : 'links_wpp', c.contactId); // count = nº de links
        }
      }
    }

    // ---------- Agendas (setter): cruce link enviado ↔ cita del contacto ----------
    // La cita se atribuye al setter si su contacto recibió un link de agenda dentro de
    // los AGENDA_WINDOW_DAYS previos a la cita. En Fase A el link se detecta hoy, así que
    // la ventana es un colchón hacia adelante (cita del día o de los próximos 7 días).
    // NO se filtra por assignedUserId: la cita suele quedar asignada al closer, no al setter;
    // el mecanismo de atribución es el cruce por contactId (createdBy.userId suele venir null).
    // Calendarios de agenda del setter (multi). Fallback al calendar_id del closer
    // si el tenant todavía no eligió agenda cals (retrocompat).
    const agendaCals = (agendaCalendarIds && agendaCalendarIds.length)
      ? agendaCalendarIds
      : (calendarId ? [calendarId] : []);
    if (linkedContacts.size && agendaCals.length) {
      const winEnd = range.start + AGENDA_WINDOW_DAYS * 86400000;
      // REGLA DE ORO: re-filtrar client-side por la ventana (GHL no respeta el rango del query).
      const inWin = (iso) => { const t = new Date(iso).getTime(); return t >= range.start && t < winEnd; };
      for (const calId of agendaCals) {
        if (!linkedContacts.size) break; // ya no quedan contactos por atribuir
        const ag = await ghlFetch(`${ghlBase}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calId)}&startTime=${range.start}&endTime=${winEnd}`, H);
        for (const e of (ag.events || [])) {
          if (e.deleted || !inWin(e.startTime)) continue;
          const canal = linkedContacts.get(e.contactId);
          if (!canal) continue;
          if (canal === 'ig') { out.agend_ig++; bump('agend_ig', e.contactId); } else { out.agend_wpp++; bump('agend_wpp', e.contactId); }
          linkedContacts.delete(e.contactId); // una agenda por contacto linkeado (en cualquier calendario)
        }
      }
    }
  }

  // Resolver nombres de los contactos únicos que aún no tenemos cacheados.
  const faltan = new Set();
  for (const m of Object.values(contactsByKpi)) for (const id of m.keys()) if (!contactNames.has(id)) faltan.add(id);
  for (const id of faltan) {
    const cr = await ghlFetch(`${ghlBase}/contacts/${encodeURIComponent(id)}`, H);
    contactNames.set(id, nombreDe(cr.contact || {}));
  }
  const contacts = {};
  for (const [kpi, m] of Object.entries(contactsByKpi)) {
    contacts[kpi] = [...m.entries()].map(([id, count]) => {
      const base = { id, name: contactNames.get(id) || 'Sin nombre' };
      return count > 1 ? { ...base, count } : base;
    });
  }
  return { values: out, contacts };
}
