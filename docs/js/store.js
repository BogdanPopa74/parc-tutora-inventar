// Stocarea datelor: totul stă în IndexedDB pe dispozitiv și, în paralel, în memorie pentru viteză.
import { PARC } from '../parc-data.js';

const DB_NAME = 'parc-tutora';
const STORES = ['kv', 'panels', 'tables', 'equip', 'files', 'blobs'];

let db = null;
export let persistent = true;

export const panels = new Map();   // pid -> { sn, t, src }
export const tables = new Map();   // tid -> { inv, str, t }   (doar ce a modificat utilizatorul)
export const equip = new Map();    // eid -> { ...câmpuri, t }  (peste datele din plan)
export const files = new Map();    // fid -> { id, equipId, name, type, size, t, deleted }
export const snIndex = new Map();  // serie -> pid
const memBlobs = new Map();

export const baseTables = new Map(PARC.tables.map((t) => [t.id, t]));
export const baseEquip = new Map(PARC.equip.map((e) => [e.id, e]));

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); }
function emit(what, key) { for (const fn of listeners) fn(what, key); }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  if (!db) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function readAll(store) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(store).objectStore(store).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

function put(store, key, value) {
  return tx(store, 'readwrite', (s) => s.put(value, key)).catch(() => { persistent = false; });
}
function putMany(store, entries) {                 // o singură tranzacție pentru multe înregistrări
  if (!entries.length) return Promise.resolve();
  return tx(store, 'readwrite', (s) => { for (const [key, value] of entries) s.put(value, key); }).catch(() => { persistent = false; });
}

export async function init() {
  try { db = await openDb(); } catch (e) { db = null; persistent = false; }
  for (const [k, v] of await readAll('panels')) panels.set(k, v);
  for (const [k, v] of await readAll('tables')) tables.set(k, v);
  for (const [k, v] of await readAll('equip')) equip.set(k, v);
  for (const [k, v] of await readAll('files')) files.set(k, v);
  rebuildIndex();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* opțional */ }
}

function rebuildIndex() {
  snIndex.clear();
  for (const [pid, p] of panels) if (p.sn) snIndex.set(p.sn, pid);
}
function reindexSn(sn) {                           // seria a plecat de pe un panou: mai e pe altul?
  snIndex.delete(sn);
  for (const [pid, p] of panels) if (p.sn === sn) { snIndex.set(sn, pid); break; }
}

// Serii care apar pe mai multe panouri (se poate întâmpla când scanează două dispozitive în paralel).
export function findDuplicates() {
  const seen = new Map();
  for (const [pid, p] of panels) if (p.sn) { if (!seen.has(p.sn)) seen.set(p.sn, []); seen.get(p.sn).push(pid); }
  return [...seen].filter(([, list]) => list.length > 1).map(([sn, list]) => ({ sn, pids: list.sort() }));
}

export const kvGet = (key) => tx('kv', 'readonly', (s) => s.get(key)).catch(() => undefined);
export const kvSet = (key, value) => put('kv', key, value);

// Numele dispozitivului se notează la fiecare scanare, ca să se vadă cine a scanat ce.
export let deviceName = '';
export function setDeviceName(name) { deviceName = String(name || '').trim(); }

// ---- Panouri ---------------------------------------------------------------
export function panelId(tableId, tier, col) {
  return tableId + '-' + (tier === 0 ? 'S' : 'J') + String(col + 1).padStart(2, '0');
}
export function parsePanel(pid) {
  return { tableId: pid.slice(0, 7), tier: pid[8] === 'S' ? 0 : 1, col: Number(pid.slice(9)) - 1 };
}
export const getSn = (pid) => (panels.get(pid) || {}).sn || '';

export function setPanel(pid, sn, src) {
  sn = String(sn || '').trim();
  const old = panels.get(pid);
  const rec = { sn, t: Date.now(), src: src || '' };
  if (deviceName) rec.by = deviceName;
  panels.set(pid, rec);
  if (old && old.sn && old.sn !== sn) reindexSn(old.sn);
  if (sn) snIndex.set(sn, pid);
  put('panels', pid, rec);
  emit('panels', pid);
}

export function scannedCount() {
  let n = 0;
  for (const p of panels.values()) if (p.sn) n++;
  return n;
}

export function tableProgress(tid) {
  let n = 0;
  for (let tier = 0; tier < PARC.tiers; tier++) {
    for (let col = 0; col < PARC.cols; col++) if (getSn(panelId(tid, tier, col))) n++;
  }
  return n;
}

// ---- Mese / stringuri --------------------------------------------------------
export function getTable(tid) {
  const base = baseTables.get(tid);
  return base ? { ...base, ...(tables.get(tid) || {}) } : null;
}
export function setTable(tid, patch) {
  const rec = { ...(tables.get(tid) || {}), ...patch, t: Date.now() };
  tables.set(tid, rec);
  put('tables', tid, rec);
  emit('tables', tid);
}
export function tablesOfInverter(n) {
  return PARC.tables.map((t) => getTable(t.id)).filter((t) => t.inv === n)
    .sort((a, b) => a.str - b.str || a.row - b.row || a.idx - b.idx);
}

// ---- Echipamente -------------------------------------------------------------
export function getEquip(eid) {
  const base = baseEquip.get(eid);
  const user = equip.get(eid);
  if (!base && !user) return null;
  return { extra: [], ...(base || {}), ...(user || {}), id: eid };
}
export function listEquip() {
  const ids = new Set([...baseEquip.keys(), ...equip.keys()]);
  return [...ids].map(getEquip).filter((e) => e && !e.deleted);
}
export function setEquip(eid, patch) {
  const rec = { ...(equip.get(eid) || {}), ...patch, t: Date.now() };
  equip.set(eid, rec);
  put('equip', eid, rec);
  emit('equip', eid);
}
export function addEquip(type, name, x, y) {
  const eid = 'X' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const rec = { custom: true, type, name, x, y };
  if (type === 'inv') {                            // invertoarele noi primesc următorul număr liber
    rec.n = Math.max(0, ...inverterNumbers()) + 1;
    rec.name = 'Invertor ' + String(rec.n).padStart(2, '0');
  }
  setEquip(eid, rec);
  return eid;
}
export function inverterNumbers() {
  return listEquip().filter((e) => e.type === 'inv' && e.n).map((e) => e.n).sort((a, b) => a - b);
}

// ---- Fișiere atașate ---------------------------------------------------------
export async function addFile(equipId, file) {
  const id = 'F' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const meta = { id, equipId, name: file.name, type: file.type || '', size: file.size, t: Date.now() };
  files.set(id, meta);
  if (!db) memBlobs.set(id, file);
  await put('blobs', id, file);
  await put('files', id, meta);
  emit('files', id);
  return meta;
}
export function filesOf(equipId) {
  return [...files.values()].filter((f) => f.equipId === equipId && !f.deleted).sort((a, b) => a.t - b.t);
}
export async function getBlob(fid) {
  if (memBlobs.has(fid)) return memBlobs.get(fid);
  const blob = await tx('blobs', 'readonly', (s) => s.get(fid)).catch(() => undefined);
  return blob || null;
}
export async function deleteFile(fid) {
  const meta = files.get(fid);
  if (!meta) return;
  const rec = { ...meta, deleted: true, t: Date.now() };
  files.set(fid, rec);
  memBlobs.delete(fid);
  await put('files', fid, rec);
  await tx('blobs', 'readwrite', (s) => s.delete(fid)).catch(() => {});
  emit('files', fid);
}

export async function putBlob(fid, blob) {          // conținut adus de pe alt dispozitiv
  if (!db) memBlobs.set(fid, blob);
  await put('blobs', fid, blob);
}
export function markUploaded(fid, path) {           // fișierul a ajuns în depozitul de date
  const meta = files.get(fid);
  if (!meta || meta.deleted) return;
  const rec = { ...meta, up: true, path, t: Date.now() };
  files.set(fid, rec);
  put('files', fid, rec);
  emit('files', fid);
}

// ---- Bucăți pentru sincronizare ------------------------------------------------
// Datele se împart în fișiere mici: câte unul pe rând de mese (R01 … R21) și unul pentru echipamente,
// ca la fiecare scanare să se trimită doar rândul la care se lucrează.
export const CHUNKS = [...new Set(PARC.tables.map((t) => 'R' + String(t.row).padStart(2, '0')))].concat('echipamente');
export const chunkOfPanel = (pid) => pid.slice(0, 3);
const sorted = (map, keep) => Object.fromEntries([...map].filter(([k]) => !keep || keep(k)).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

export function serializeChunk(name) {
  if (name === 'echipamente') return { v: 1, tables: sorted(tables), equip: sorted(equip), files: sorted(files) };
  return { v: 1, panels: sorted(panels, (pid) => chunkOfPanel(pid) === name) };
}
export function chunkMaxT(name) {                   // momentul celei mai noi modificări locale din bucată
  let max = 0;
  if (name === 'echipamente') { for (const map of [tables, equip, files]) for (const rec of map.values()) if ((rec.t || 0) > max) max = rec.t; }
  else for (const [pid, rec] of panels) if (chunkOfPanel(pid) === name && (rec.t || 0) > max) max = rec.t;
  return max;
}
export function chunkHasData(name) {
  if (name === 'echipamente') return tables.size + equip.size + files.size > 0;
  for (const pid of panels.keys()) if (chunkOfPanel(pid) === name) return true;
  return false;
}

// Unește o bucată venită din depozit cu datele locale: pentru fiecare înregistrare rămâne cea mai nouă.
// Întoarce și dacă local există ceva mai nou decât în depozit (deci bucata trebuie trimisă).
export async function mergeChunk(name, data) {
  const newer = (mine, theirs) => !mine || (theirs.t || 0) > (mine.t || 0);
  let changed = false, localNewer = false;
  const groups = name === 'echipamente'
    ? [['tables', tables, (id) => baseTables.has(id)], ['equip', equip, () => true], ['files', files, () => true]]
    : [['panels', panels, (pid) => chunkOfPanel(pid) === name && baseTables.has(pid.slice(0, 7))]];
  for (const [kind, map, valid] of groups) {
    const remote = (data && data[kind]) || {};
    const take = [];
    for (const [id, rec] of Object.entries(remote)) {
      if (rec && typeof rec === 'object' && valid(id) && newer(map.get(id), rec)) take.push([id, rec]);
    }
    for (const [id, rec] of take) map.set(id, rec);                 // întâi memoria, fără pauze: o scriere locală nu poate fi călcată
    await putMany(kind, take);
    if (kind === 'files') {
      for (const [id, rec] of take) if (rec.deleted) { memBlobs.delete(id); await tx('blobs', 'readwrite', (s) => s.delete(id)).catch(() => {}); }
    }
    if (take.length) changed = true;
    for (const [id, rec] of map) {
      if (!valid(id)) continue;
      const theirs = remote[id];
      if (!theirs || (rec.t || 0) > (theirs.t || 0)) { localNewer = true; break; }
    }
  }
  if (changed) { rebuildIndex(); emit('sync', name); }
  return { changed, localNewer };
}

// ---- Export / import (transfer telefon <-> calculator) ------------------------
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function exportData(withFiles) {
  const out = {
    app: 'parc-inventar', version: 1, parc: PARC.name, exportat: new Date().toISOString(),
    panels: Object.fromEntries(panels), tables: Object.fromEntries(tables),
    equip: Object.fromEntries(equip), files: [],
  };
  for (const meta of files.values()) {
    const item = { ...meta };
    if (withFiles && !meta.deleted) {
      const blob = await getBlob(meta.id);
      if (blob) item.data = await blobToBase64(blob);
    }
    out.files.push(item);
  }
  return out;
}

// La import câștigă, pentru fiecare înregistrare, varianta modificată cel mai recent.
export async function importData(data) {
  if (!data || data.app !== 'parc-inventar') throw new Error('Fișierul nu este un export al acestei aplicații.');
  const stats = { panouri: 0, mese: 0, echipamente: 0, fisiere: 0 };
  const newer = (mine, theirs) => !mine || (theirs.t || 0) > (mine.t || 0);
  for (const [pid, rec] of Object.entries(data.panels || {})) {
    if (baseTables.has(pid.slice(0, 7)) && newer(panels.get(pid), rec)) {
      panels.set(pid, rec); await put('panels', pid, rec); stats.panouri++;
    }
  }
  for (const [tid, rec] of Object.entries(data.tables || {})) {
    if (baseTables.has(tid) && newer(tables.get(tid), rec)) { tables.set(tid, rec); await put('tables', tid, rec); stats.mese++; }
  }
  for (const [eid, rec] of Object.entries(data.equip || {})) {
    if (newer(equip.get(eid), rec)) { equip.set(eid, rec); await put('equip', eid, rec); stats.echipamente++; }
  }
  for (const item of data.files || []) {
    const { data: b64, ...meta } = item;
    const mine = files.get(meta.id);
    const missingBlob = !meta.deleted && b64 && !(await getBlob(meta.id));
    if (newer(mine, meta) || missingBlob) {
      if (newer(mine, meta)) { files.set(meta.id, meta); await put('files', meta.id, meta); }
      if (meta.deleted) await tx('blobs', 'readwrite', (s) => s.delete(meta.id)).catch(() => {});
      else if (b64) { const blob = base64ToBlob(b64, meta.type); if (!db) memBlobs.set(meta.id, blob); await put('blobs', meta.id, blob); }
      stats.fisiere++;
    }
  }
  rebuildIndex();
  emit('import');
  return stats;
}
