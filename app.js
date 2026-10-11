/* =========================================================
   Consultorio · registro de asistencia con firma
   - Modo paciente: reloj, sesión actual según Google Calendar, firma.
   - Modo profesional (con PIN): agenda de hoy, fichas, ajustes.
   - Datos en la tablet (IndexedDB) + copia en Google Drive vía Apps Script.
   ========================================================= */
'use strict';

const APP_VERSION = '1.0.1';

/* ---------------- utilidades ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const pad = n => String(n).padStart(2, '0');
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDMY = iso => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const fmtLong = d => cap(new Intl.DateTimeFormat('es-UY', { weekday: 'long', day: 'numeric', month: 'long' }).format(d));
const moneyFmt = new Intl.NumberFormat('es-UY', { style: 'currency', currency: 'UYU', maximumFractionDigits: 0 });
const money = v => (v === '' || v == null || isNaN(v)) ? '—' : moneyFmt.format(Number(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const STOP = new Set(['sesion', 'consulta', 'terapia', 'con', 'de', 'del', 'la', 'el', 'y', 'paciente', 'turno', 'cita', 'online', 'presencial']);
const tokens = s => norm(s).split(' ').filter(t => t.length > 1 && !STOP.has(t));

function initials(name) {
  const t = String(name || '').trim().split(/\s+/);
  return ((t[0]?.[0] || '') + (t[1]?.[0] || '')).toUpperCase() || '·';
}
const AV = [['--lav', '--lav-d'], ['--sage', '--sage-d'], ['--peach', '--peach-d'], ['--sky', '--sky-d'], ['--rose', '--rose-d'], ['--butter', '--butter-d']];
function avatar(name, cls = '') {
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = AV[h % AV.length];
  return `<div class="avatar ${cls}" style="--av:var(${a});--av-d:var(${b})">${esc(initials(name))}</div>`;
}

/* cédula uruguaya */
const ciDigits = s => String(s || '').replace(/\D/g, '');
function ciValid(s) {
  const d = ciDigits(s); if (d.length < 7 || d.length > 8) return false;
  const n = d.padStart(8, '0'); const w = [2, 9, 8, 7, 6, 3, 4]; let sum = 0;
  for (let i = 0; i < 7; i++) sum += (+n[i]) * w[i];
  return (10 - sum % 10) % 10 === +n[7];
}
function ciFmt(s) {
  const d = ciDigits(s); if (d.length < 7 || d.length > 8) return s || '';
  const n = d.padStart(8, '0');
  return `${String(+n.slice(0, 7)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${n[7]}`;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- base de datos local ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('consultorio', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('patients', { keyPath: 'id' });
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('patientId', 'patientId');
        db.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const st = t.objectStore(store);
      let out; const r = fn(st); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); },
  get(store, k) { return this.tx(store, 'readonly', s => s.get(k)); },
  put(store, v) { return this.tx(store, 'readwrite', s => s.put(v)); },
  del(store, k) { return this.tx(store, 'readwrite', s => s.delete(k)); },
  putMany(store, vs) { return this.tx(store, 'readwrite', s => { vs.forEach(v => s.put(v)); }); },
  clear(store) { return this.tx(store, 'readwrite', s => s.clear()); },
  async getKV(k, def) { const r = await this.get('kv', k); return r ? r.v : def; },
  setKV(k, v) { return this.put('kv', { k, v }); },
};

/* ---------------- estado ---------------- */
const DEFAULTS = {
  consultorio: '', scriptUrl: '', token: '',
  autoOpen: true, preMin: 10, lockMin: 3, wakeLock: true,
  pinHash: null, pinSalt: null, lastBackup: null,
};
const S = {
  settings: { ...DEFAULTS },
  patients: [], sessions: [], aliases: {},
  events: [], eventsDate: null, eventsUpdated: 0, eventsError: null, calName: '',
  mode: 'patient', view: 'home', params: {},
  dismissed: {}, lastActivity: Date.now(),
  syncing: false, syncError: null, homeKey: '',
};
const saveSettings = () => DB.setKV('settings', S.settings);
const livePatients = () => S.patients.filter(p => !p.deleted).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
const patientById = id => S.patients.find(p => p.id === id && !p.deleted);
const sessionsOf = pid => S.sessions.filter(s => s.patientId === pid && !s.deleted)
  .sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora));
const pendingCount = () => S.patients.filter(p => p.sync !== 'ok').length + S.sessions.filter(s => s.sync !== 'ok').length;

/* ---------------- calendario: emparejar eventos con pacientes ---------------- */
function matchEvent(ev) {
  const key = norm(ev.title);
  if (S.aliases[key]) { const p = patientById(S.aliases[key]); if (p) return p; }
  const tt = new Set(tokens(ev.title));
  if (!tt.size) return null;
  let best = null, bestScore = 0, tie = false;
  for (const p of livePatients()) {
    const nt = tokens(p.nombre); if (!nt.length) continue;
    const overlap = nt.filter(t => tt.has(t)).length;
    const need = Math.min(2, nt.length, tt.size);
    if (overlap < need) continue;
    const score = overlap + (overlap === nt.length ? .5 : 0) + (overlap === tt.size ? .25 : 0);
    if (score > bestScore) { best = p; bestScore = score; tie = false; }
    else if (score === bestScore) tie = true;
  }
  return tie ? null : best;
}
const evStart = ev => new Date(ev.start);
const evEnd = ev => new Date(ev.end);
function currentEvent(now = new Date()) {
  const pre = (S.settings.preMin || 0) * 60e3;
  const list = S.events.filter(e => evStart(e) - pre <= now && now < evEnd(e));
  list.sort((a, b) => evStart(b) - evStart(a));
  return list[0] || null;
}
function nextEvent(now = new Date()) {
  return S.events.filter(e => evStart(e) > now).sort((a, b) => evStart(a) - evStart(b))[0] || null;
}
function signedFor(ev, p) {
  const today = isoDate();
  return S.sessions.find(s => !s.deleted && s.fecha === today && (s.eventId === ev.id || (p && s.patientId === p.id && !s.eventId)));
}

/* ---------------- conexión con Google (Apps Script) ---------------- */
async function api(action, payload = {}, method = 'POST') {
  const { scriptUrl, token } = S.settings;
  if (!scriptUrl) throw new Error('Google no está conectado');
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    let res;
    if (method === 'GET') {
      const u = new URL(scriptUrl);
      u.searchParams.set('action', action); u.searchParams.set('token', token);
      Object.entries(payload).forEach(([k, v]) => u.searchParams.set(k, v));
      res = await fetch(u, { signal: ctrl.signal });
    } else {
      res = await fetch(scriptUrl, { method: 'POST', body: JSON.stringify({ action, token, ...payload }), signal: ctrl.signal });
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Error de Google');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Google tardó demasiado en responder');
    if (e instanceof SyntaxError || e instanceof TypeError) throw new Error('No se pudo conectar con el script de Google (revisá la URL y que esté implementado para "Cualquier persona")');
    throw e;
  } finally { clearTimeout(t); }
}

async function loadEvents(force = false) {
  const today = isoDate();
  if (!S.settings.scriptUrl || !navigator.onLine) return;
  if (!force && S.eventsDate === today && Date.now() - S.eventsUpdated < 5 * 60e3) return;
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
  try {
    const r = await api('events', { from: d0.toISOString(), to: d1.toISOString() }, 'GET');
    S.events = r.events || []; S.eventsDate = today; S.eventsUpdated = Date.now(); S.eventsError = null; S.calName = r.calendar || '';
    await DB.setKV('events', { date: today, list: S.events, updated: S.eventsUpdated, cal: S.calName });
  } catch (e) { S.eventsError = e.message; }
}

const patientPayload = p => ({
  id: p.id, nombre: p.nombre, ci: p.ci, telefono: p.telefono,
  emergenciaNombre: p.emergenciaNombre, emergenciaTel: p.emergenciaTel,
  valor: p.valor, valorActualizado: p.valorActualizado,
});

async function syncAll({ manual = false } = {}) {
  if (S.syncing) return;
  if (!S.settings.scriptUrl) { if (manual) toast('Primero conectá Google en Ajustes', 'err'); return; }
  if (!navigator.onLine) { if (manual) toast('Sin internet: se sincroniza cuando vuelva la conexión', 'err'); return; }
  S.syncing = true; S.syncError = null; refreshSyncUI();
  let n = 0;
  try {
    for (const p of S.patients.filter(p => p.sync !== 'ok')) {
      if (p.deleted) await api('deletePatient', { id: p.id });
      else await api('upsertPatient', { patient: patientPayload(p) });
      p.sync = 'ok'; await DB.put('patients', p); n++;
    }
    for (const s of S.sessions.filter(s => s.sync !== 'ok')) {
      if (s.deleted) {
        await api('deleteSession', { id: s.id });
        await DB.del('sessions', s.id); S.sessions = S.sessions.filter(x => x.id !== s.id);
      } else {
        const p = S.patients.find(x => x.id === s.patientId);
        const r = await api('saveSession', { session: s, patient: p ? patientPayload(p) : null });
        s.sync = 'ok'; s.driveUrl = r.fileUrl || s.driveUrl; await DB.put('sessions', s);
      }
      n++;
    }
    // respaldo completo diario en Drive
    if (S.settings.lastBackup !== isoDate()) await backupToDrive(true);
    if (manual) toast(n ? `Sincronizado (${n} cambio${n > 1 ? 's' : ''})` : 'Todo está al día en Drive', 'ok');
  } catch (e) {
    S.syncError = e.message; if (manual) toast(e.message, 'err');
  } finally { S.syncing = false; refreshSyncUI(); }
}

function exportData() {
  return {
    app: 'consultorio', version: APP_VERSION, exportedAt: new Date().toISOString(),
    consultorio: S.settings.consultorio,
    patients: S.patients, sessions: S.sessions.filter(s => !s.deleted), aliases: S.aliases,
  };
}
async function backupToDrive(silent = false) {
  const r = await api('backup', { data: exportData() });
  S.settings.lastBackup = isoDate(); await saveSettings();
  if (!silent) toast('Respaldo guardado en Drive', 'ok');
  return r;
}
async function importData(data, { fromDrive = false } = {}) {
  if (!data || data.app !== 'consultorio') throw new Error('El archivo no es un respaldo de esta app');
  const have = new Set(S.sessions.map(s => s.id));
  const pats = (data.patients || []).map(p => ({ ...p, sync: fromDrive ? 'ok' : (p.sync || 'pending') }));
  const sess = (data.sessions || []).filter(s => !have.has(s.id)).map(s => ({ ...s, sync: fromDrive ? 'ok' : (s.sync || 'pending') }));
  await DB.putMany('patients', pats);
  await DB.putMany('sessions', sess);
  S.aliases = { ...(data.aliases || {}), ...S.aliases }; await DB.setKV('aliases', S.aliases);
  if (data.consultorio && !S.settings.consultorio) { S.settings.consultorio = data.consultorio; await saveSettings(); }
  S.patients = await DB.all('patients'); S.sessions = await DB.all('sessions');
  return { p: pats.length, s: sess.length };
}

/* ---------------- UI genérica ---------------- */
function toast(msg, kind = '') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg;
  $('#toast-root').appendChild(el); setTimeout(() => el.remove(), 3600);
}
let modalCleanup = null;
function openModal(html, { wide = false, onMount, dismiss = true } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const back = $('.modal-back', root);
  if (dismiss) back.addEventListener('click', e => { if (e.target === back) closeModal(); });
  if (onMount) modalCleanup = onMount($('.modal', root)) || null;
  return $('.modal', root);
}
function closeModal() { if (modalCleanup) { try { modalCleanup(); } catch { } modalCleanup = null; } $('#modal-root').innerHTML = ''; }
function confirmBox(title, text, okLabel = 'Aceptar', danger = false) {
  return new Promise(res => {
    openModal(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
      <div class="modal-actions"><button class="btn ghost" data-r="0">Cancelar</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okLabel)}</button></div>`, {
      onMount: m => { $$('[data-r]', m).forEach(b => b.onclick = () => { closeModal(); res(b.dataset.r === '1'); }); },
    });
  });
}

/* teclado PIN reutilizable */
function pinPad(container, { onComplete }) {
  let val = '';
  container.innerHTML = `<div class="pin-box"><div class="pin-dots">${'<i></i>'.repeat(4)}</div>
    <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" data-k="${n}">${n}</button>`).join('')}
    <button type="button" class="blank"></button><button type="button" data-k="0">0</button>
    <button type="button" data-k="del" aria-label="Borrar">${icon('back')}</button></div>
    <div class="pin-msg"></div></div>`;
  const dots = $$('.pin-dots i', container);
  const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < val.length));
  const api = {
    reset(msg = '') { val = ''; paint(); $('.pin-msg', container).textContent = msg; if (msg) { const d = $('.pin-dots', container); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); } },
  };
  container.addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'del') val = val.slice(0, -1);
    else if (val.length < 4) val += k;
    paint();
    if (val.length === 4) setTimeout(() => onComplete(val, api), 120);
  });
  return api;
}
async function checkPin(pin) { return (await sha256(S.settings.pinSalt + ':' + pin)) === S.settings.pinHash; }
function askPin(title = 'Acceso profesional') {
  return new Promise(res => {
    openModal(`<div style="text-align:center"><h2>${esc(title)}</h2><p class="muted">Ingresá tu PIN de 4 dígitos</p></div><div id="pp"></div>
      <div class="modal-actions" style="justify-content:center"><button class="btn ghost" id="pin-cancel">Cancelar</button></div>`, {
      onMount: m => {
        $('#pin-cancel', m).onclick = () => { closeModal(); res(false); };
        pinPad($('#pp', m), { onComplete: async (v, pad) => { if (await checkPin(v)) { closeModal(); res(true); } else pad.reset('PIN incorrecto'); } });
      },
    });
  });
}

/* ---------------- navegación ---------------- */
function go(view, params = {}) { S.view = view; S.params = params; closeModal(); render(); window.scrollTo(0, 0); }
async function enterPro(view = 'today') {
  if (!(await askPin())) return;
  S.mode = 'pro'; S.lastActivity = Date.now(); releaseWake();
  go(view); loadEvents().then(() => { if (S.mode === 'pro' && S.view === 'today') render(); });
}
function exitPro() { S.mode = 'patient'; go('home'); requestWake(); }
function openSign(pid, ev = null) { S.mode = 'patient'; go('sign', { pid, ev }); requestWake(); }

function render() {
  const app = $('#app');
  if (!S.settings.pinHash) return renderOnboarding(app);
  if (S.mode === 'patient') return S.view === 'sign' ? renderSign(app) : renderHome(app);
  renderPro(app);
}

/* ================= ONBOARDING ================= */
function renderOnboarding(app) {
  const step = S.params.step || 1;
  if (step === 1) {
    app.innerHTML = `<div class="onb"><div class="card">
      <div class="logo">${icon('leaf')}</div>
      <h1>Bienvenida a tu consultorio</h1>
      <p class="muted">Tus pacientes van a firmar su asistencia en esta tablet. Empecemos con dos datos.</p>
      <div class="field"><label for="o-name">Nombre del consultorio (opcional)</label>
        <input id="o-name" placeholder="Ej: Espacio Calma" value="${esc(S.settings.consultorio)}"></div>
      <div class="btn-row" style="justify-content:center;margin-top:26px"><button class="btn primary big" id="o-next">Continuar</button></div>
    </div></div>`;
    $('#o-next').onclick = () => { S.settings.consultorio = $('#o-name').value.trim(); S.params = { step: 2 }; render(); };
    return;
  }
  const first = S.params.first;
  app.innerHTML = `<div class="onb"><div class="card">
    <div class="logo" style="background:var(--lav);color:var(--lav-d)">${icon('lock')}</div>
    <h1>${first ? 'Repetí el PIN' : 'Creá tu PIN'}</h1>
    <p class="muted">Con este PIN entrás a las fichas y ajustes. Los pacientes solo ven la pantalla de firma.</p>
    <div id="o-pin" style="margin-top:20px"></div>
    ${first ? '<button class="btn ghost" id="o-restart">Volver a empezar</button>' : ''}
  </div></div>`;
  if (first) $('#o-restart').onclick = () => { S.params = { step: 2 }; render(); };
  pinPad($('#o-pin'), {
    onComplete: async (v, pad) => {
      if (!first) { S.params = { step: 2, first: v }; render(); return; }
      if (v !== first) { pad.reset('No coinciden, probá de nuevo'); return; }
      S.settings.pinSalt = uid(); S.settings.pinHash = await sha256(S.settings.pinSalt + ':' + v);
      await saveSettings();
      S.mode = 'pro'; S.lastActivity = Date.now();
      go('settings'); toast('¡Listo! Ahora podés conectar Google y cargar pacientes', 'ok');
    },
  });
}

/* ================= MODO PACIENTE ================= */
function homeState() {
  const now = new Date(); const ev = currentEvent(now);
  if (ev) {
    const p = matchEvent(ev);
    if (p) return { kind: signedFor(ev, p) ? 'signed' : 'due', ev, p };
    return { kind: 'calm', ev };
  }
  return { kind: 'calm', next: nextEvent(now) };
}
function heroHTML(st) {
  const first = st.p ? esc(st.p.nombre.split(/\s+/)[0]) : '';
  if (st.kind === 'due') return `<section class="hero due">
      <p class="eyebrow">Tu sesión · ${hhmm(evStart(st.ev))} a ${hhmm(evEnd(st.ev))}</p>
      <h1>Hola, ${first}</h1>
      <p>Antes de empezar, firmá tu asistencia de hoy.</p>
      <button class="btn primary big" data-act="sign-now">${icon('pen')} Firmar asistencia</button></section>`;
  if (st.kind === 'signed') return `<section class="hero">
      <div class="check-bubble">${icon('check')}</div>
      <h1>¡Gracias, ${first}!</h1><p>Tu asistencia de hoy ya quedó registrada.</p></section>`;
  return `<section class="hero">
      <div class="breath"><span>Inhalá…</span><span>Exhalá…</span></div>
      <h1>Te damos la bienvenida</h1>
      <p>Ponete cómodo, en un ratito comenzamos.</p>
      ${st.next ? `<p class="muted small">Próxima sesión: ${hhmm(evStart(st.next))}</p>` : ''}</section>`;
}
function homeKey(st) { return `${st.kind}|${st.ev?.id || ''}|${st.p?.id || ''}|${st.next?.id || ''}`; }
function renderHome(app) {
  const now = new Date(); const st = homeState(); S.homeKey = homeKey(st);
  app.innerHTML = `<div class="kiosk">
    <header class="kiosk-top">
      <div class="brand">${icon('leaf')}<span>${esc(S.settings.consultorio || 'Consultorio')}</span></div>
      <button class="icon-btn soft" data-act="pro" aria-label="Acceso profesional">${icon('lock')}</button>
    </header>
    <main class="kiosk-main">
      <div class="clock" id="clock">${hhmm(now)}</div>
      <div class="today" id="today">${fmtLong(now)}</div>
      <div id="hero" style="width:100%;display:flex;justify-content:center">${heroHTML(st)}</div>
    </main>
    <footer class="kiosk-foot">Tomate un momento para vos</footer>
  </div>`;
}
function tickHome() {
  const now = new Date();
  const c = $('#clock'); if (c) c.textContent = hhmm(now);
  const t = $('#today'); if (t) t.textContent = fmtLong(now);
  const st = homeState(); const k = homeKey(st);
  if (k !== S.homeKey) { S.homeKey = k; const h = $('#hero'); if (h) h.innerHTML = heroHTML(st); }
  if (S.settings.autoOpen && st.kind === 'due' && !S.dismissed[st.ev.id] && !$('.modal-back')) openSign(st.p.id, st.ev);
}

/* --------- firma --------- */
function renderSign(app) {
  const p = patientById(S.params.pid);
  if (!p) { go('home'); return; }
  const today = fmtDMY(isoDate());
  const ev = S.params.ev;
  app.innerHTML = `<div class="sign-view">
    <header class="sign-top">
      <button class="icon-btn soft" data-act="cancel-sign" aria-label="Volver">${icon('x')}</button>
      <div class="brand">${icon('leaf')}<span>Registro de asistencia</span></div>
      <span style="width:52px"></span>
    </header>
    <div class="sign-info">
      ${avatar(p.nombre, 'lg')}
      <div class="grow"><p class="eyebrow">Paciente</p><h1>${esc(p.nombre)}</h1>
        ${ev ? `<p class="muted">Sesión de ${hhmm(evStart(ev))} a ${hhmm(evEnd(ev))}</p>` : ''}</div>
      <div class="date-pill">${icon('cal')}<div><span class="eyebrow">Fecha</span><strong>${today}</strong></div></div>
    </div>
    <div class="pad-wrap" id="pad-wrap"><canvas id="pad"></canvas><div class="pad-line"></div><div class="pad-hint">Firmá acá con el dedo o el lápiz</div></div>
    <p class="legal">Confirmo mi asistencia a la sesión del día ${today}.</p>
    <div class="sign-actions">
      <button class="btn ghost big" data-act="clear-sign">Borrar</button>
      <button class="btn primary big" data-act="confirm-sign" id="btn-confirm" disabled>${icon('check')} Confirmar firma</button>
    </div>
  </div>`;
  S.pad = new SignaturePad($('#pad'), () => {
    const has = !S.pad.isEmpty();
    $('#btn-confirm').disabled = !has; $('#pad-wrap').classList.toggle('has-ink', has);
  });
}

class SignaturePad {
  constructor(canvas, onChange) {
    this.c = canvas; this.ctx = canvas.getContext('2d'); this.strokes = []; this.cur = null; this.onChange = onChange;
    this.dpr = Math.min(2, window.devicePixelRatio || 1); this.w = 0; this.h = 0; this.raf = 0;
    this.resize = this.resize.bind(this); this.resize();
    this.ro = new ResizeObserver(() => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.resize); });
    this.ro.observe(canvas);
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => canvas.addEventListener(t, e => this.up(e)));
  }
  resize() {
    const r = this.c.getBoundingClientRect(); const dpr = this.dpr;
    const w = Math.round(r.width), h = Math.round(r.height);
    if (!w || !h || (w === this.w && h === this.h)) return;
    this.w = w; this.h = h;
    this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.redraw();
  }
  pt(e) { const r = this.c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp, p: e.pressure || .5 }; }
  down(e) { e.preventDefault(); this.c.setPointerCapture(e.pointerId); this.cur = [this.pt(e)]; this.strokes.push(this.cur); this.dot(this.cur[0]); }
  move(e) {
    if (!this.cur) return; e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of evs) { const p = this.pt(ce); const last = this.cur[this.cur.length - 1]; if (Math.hypot(p.x - last.x, p.y - last.y) < 1.2) continue; this.cur.push(p); this.seg(this.cur, this.cur.length - 1); }
  }
  up() { if (!this.cur) return; this.cur = null; this.onChange?.(); }
  width(a, b) {
    const v = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, b.t - a.t);
    const pr = (b.p && b.p !== .5) ? b.p : .55;
    return Math.max(1.4, Math.min(4.2, (3.9 - v * 1.4) * (0.6 + pr * .8)));
  }
  dot(p) { const x = this.ctx; x.fillStyle = '#3B3755'; x.beginPath(); x.arc(p.x, p.y, 1.6, 0, Math.PI * 2); x.fill(); }
  seg(s, i) {
    const x = this.ctx; const a = s[i - 2] || s[i - 1], b = s[i - 1], c = s[i];
    const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, m2 = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
    x.strokeStyle = '#3B3755'; x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = this.width(b, c);
    x.beginPath(); x.moveTo(m1.x, m1.y); x.quadraticCurveTo(b.x, b.y, m2.x, m2.y); x.stroke();
  }
  redraw() {
    const r = this.c.getBoundingClientRect(); this.ctx.clearRect(0, 0, r.width, r.height);
    for (const s of this.strokes) { this.dot(s[0]); for (let i = 1; i < s.length; i++) this.seg(s, i); }
  }
  clear() { this.strokes = []; this.redraw(); this.onChange?.(); }
  isEmpty() { return !this.strokes.some(s => s.length > 2) && this.strokes.length < 3; }
  toPNG(maxW = 640) {
    const pts = this.strokes.flat(); if (!pts.length) return null;
    const dpr = this.dpr, padd = 14;
    let x0 = Math.min(...pts.map(p => p.x)) - padd, y0 = Math.min(...pts.map(p => p.y)) - padd;
    let x1 = Math.max(...pts.map(p => p.x)) + padd, y1 = Math.max(...pts.map(p => p.y)) + padd;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    const w = x1 - x0, h = y1 - y0; const scale = Math.min(1, maxW / w);
    const out = document.createElement('canvas'); out.width = Math.round(w * scale); out.height = Math.round(h * scale);
    const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
    o.drawImage(this.c, x0 * dpr, y0 * dpr, w * dpr, h * dpr, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }
  destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); }
}

async function confirmSign() {
  const p = patientById(S.params.pid); if (!p || !S.pad || S.pad.isEmpty()) return;
  const ev = S.params.ev; const now = new Date();
  const s = {
    id: uid(), patientId: p.id, fecha: isoDate(now), hora: hhmm(now),
    firma: S.pad.toPNG(), valor: p.valor ?? null,
    eventId: ev?.id || null, eventTitulo: ev?.title || null, eventInicio: ev?.start || null,
    creado: now.toISOString(), sync: 'pending',
  };
  await DB.put('sessions', s); S.sessions.push(s);
  S.pad.destroy(); S.pad = null;
  const first = esc(p.nombre.split(/\s+/)[0]);
  const ov = document.createElement('div'); ov.className = 'thanks';
  ov.innerHTML = `<div class="check-bubble">${icon('check')}</div><h1>¡Gracias, ${first}!</h1><p>Tu firma del ${fmtDMY(s.fecha)} quedó guardada.<br>Que tengas una linda sesión.</p>`;
  document.body.appendChild(ov);
  syncAll();
  setTimeout(() => { ov.remove(); go('home'); }, 4000);
}

/* ================= MODO PROFESIONAL ================= */
function renderPro(app) {
  const v = S.view; const nav = (k, ic, label) => `<button class="rail-btn ${v === k || (k === 'patients' && v === 'patient') ? 'on' : ''}" data-nav="${k}">${icon(ic)}<span>${label}</span></button>`;
  app.innerHTML = `<div class="pro">
    <nav class="rail">
      <div class="rail-brand">${icon('leaf')}</div>
      ${nav('today', 'cal', 'Hoy')}${nav('patients', 'users', 'Pacientes')}${nav('settings', 'sliders', 'Ajustes')}
      <div class="rail-spacer"></div>
      <div class="sync-dot" id="sync-dot" title="Sincronización"></div>
      <button class="rail-btn exit" data-act="exit-pro">${icon('lock')}<span>Modo paciente</span></button>
    </nav>
    <main class="pro-main" id="pro-main"></main>
  </div>`;
  const main = $('#pro-main');
  const views = { today: viewToday, patients: viewPatients, patient: viewPatient, settings: viewSettings };
  (views[v] || viewToday)(main);
  refreshSyncUI();
}
function refreshSyncUI() {
  const d = $('#sync-dot'); if (d) {
    const n = pendingCount();
    d.className = 'sync-dot ' + (!S.settings.scriptUrl ? 'off' : n ? 'pending' : 'ok');
    d.title = !S.settings.scriptUrl ? 'Google sin conectar' : n ? `${n} cambio(s) sin subir a Drive` : 'Todo guardado en Drive';
  }
  const st = $('#sync-status'); if (st) st.innerHTML = syncStatusHTML();
}
function syncStatusHTML() {
  if (!S.settings.scriptUrl) return `<span class="sync-dot off"></span> Google sin conectar`;
  if (S.syncing) return `<span class="sync-dot pending"></span> Sincronizando…`;
  const n = pendingCount();
  if (S.syncError) return `<span class="sync-dot pending"></span> ${n} pendiente(s) · ${esc(S.syncError)}`;
  return n ? `<span class="sync-dot pending"></span> ${n} cambio(s) esperando para subir` : `<span class="sync-dot ok"></span> Todo guardado en Drive`;
}

/* --------- Hoy --------- */
function viewToday(main) {
  const now = new Date(); const today = isoDate();
  const evs = [...S.events].sort((a, b) => evStart(a) - evStart(b));
  const cur = currentEvent(now);
  const usedIds = new Set();
  const rows = evs.map(ev => {
    const p = matchEvent(ev); const s = signedFor(ev, p); if (s) usedIds.add(s.id);
    const past = evEnd(ev) < now, isNow = cur && cur.id === ev.id;
    return `<div class="ev-row ${isNow ? 'now' : ''} ${past ? 'past' : ''} ${s ? 'done' : ''}">
      <div class="ev-time"><strong>${hhmm(evStart(ev))}</strong><span>${hhmm(evEnd(ev))}</span></div>
      <div><div class="ev-title">${esc(ev.title || '(sin título)')}</div>
        ${isNow ? `<span class="chip now">${icon('clock')} Ahora</span> ` : ''}
        ${p ? `<span class="chip ok">${icon('user')} ${esc(p.nombre)}</span>` : `<span class="chip warn">${icon('info')} Sin ficha vinculada</span>`}</div>
      <div class="ev-actions">
        ${s ? `<span class="badge-ok">${icon('check')} Firmó ${esc(s.hora)}</span>` : ''}
        ${p && !s ? `<button class="btn primary small" data-act="sign-for" data-pid="${p.id}" data-eid="${esc(ev.id)}">${icon('pen')} Pasar a firma</button>` : ''}
        ${p ? `<button class="btn soft small" data-act="open-patient" data-pid="${p.id}">Ficha</button>` : `
          <button class="btn sage small" data-act="new-from-event" data-eid="${esc(ev.id)}">${icon('plus')} Crear ficha</button>
          <button class="btn soft small" data-act="link-event" data-eid="${esc(ev.id)}">${icon('link')} Vincular</button>`}
      </div></div>`;
  }).join('');
  const extra = S.sessions.filter(s => !s.deleted && s.fecha === today && !usedIds.has(s.id));
  main.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">Agenda de hoy</p><h1>${fmtLong(now)}</h1></div>
      <div class="actions"><button class="btn soft" data-act="refresh-events">${icon('refresh')} Actualizar</button></div></header>
    ${!S.settings.scriptUrl ? `<div class="note lav">${icon('cal')}<div class="grow"><strong>Conectá tu Google Calendar</strong><p>Así la app sabe a quién le toca según la hora y abre su sesión sola.</p></div><button class="btn small" data-nav="settings">Ir a Ajustes</button></div>` : ''}
    ${S.eventsError ? `<div class="note rose">${icon('info')}<div class="grow"><strong>No se pudo leer el calendario</strong><p>${esc(S.eventsError)}</p></div></div>` : ''}
    ${S.settings.scriptUrl ? `<p class="muted small" style="margin:-10px 0 16px">${S.calName ? `Calendario «${esc(S.calName)}» · ` : ''}${S.eventsUpdated ? 'actualizado ' + hhmm(new Date(S.eventsUpdated)) : 'sin actualizar'}</p>` : ''}
    ${evs.length ? `<div class="ev-list">${rows}</div>` : `<div class="card empty">${icon('leaf')}<p>${S.settings.scriptUrl ? 'No hay sesiones en el calendario para hoy.' : 'Todavía no hay calendario conectado.'}</p></div>`}
    ${extra.length ? `<div class="section-title" style="margin-top:28px"><h2>Otras firmas de hoy</h2></div><div class="ev-list">${extra.map(s => {
    const p = S.patients.find(x => x.id === s.patientId);
    return `<div class="ev-row done"><div class="ev-time"><strong>${esc(s.hora)}</strong></div><div class="ev-title">${esc(p?.nombre || 'Paciente eliminado')}</div>
      <div class="ev-actions"><span class="badge-ok">${icon('check')} Firmó</span>${p && !p.deleted ? `<button class="btn soft small" data-act="open-patient" data-pid="${p.id}">Ficha</button>` : ''}</div></div>`;
  }).join('')}</div>` : ''}`;
}

/* --------- Pacientes --------- */
function viewPatients(main) {
  main.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">Fichas</p><h1>Pacientes</h1></div>
      <div class="actions"><div class="search">${icon('search')}<input id="q" type="search" placeholder="Buscar por nombre o cédula" value="${esc(S.params.q || '')}"></div>
      <button class="btn primary" data-act="new-patient">${icon('plus')} Nuevo paciente</button></div></header>
    <div id="plist"></div>`;
  const draw = () => {
    const q = norm($('#q').value); const qd = ciDigits($('#q').value);
    const list = livePatients().filter(p => !q || norm(p.nombre).includes(q) || (qd && ciDigits(p.ci).includes(qd)));
    $('#plist').innerHTML = list.length ? `<div class="p-grid">${list.map(p => {
      const ss = sessionsOf(p.id);
      return `<button class="p-card" data-act="open-patient" data-pid="${p.id}">${avatar(p.nombre)}
        <div class="grow"><strong>${esc(p.nombre)}</strong><span>${p.ci ? 'CI ' + esc(ciFmt(p.ci)) + ' · ' : ''}${ss.length} sesión${ss.length === 1 ? '' : 'es'}${ss[0] ? ' · última ' + fmtDMY(ss[0].fecha) : ''}</span></div></button>`;
    }).join('')}</div>` : `<div class="card empty">${icon('users')}<p>${S.patients.length ? 'No hay coincidencias.' : 'Todavía no cargaste pacientes.'}</p>${!S.patients.length ? '<button class="btn primary" data-act="new-patient" style="margin-top:14px">Cargar el primero</button>' : ''}</div>`;
  };
  $('#q').addEventListener('input', e => { S.params.q = e.target.value; draw(); });
  draw();
}

function patientForm(p = null, prefill = {}) {
  const d = p || { nombre: prefill.nombre || '', ci: '', telefono: '', emergenciaNombre: '', emergenciaTel: '', valor: '' };
  return new Promise(res => {
    openModal(`<h2>${p ? 'Editar ficha' : 'Nuevo paciente'}</h2>
      <form id="pf" autocomplete="off">
        <div class="field"><label>Nombre y apellido *</label><input name="nombre" required value="${esc(d.nombre)}"></div>
        <div class="row2">
          <div class="field"><label>Cédula de identidad</label><input name="ci" inputmode="numeric" placeholder="1.234.567-8" value="${esc(ciFmt(d.ci))}"><span class="hint" id="ci-hint"></span></div>
          <div class="field"><label>Teléfono</label><input name="telefono" type="tel" inputmode="tel" placeholder="09X XXX XXX" value="${esc(d.telefono)}"></div>
        </div>
        <div class="row2">
          <div class="field"><label>Contacto de emergencia</label><input name="emergenciaNombre" placeholder="Nombre y vínculo" value="${esc(d.emergenciaNombre)}"></div>
          <div class="field"><label>Tel. de emergencia</label><input name="emergenciaTel" type="tel" inputmode="tel" value="${esc(d.emergenciaTel)}"></div>
        </div>
        <div class="field"><label>Valor de la consulta</label><div class="prefix"><span>$</span><input name="valor" inputmode="numeric" placeholder="0" value="${d.valor ?? ''}"></div>
          ${p ? '<span class="hint">Si lo cambiás, se guarda en el historial con la fecha de hoy.</span>' : ''}</div>
        <div class="modal-actions">
          ${p ? `<button type="button" class="btn danger" id="pf-del">${icon('trash')} Eliminar</button><span class="spacer"></span>` : ''}
          <button type="button" class="btn ghost" id="pf-cancel">Cancelar</button>
          <button type="submit" class="btn primary">${icon('check')} Guardar</button>
        </div>
      </form>`, {
      wide: true,
      onMount: m => {
        const f = $('#pf', m); const ci = f.ci; const hint = $('#ci-hint', m);
        const checkCi = () => { const v = ci.value.trim(); hint.className = 'hint' + (v && !ciValid(v) ? ' warn' : ''); hint.textContent = !v ? '' : ciValid(v) ? '✓ Cédula válida' : 'Revisá la cédula: el dígito verificador no coincide'; };
        ci.addEventListener('blur', () => { ci.value = ciFmt(ci.value); checkCi(); }); ci.addEventListener('input', checkCi); checkCi();
        $('#pf-cancel', m).onclick = () => { closeModal(); res(null); };
        if (p) $('#pf-del', m).onclick = async () => { closeModal(); res({ delete: true }); };
        f.onsubmit = e => {
          e.preventDefault();
          const v = Object.fromEntries(new FormData(f));
          v.nombre = v.nombre.trim().replace(/\s+/g, ' ');
          if (!v.nombre) return;
          v.ci = ciDigits(v.ci) ? ciFmt(v.ci) : '';
          const num = String(v.valor).replace(/[^\d]/g, ''); v.valor = num ? Number(num) : null;
          closeModal(); res(v);
        };
        setTimeout(() => f.nombre.focus(), 50);
      },
    });
  });
}
async function savePatientFromForm(p, v) {
  const today = isoDate(); const now = new Date().toISOString();
  if (!p) {
    p = { id: uid(), creado: now, valorHistorial: [], ...v };
    if (v.valor != null) { p.valorActualizado = today; p.valorHistorial = [{ valor: v.valor, fecha: today }]; }
    S.patients.push(p);
  } else {
    if (v.valor !== p.valor) { p.valorHistorial = [...(p.valorHistorial || []), { valor: v.valor, fecha: today }]; p.valorActualizado = today; }
    Object.assign(p, v);
  }
  p.actualizado = now; p.sync = 'pending';
  await DB.put('patients', p); syncAll();
  return p;
}
async function newPatient(prefill = {}, linkEvent = null) {
  const v = await patientForm(null, prefill); if (!v) return null;
  const dup = livePatients().find(x => v.ci && ciDigits(x.ci) === ciDigits(v.ci));
  if (dup && !(await confirmBox('Cédula repetida', `${dup.nombre} ya tiene esa cédula. ¿Guardar igual?`, 'Guardar igual'))) return null;
  const p = await savePatientFromForm(null, v);
  if (linkEvent && !matchEvent(linkEvent)) { S.aliases[norm(linkEvent.title)] = p.id; await DB.setKV('aliases', S.aliases); }
  toast('Ficha creada', 'ok'); return p;
}

/* --------- Ficha --------- */
function viewPatient(main) {
  const p = patientById(S.params.pid); if (!p) { go('patients'); return; }
  const ss = sessionsOf(p.id);
  const hist = [...(p.valorHistorial || [])].reverse();
  main.innerHTML = `
    <button class="back" data-nav="patients">${icon('back')} Pacientes</button>
    <header class="ficha-head">${avatar(p.nombre, 'xl')}
      <div class="grow"><p class="eyebrow">Ficha del paciente</p><h1>${esc(p.nombre)}</h1>
        <p class="muted">${ss.length} sesión${ss.length === 1 ? '' : 'es'} firmada${ss.length === 1 ? '' : 's'}${ss[0] ? ' · última el ' + fmtDMY(ss[0].fecha) : ''}</p></div>
      <div class="actions">
        <button class="btn primary" data-act="sign-for" data-pid="${p.id}">${icon('pen')} Pasar a firma</button>
        <button class="btn soft" data-act="edit-patient" data-pid="${p.id}">${icon('edit')} Editar</button>
        <button class="btn soft" data-act="print-patient" data-pid="${p.id}">${icon('print')} PDF</button>
      </div></header>
    <div class="info-grid">
      <div class="info sky">${icon('id')}<span class="label">Cédula</span><strong>${esc(p.ci || '—')}</strong></div>
      <div class="info sage">${icon('phone')}<span class="label">Teléfono</span><strong>${p.telefono ? `<a href="tel:${esc(p.telefono.replace(/\s/g, ''))}">${esc(p.telefono)}</a>` : '—'}</strong></div>
      <div class="info rose">${icon('heart')}<span class="label">Contacto de emergencia</span><strong>${esc(p.emergenciaNombre || '—')}</strong>
        ${p.emergenciaTel ? `<small><a href="tel:${esc(p.emergenciaTel.replace(/\s/g, ''))}">${esc(p.emergenciaTel)}</a></small>` : ''}</div>
      <div class="info butter">${icon('coin')}<span class="label">Valor de la consulta</span><strong>${money(p.valor)}</strong>
        <small>${p.valorActualizado ? 'Actualizado el ' + fmtDMY(p.valorActualizado) : 'Sin valor cargado'}</small>
        <button class="btn small" data-act="update-fee" data-pid="${p.id}">Actualizar valor</button></div>
    </div>
    ${hist.length > 1 ? `<details class="card" style="margin-bottom:24px"><summary>Historial de valores</summary><table class="fee-hist">${hist.map(h => `<tr><td>${fmtDMY(h.fecha)}</td><td style="text-align:right"><strong>${money(h.valor)}</strong></td></tr>`).join('')}</table></details>` : ''}
    <div class="section-title"><h2>Sesiones firmadas</h2></div>
    ${ss.length ? `<div class="s-grid">${ss.map(s => `<div class="s-card">
      <div class="top"><div><strong>${fmtDMY(s.fecha)}</strong><div class="meta">${esc(s.hora)} hs${s.valor != null ? ' · ' + money(s.valor) : ''}</div></div>
        <button class="icon-btn sm soft" data-act="del-session" data-sid="${s.id}" aria-label="Eliminar firma">${icon('trash')}</button></div>
      <img src="${s.firma}" alt="Firma del ${fmtDMY(s.fecha)}">
      <span class="cloud ${s.sync === 'ok' ? 'ok' : 'pending'}">${icon('cloud')} ${s.sync === 'ok' ? (s.driveUrl ? `<a href="${esc(s.driveUrl)}" target="_blank" rel="noopener" style="color:inherit">En Drive</a>` : 'En Drive') : 'Pendiente de subir'}</span>
    </div>`).join('')}</div>` : `<div class="card empty">${icon('pen')}<p>Todavía no hay firmas.</p></div>`}`;
}

function printPatient(p) {
  const ss = sessionsOf(p.id).slice().reverse();
  $('#print-root').innerHTML = `
    <p style="color:#888;margin:0">${esc(S.settings.consultorio || 'Consultorio')} · Registro de asistencia</p>
    <h1>${esc(p.nombre)}</h1>
    <div class="pr-meta">
      <div><b>Cédula:</b> ${esc(p.ci || '—')}</div><div><b>Teléfono:</b> ${esc(p.telefono || '—')}</div>
      <div><b>Contacto de emergencia:</b> ${esc(p.emergenciaNombre || '—')} ${esc(p.emergenciaTel || '')}</div>
      <div><b>Valor de la consulta:</b> ${money(p.valor)}${p.valorActualizado ? ' (desde ' + fmtDMY(p.valorActualizado) + ')' : ''}</div>
    </div>
    <table><thead><tr><th>#</th><th>Fecha</th><th>Hora</th><th>Valor</th><th>Firma</th></tr></thead>
    <tbody>${ss.map((s, i) => `<tr><td>${i + 1}</td><td>${fmtDMY(s.fecha)}</td><td>${esc(s.hora)}</td><td>${s.valor != null ? money(s.valor) : '—'}</td><td><img src="${s.firma}"></td></tr>`).join('')}</tbody></table>
    <p style="color:#888;margin-top:14pt;font-size:9pt">Generado el ${fmtDMY(isoDate())} ${hhmm(new Date())}</p>`;
  setTimeout(() => window.print(), 200);
}

/* --------- Ajustes --------- */
function viewSettings(main) {
  const st = S.settings;
  main.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">Configuración</p><h1>Ajustes</h1></div></header>
    <div class="set-grid">
      <div class="card">
        <h2>${icon('cal')} Google Calendar y Drive</h2>
        <p class="muted small">Pegá la URL del script de Google y la clave que elegiste (ver la guía de instalación).</p>
        <div class="field"><label>URL del script (termina en /exec)</label><input id="s-url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(st.scriptUrl)}"></div>
        <div class="field"><label>Clave secreta</label><input id="s-token" type="password" value="${esc(st.token)}"></div>
        <div class="btn-row"><button class="btn primary" data-act="save-google">${icon('link')} Guardar y probar</button>
          ${st.scriptUrl ? `<button class="btn ghost" data-act="disconnect-google">Desconectar</button>` : ''}</div>
        <div class="status-line" id="sync-status">${syncStatusHTML()}</div>
        ${st.scriptUrl ? `<div class="btn-row"><button class="btn sage" data-act="sync-now">${icon('refresh')} Sincronizar ahora</button></div>` : ''}
      </div>

      <div class="card">
        <h2>${icon('clock')} Modo paciente</h2>
        <label class="switch"><span>Abrir la firma sola según el calendario<small>Cuando empieza la sesión, se abre la pantalla de firma del paciente.</small></span><input type="checkbox" id="s-auto" ${st.autoOpen ? 'checked' : ''}></label>
        <div class="field"><label>Abrir cuántos minutos antes de la sesión</label>
          <select id="s-pre">${[0, 5, 10, 15, 20, 30].map(n => `<option value="${n}" ${+st.preMin === n ? 'selected' : ''}>${n ? n + ' minutos antes' : 'A la hora exacta'}</option>`).join('')}</select></div>
        <label class="switch"><span>Mantener la pantalla encendida<small>En modo paciente la tablet no se apaga sola.</small></span><input type="checkbox" id="s-wake" ${st.wakeLock ? 'checked' : ''}></label>
        <div class="field"><label>Volver a modo paciente tras inactividad</label>
          <select id="s-lock">${[1, 2, 3, 5, 10].map(n => `<option value="${n}" ${+st.lockMin === n ? 'selected' : ''}>${n} minuto${n > 1 ? 's' : ''}</option>`).join('')}</select></div>
      </div>

      <div class="card">
        <h2>${icon('leaf')} Consultorio</h2>
        <div class="field"><label>Nombre que ven los pacientes</label><input id="s-name" value="${esc(st.consultorio)}" placeholder="Consultorio"></div>
        <div class="btn-row"><button class="btn soft" data-act="change-pin">${icon('key')} Cambiar PIN</button></div>
      </div>

      <div class="card">
        <h2>${icon('download')} Respaldo</h2>
        <p class="muted small">La app hace un respaldo completo en Drive una vez por día. También podés guardarlo como archivo o restaurarlo en otra tablet.</p>
        <div class="btn-row">
          <button class="btn soft" data-act="export-file">${icon('download')} Descargar respaldo</button>
          <label class="btn soft" style="cursor:pointer">${icon('upload')} Importar archivo<input type="file" id="s-import" accept=".json,application/json" hidden></label>
        </div>
        ${st.scriptUrl ? `<div class="btn-row"><button class="btn sage" data-act="backup-drive">${icon('cloud')} Respaldar en Drive</button>
          <button class="btn ghost" data-act="restore-drive">Restaurar desde Drive</button></div>` : ''}
        <p class="muted small" style="margin-top:12px">Último respaldo en Drive: ${st.lastBackup ? fmtDMY(st.lastBackup) : 'nunca'} · Versión ${APP_VERSION}</p>
      </div>
    </div>`;
  const bind = (id, key, fn = v => v) => $(id).addEventListener('change', async e => { st[key] = fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value); await saveSettings(); toast('Guardado', 'ok'); });
  bind('#s-auto', 'autoOpen'); bind('#s-wake', 'wakeLock'); bind('#s-pre', 'preMin', Number); bind('#s-lock', 'lockMin', Number); bind('#s-name', 'consultorio', v => v.trim());
  $('#s-import').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await importData(JSON.parse(await f.text())); toast(`Importado: ${r.p} pacientes, ${r.s} firmas nuevas`, 'ok'); syncAll(); }
    catch (err) { toast(err.message, 'err'); }
    e.target.value = '';
  });
}

/* ---------------- acciones (delegación de eventos) ---------------- */
const findEvent = id => S.events.find(e => e.id === id);
const ACTIONS = {
  'pro': () => enterPro(),
  'exit-pro': () => exitPro(),
  'sign-now': () => { const st = homeState(); if (st.p) openSign(st.p.id, st.ev); },
  'cancel-sign': () => { if (S.params.ev) S.dismissed[S.params.ev.id] = true; S.pad?.destroy(); S.pad = null; go('home'); },
  'clear-sign': () => S.pad?.clear(),
  'confirm-sign': el => { el.disabled = true; confirmSign(); },
  'sign-for': el => openSign(el.dataset.pid, el.dataset.eid ? findEvent(el.dataset.eid) : null),
  'open-patient': el => go('patient', { pid: el.dataset.pid }),
  'refresh-events': async el => { el.disabled = true; await loadEvents(true); render(); if (!S.eventsError && S.settings.scriptUrl) toast('Calendario actualizado', 'ok'); },
  'new-patient': async () => { const p = await newPatient(); if (p) go('patient', { pid: p.id }); },
  'new-from-event': async el => { const ev = findEvent(el.dataset.eid); const p = await newPatient({ nombre: ev?.title.replace(/^(sesi[oó]n|consulta|terapia)\s*[-:–]?\s*/i, '') }, ev); if (p) render(); },
  'link-event': el => {
    const ev = findEvent(el.dataset.eid); if (!ev) return;
    const list = livePatients();
    if (!list.length) { toast('Primero creá la ficha del paciente', 'err'); return; }
    openModal(`<h2>Vincular evento</h2><p class="muted">¿A qué paciente corresponde «${esc(ev.title)}»? La app lo va a recordar para las próximas veces.</p>
      <div class="search" style="max-width:none;margin-top:16px">${icon('search')}<input id="lq" placeholder="Buscar"></div>
      <div id="ll" style="display:flex;flex-direction:column;gap:8px;margin-top:14px;max-height:50vh;overflow:auto"></div>
      <div class="modal-actions"><button class="btn ghost" id="lc">Cancelar</button></div>`, {
      onMount: m => {
        const draw = () => { const q = norm($('#lq', m).value); $('#ll', m).innerHTML = list.filter(p => !q || norm(p.nombre).includes(q)).map(p => `<button class="p-card" data-link="${p.id}">${avatar(p.nombre)}<div class="grow"><strong>${esc(p.nombre)}</strong><span>${esc(p.ci || '')}</span></div></button>`).join(''); };
        $('#lq', m).oninput = draw; draw(); $('#lc', m).onclick = closeModal;
        $('#ll', m).onclick = async e => { const b = e.target.closest('[data-link]'); if (!b) return; S.aliases[norm(ev.title)] = b.dataset.link; await DB.setKV('aliases', S.aliases); closeModal(); render(); toast('Evento vinculado', 'ok'); };
      },
    });
  },
  'edit-patient': async el => {
    const p = patientById(el.dataset.pid); const v = await patientForm(p); if (!v) return;
    if (v.delete) {
      if (!(await confirmBox('Eliminar ficha', `Se va a borrar la ficha de ${p.nombre} y sus firmas de esta tablet. En Drive las firmas se conservan y el paciente queda marcado como eliminado.`, 'Eliminar', true))) return;
      p.deleted = true; p.sync = 'pending'; await DB.put('patients', p);
      for (const s of S.sessions.filter(s => s.patientId === p.id)) await DB.del('sessions', s.id);
      S.sessions = S.sessions.filter(s => s.patientId !== p.id);
      Object.keys(S.aliases).forEach(k => { if (S.aliases[k] === p.id) delete S.aliases[k]; }); await DB.setKV('aliases', S.aliases);
      syncAll(); toast('Ficha eliminada'); go('patients'); return;
    }
    await savePatientFromForm(p, v); toast('Ficha actualizada', 'ok'); render();
  },
  'update-fee': el => {
    const p = patientById(el.dataset.pid);
    openModal(`<h2>Actualizar valor</h2><p class="muted">Valor actual: <strong>${money(p.valor)}</strong></p>
      <form id="ff"><div class="field"><label>Nuevo valor de la consulta</label><div class="prefix"><span>$</span><input name="v" inputmode="numeric" required></div></div>
      <div class="field"><label>Vigente desde</label><input name="f" type="date" value="${isoDate()}"></div>
      <div class="modal-actions"><button type="button" class="btn ghost" id="fc">Cancelar</button><button class="btn primary">${icon('check')} Guardar</button></div></form>`, {
      onMount: m => {
        $('#fc', m).onclick = closeModal; setTimeout(() => $('[name=v]', m).focus(), 50);
        $('#ff', m).onsubmit = async e => {
          e.preventDefault(); const n = Number(String(e.target.v.value).replace(/[^\d]/g, '')); if (!n) return;
          const f = e.target.f.value || isoDate();
          p.valor = n; p.valorActualizado = f; p.valorHistorial = [...(p.valorHistorial || []), { valor: n, fecha: f }];
          p.actualizado = new Date().toISOString(); p.sync = 'pending'; await DB.put('patients', p);
          closeModal(); render(); toast('Valor actualizado', 'ok'); syncAll();
        };
      },
    });
  },
  'del-session': async el => {
    const s = S.sessions.find(x => x.id === el.dataset.sid);
    if (!(await confirmBox('Eliminar firma', `¿Eliminar la firma del ${fmtDMY(s.fecha)} a las ${s.hora}? También se borra de Drive.`, 'Eliminar', true))) return;
    if (s.sync === 'ok') { s.deleted = true; s.sync = 'pending'; await DB.put('sessions', s); syncAll(); }
    else { await DB.del('sessions', s.id); S.sessions = S.sessions.filter(x => x.id !== s.id); }
    render(); toast('Firma eliminada');
  },
  'print-patient': el => printPatient(patientById(el.dataset.pid)),
  'save-google': async el => {
    let url = $('#s-url').value.trim(); const token = $('#s-token').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(url)) { toast('La URL tiene que ser de script.google.com y terminar en /exec', 'err'); return; }
    S.settings.scriptUrl = url; S.settings.token = token; el.disabled = true; $('#sync-status').innerHTML = '<span class="sync-dot pending"></span> Probando conexión…';
    try {
      const r = await api('ping', {}, 'GET'); await saveSettings();
      toast(`Conectado al calendario «${r.calendar}»`, 'ok');
      await loadEvents(true); syncAll(); render();
    } catch (e) { S.settings.scriptUrl = ''; await saveSettings(); el.disabled = false; $('#sync-status').innerHTML = `<span class="sync-dot off"></span> ${esc(e.message)}`; }
  },
  'disconnect-google': async () => {
    if (!(await confirmBox('Desconectar Google', 'La app deja de leer el calendario y de subir a Drive. Tus datos en la tablet y en Drive no se borran.', 'Desconectar'))) return;
    S.settings.scriptUrl = ''; S.settings.token = ''; S.events = []; await saveSettings(); render();
  },
  'sync-now': () => syncAll({ manual: true }),
  'backup-drive': async el => { el.disabled = true; try { await backupToDrive(); render(); } catch (e) { toast(e.message, 'err'); el.disabled = false; } },
  'restore-drive': async el => {
    if (!(await confirmBox('Restaurar desde Drive', 'Se traen los pacientes y firmas del último respaldo en Drive. Lo que ya está en la tablet se mantiene.', 'Restaurar'))) return;
    try { const r = await api('latestBackup', {}, 'GET'); if (!r.data) throw new Error('No hay respaldos en Drive todavía'); const n = await importData(r.data, { fromDrive: true }); toast(`Restaurado: ${n.p} pacientes, ${n.s} firmas`, 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  'export-file': () => {
    const blob = new Blob([JSON.stringify(exportData())], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `consultorio-respaldo-${isoDate()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'change-pin': async () => {
    if (!(await askPin('PIN actual'))) return;
    openModal(`<div style="text-align:center"><h2 id="cp-t">Nuevo PIN</h2><p class="muted" id="cp-s">Elegí 4 dígitos</p></div><div id="cp"></div>
      <div class="modal-actions" style="justify-content:center"><button class="btn ghost" id="cp-c">Cancelar</button></div>`, {
      onMount: m => {
        let first = null; $('#cp-c', m).onclick = closeModal;
        pinPad($('#cp', m), {
          onComplete: async (v, pad) => {
            if (!first) { first = v; $('#cp-t', m).textContent = 'Repetí el nuevo PIN'; $('#cp-s', m).textContent = ''; pad.reset(); return; }
            if (v !== first) { first = null; $('#cp-t', m).textContent = 'Nuevo PIN'; pad.reset('No coinciden, empezá de nuevo'); return; }
            S.settings.pinSalt = uid(); S.settings.pinHash = await sha256(S.settings.pinSalt + ':' + v); await saveSettings();
            closeModal(); toast('PIN actualizado', 'ok');
          },
        });
      },
    });
  },
};
document.addEventListener('click', e => {
  const n = e.target.closest('[data-nav]'); if (n && S.mode === 'pro') { go(n.dataset.nav); return; }
  const a = e.target.closest('[data-act]'); if (a && ACTIONS[a.dataset.act]) { e.preventDefault(); ACTIONS[a.dataset.act](a, e); }
});
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => { S.lastActivity = Date.now(); }, { passive: true }));

/* botón "atrás" de Android */
function handleBack() {
  if ($('.modal-back')) { closeModal(); return; }
  if (S.mode === 'patient' && S.view === 'sign') { ACTIONS['cancel-sign'](); return; }
  if (S.mode === 'pro' && S.view === 'patient') { go('patients'); return; }
  if (S.mode === 'pro') { exitPro(); }
}
window.addEventListener('popstate', () => { handleBack(); history.pushState({ app: 1 }, ''); });

/* pantalla siempre encendida en modo paciente */
let wakeLock = null;
async function requestWake() {
  if (!S.settings.wakeLock || !('wakeLock' in navigator) || S.mode !== 'patient' || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { }
}
function releaseWake() { try { wakeLock?.release(); } catch { } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { requestWake(); loadEvents().then(() => S.mode === 'patient' && S.view === 'home' && tickHome()); }
});
window.addEventListener('online', () => { syncAll(); loadEvents(true); });

/* reloj general */
let lastDay = isoDate();
function tick() {
  const today = isoDate();
  if (today !== lastDay) { lastDay = today; S.dismissed = {}; S.events = []; loadEvents(true); }
  if (S.mode === 'patient' && S.view === 'home') tickHome();
  if (S.mode === 'pro' && Date.now() - S.lastActivity > (S.settings.lockMin || 3) * 60e3) exitPro();
}

/* ---------------- arranque ---------------- */
async function boot() {
  await DB.open();
  S.settings = { ...DEFAULTS, ...(await DB.getKV('settings', {})) };
  S.patients = await DB.all('patients');
  S.sessions = await DB.all('sessions');
  S.aliases = await DB.getKV('aliases', {});
  const cached = await DB.getKV('events', null);
  if (cached && cached.date === isoDate()) { S.events = cached.list; S.eventsDate = cached.date; S.eventsUpdated = cached.updated; S.calName = cached.cal || ''; }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => { });
  history.replaceState({ app: 0 }, ''); history.pushState({ app: 1 }, '');
  render(); requestWake();
  loadEvents().then(() => { if (S.mode === 'patient' && S.view === 'home') tickHome(); });
  syncAll();
  setInterval(tick, 10e3);
  setInterval(() => { loadEvents(); syncAll(); }, 5 * 60e3);
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
boot().catch(e => { document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif"><h2>No se pudo iniciar la app</h2><p>${esc(e.message)}</p></div>`; });
