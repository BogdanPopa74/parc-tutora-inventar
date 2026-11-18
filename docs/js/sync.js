// Sincronizare live între dispozitive, printr-un depozit (repository) privat de pe GitHub.
//
// Fiecare dispozitiv citește și scrie aceleași fișiere mici din depozit:
//   date/R01.json … date/R21.json   seriile panourilor, câte un fișier pe rând de mese
//   date/echipamente.json           fișele echipamentelor, legăturile masă → invertor, lista fișierelor atașate
//   fisiere/<id>/<nume>             fișierele atașate (PDF, poze)
// La scriere se trimite și versiunea (sha) pe care o știm; dacă între timp a scris altcineva,
// GitHub refuză, luăm varianta nouă, o unim cu a noastră și trimitem din nou. Pentru fiecare
// înregistrare câștigă modificarea cea mai recentă, deci nu se pierde nimic.
import * as store from './store.js';

const API = () => window.__PARC_API || 'https://api.github.com';
const TEST = window.__PARC_SYNC || {};             // doar pentru teste automate: intervale mai scurte
const POLL_MS = TEST.poll || 10000;                // cât de des verificăm dacă au apărut date noi
const PUSH_MS = TEST.push || 15000;                // cel mult o trimitere la 15 s, ca să nu depășim limitele GitHub
const MAX_FILE = 25 * 1024 * 1024;

export const state = { on: false, repo: '', status: 'off', error: '', lastSync: 0, pending: 0, skipped: [] };
let cfg = null;                 // { repo, token }
let meta = { shas: {}, dirty: [], etag: '', clean: {} };
let noEtag = false;             // devine true dacă cererile condiționate nu merg în acest browser
const dirty = new Set();
const version = new Map();      // de câte ori s-a modificat o bucată; ca să nu pierdem schimbări făcute în timpul trimiterii
let filesFail = 0, filesRetryAt = 0;
let busy = false, again = false, pushTimer = 0, pollTimer = 0, pausedUntil = 0, lastPush = 0;
const listeners = new Set();
export function onStatus(fn) { listeners.add(fn); }
function setStatus(status, error) {
  state.status = status; state.error = error || '';
  state.pending = dirty.size;
  for (const fn of listeners) fn(state);
}

// ---- Codul de conectare (pentru a adăuga rapid alte dispozitive) ----------------
const b64url = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (str) => decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/'))));
export function connectCode() { return cfg ? 'PARC1.' + b64url(JSON.stringify({ r: cfg.repo, t: cfg.token })) : ''; }
export function connectLink() { return location.origin + location.pathname + '#conectare=' + connectCode(); }
export function parseCode(text) {
  const m = String(text || '').match(/PARC1\.([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try { const o = JSON.parse(unb64url(m[1])); return o && o.r && o.t ? { repo: String(o.r), token: String(o.t) } : null; } catch (e) { return null; }
}

// ---- Cereri către GitHub ---------------------------------------------------------
function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function gitSha(text) {                       // același calcul ca al lui git, ca să nu trimitem conținut neschimbat
  if (!crypto.subtle) return '';
  const body = new TextEncoder().encode(text), head = new TextEncoder().encode('blob ' + body.length + '\0');
  const all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  const hash = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class HttpError extends Error {
  constructor(status, text, retryAfter) { super(text); this.status = status; this.retryAfter = retryAfter; }
}
async function gh(method, path, opts = {}) {
  const c = opts.cfg || cfg;
  const headers = { Authorization: 'Bearer ' + c.token, Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  if (opts.body) headers['Content-Type'] = 'application/json';
  return fetch(API() + '/repos/' + c.repo + path, { method, headers, cache: 'no-store', body: opts.body ? JSON.stringify(opts.body) : undefined });
}
async function fail(res) {
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch (e) { /* fără detalii */ }
  return new HttpError(res.status, msg, Number(res.headers.get('retry-after')) || 0);
}
const encPath = (path) => path.split('/').map(encodeURIComponent).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function explain(e) {
  if (!(e instanceof HttpError)) return 'Fără conexiune la internet. Datele rămân pe dispozitiv și se trimit când revine semnalul.';
  if (e.status === 401) return 'Tokenul GitHub nu este valid sau a expirat. Creează unul nou și reconectează.';
  if (e.status === 404) return 'Depozitul de date nu a fost găsit sau tokenul nu are acces la el.';
  if (e.status === 403 || e.status === 429) return /rate limit|abuse|secondary/i.test(e.message) ? 'GitHub limitează temporar cererile. Se reîncearcă singur.'
    : 'Tokenul nu are drept de scriere în depozit (permisiunea „Contents: Read and write”).';
  if (e.status === 409 || e.status === 422) return 'Depozitul a fost modificat în același timp de alt dispozitiv. Se reîncearcă singur.';
  return 'Eroare GitHub ' + e.status + (e.message ? ': ' + e.message : '');
}

// ---- Citire ------------------------------------------------------------------------
async function fetchChunk(name) {
  const res = await gh('GET', '/contents/date/' + name + '.json');
  if (res.status === 404) { delete meta.shas[name]; return; }
  if (!res.ok) throw await fail(res);
  const j = await res.json();
  let text;
  if (j.content) text = b64ToUtf8(j.content);
  else {                                            // peste 1 MB GitHub nu mai pune conținutul în răspuns
    const raw = await gh('GET', '/contents/date/' + name + '.json', { raw: true });
    if (!raw.ok) throw await fail(raw);
    text = await raw.text();
  }
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }      // fișier stricat: îl rescriem din datele locale
  const r = await store.mergeChunk(name, data);
  meta.shas[name] = j.sha;
  if (r.localNewer || !data) markDirty(name);
  else if (!dirty.has(name)) meta.clean[name] = store.chunkMaxT(name);
}

async function pull() {
  let res;
  try { res = await gh('GET', '/contents/date', { etag: noEtag ? '' : meta.etag }); }
  catch (e) {                                       // unele combinații de browser/proxy resping răspunsul „nemodificat”
    if (noEtag || !meta.etag) throw e;
    res = await gh('GET', '/contents/date');
    noEtag = true; setTimeout(() => { noEtag = false; }, 10 * 60 * 1000);
  }
  if (res.status === 304) return;
  let listing = [];
  if (res.status !== 404) {                         // 404 = încă nu există nimic în depozit
    if (!res.ok) throw await fail(res);
    listing = await res.json();
  }
  const newEtag = res.headers.get('ETag') || '';
  if (!Array.isArray(listing)) listing = [];
  const present = new Set();
  for (const f of listing) {
    if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
    const name = f.name.slice(0, -5);
    if (!store.CHUNKS.includes(name)) continue;
    present.add(name);
    if (meta.shas[name] !== f.sha) await fetchChunk(name);
  }
  for (const name of store.CHUNKS) {
    if (!present.has(name)) { delete meta.shas[name]; if (store.chunkHasData(name)) markDirty(name); }
  }
  meta.etag = newEtag;                              // abia acum: dacă o bucată nu s-a putut citi, lista se cere din nou
}

// ---- Scriere -----------------------------------------------------------------------
function markDirty(name) {
  dirty.add(name);
  version.set(name, (version.get(name) || 0) + 1);
}

async function pushChunk(name) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ver = version.get(name) || 0;
    const text = JSON.stringify(store.serializeChunk(name));
    const done = () => { if ((version.get(name) || 0) === ver) { dirty.delete(name); meta.clean[name] = store.chunkMaxT(name); } };
    if (meta.shas[name] && (await gitSha(text)) === meta.shas[name]) { done(); return; }
    const body = { message: (store.deviceName || 'dispozitiv') + ': ' + name, content: utf8ToB64(text) };
    if (meta.shas[name]) body.sha = meta.shas[name];
    const res = await gh('PUT', '/contents/date/' + name + '.json', { body });
    if (res.ok) {
      meta.shas[name] = (await res.json()).content.sha;
      done();
      return;
    }
    if (res.status !== 409 && res.status !== 422) throw await fail(res);
    await sleep(250 + Math.random() * 900);         // a scris altcineva între timp: luăm varianta lui și reîncercăm
    await fetchChunk(name);
  }
  throw new HttpError(409, '');
}

async function uploadFiles() {
  state.skipped = [];
  for (const f of [...store.files.values()]) {
    if (f.deleted || f.up) continue;
    const blob = await store.getBlob(f.id);
    if (!blob) continue;
    if (blob.size > MAX_FILE) { state.skipped.push(f.name); continue; }
    const path = 'fisiere/' + f.id + '/' + String(f.name).replace(/[\\/:*?"<>|#%]/g, '_');
    const res = await gh('PUT', '/contents/' + encPath(path), { body: { message: (store.deviceName || 'dispozitiv') + ': fișier ' + f.name, content: await store.blobToBase64(blob) } });
    if (res.status === 409) continue;                                                    // ramura s-a mișcat: îl luăm tura viitoare
    if (res.status === 422) {                                                            // există deja? verificăm
      const chk = await gh('GET', '/contents/' + encPath(path));
      if (!chk.ok) throw await fail(res);
    } else if (!res.ok) throw await fail(res);
    store.markUploaded(f.id, path);
  }
}

// Aduce conținutul unui fișier atașat pe alt dispozitiv.
export async function fetchFile(f) {
  if (!cfg || !f.path) return null;
  const res = await gh('GET', '/contents/' + encPath(f.path), { raw: true });
  if (!res.ok) return null;
  const blob = new Blob([await res.arrayBuffer()], { type: f.type || 'application/octet-stream' });
  await store.putBlob(f.id, blob);
  return blob;
}

// ---- Ciclul de sincronizare ----------------------------------------------------------
async function saveMeta() { meta.dirty = [...dirty]; await store.kvSet('syncMeta', meta); }

export async function syncNow(full) {
  if (!cfg) return;
  if (busy) { again = true; return; }
  if (!navigator.onLine) { setStatus('offline', explain(null)); return; }
  if (full) pausedUntil = 0;                        // cerut explicit de utilizator
  if (Date.now() < pausedUntil) return;
  busy = true; again = false;
  if (full) { meta.shas = {}; meta.etag = ''; meta.clean = {}; }
  setStatus('syncing');
  try {
    await pull();
    if (dirty.size && (full || Date.now() - lastPush >= PUSH_MS - 500)) {   // cel mult o trimitere la PUSH_MS
      lastPush = Date.now();
      for (const name of [...dirty]) await pushChunk(name);
    }
    if (Date.now() >= filesRetryAt) {
      try { await uploadFiles(); filesFail = 0; }
      catch (e) { filesFail++; filesRetryAt = Date.now() + Math.min(30 * 60e3, 30e3 * 2 ** filesFail); state.fileError = explain(e); }
    }
    state.lastSync = Date.now();
    setStatus('ok');
  } catch (e) {
    if (e instanceof HttpError && (e.status === 403 || e.status === 429) && /rate limit|abuse|secondary/i.test(e.message)) {
      pausedUntil = Date.now() + (TEST.pause || Math.max(60, e.retryAfter) * 1000);       // GitHub cere o pauză
    } else if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
      pausedUntil = Date.now() + (TEST.pause || 5 * 60 * 1000);                           // token sau depozit greșit: nu insistăm
    }
    setStatus(e instanceof HttpError ? 'error' : 'offline', explain(e));
  }
  busy = false;
  await saveMeta();
  if (again || dirty.size) schedulePush();
}

function schedulePush() {
  if (!cfg || pushTimer) return;
  const wait = Math.max(1500, PUSH_MS - (Date.now() - lastPush));
  pushTimer = setTimeout(() => { pushTimer = 0; syncNow(); }, wait);
}

store.onChange((what, key) => {
  if (!cfg || what === 'sync') return;
  if (what === 'panels' && key) markDirty(store.chunkOfPanel(key));
  else if (what === 'import') for (const name of store.CHUNKS) { if (store.chunkHasData(name)) markDirty(name); }
  else markDirty('echipamente');
  state.pending = dirty.size;
  for (const fn of listeners) fn(state);
  saveMeta();
  schedulePush();
});

function start() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) syncNow(); }, POLL_MS);
  syncNow();
}
window.addEventListener('online', () => syncNow());
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });

// ---- Conectare / deconectare ---------------------------------------------------------
export async function restore() {
  const saved = await store.kvGet('syncCfg');
  if (!saved || !saved.repo || !saved.token) return;
  cfg = saved;
  const m = await store.kvGet('syncMeta');
  if (m && m.shas) meta = { shas: m.shas, dirty: m.dirty || [], etag: '', clean: m.clean || {} };
  for (const name of meta.dirty) markDirty(name);
  for (const name of store.CHUNKS) {                // modificări făcute chiar înainte de o închidere bruscă
    if (!dirty.has(name) && store.chunkMaxT(name) > (meta.clean[name] || 0)) markDirty(name);
  }
  state.on = true; state.repo = cfg.repo;
  setStatus('syncing');
  start();
}

// Verifică depozitul și tokenul, apoi pornește sincronizarea. Aruncă o eroare cu text pentru utilizator.
export async function connect(repo, token) {
  repo = String(repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  token = String(token || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('Scrie depozitul sub forma utilizator/nume, de exemplu BogdanPopa74/parc-tutora-date.');
  if (!token) throw new Error('Lipsește tokenul GitHub.');
  let res;
  try { res = await gh('GET', '', { cfg: { repo, token } }); } catch (e) { throw new Error(explain(null)); }
  if (!res.ok) throw new Error(explain(await fail(res)));
  const info = await res.json();
  if (info.permissions && info.permissions.push === false) throw new Error(explain(new HttpError(403, '')));
  cfg = { repo, token };
  meta = { shas: {}, dirty: [], etag: '', clean: {} };
  dirty.clear();
  await store.kvSet('syncCfg', cfg);
  await saveMeta();
  state.on = true; state.repo = repo;
  start();
  return { private: !!info.private };
}

export async function disconnect() {
  cfg = null; clearInterval(pollTimer); clearTimeout(pushTimer); pushTimer = 0;
  dirty.clear(); meta = { shas: {}, dirty: [], etag: '', clean: {} };
  await store.kvSet('syncCfg', null);
  await store.kvSet('syncMeta', null);
  state.on = false; state.repo = '';
  setStatus('off');
}
