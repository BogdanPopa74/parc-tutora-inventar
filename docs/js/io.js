// Ieșiri: Excel, fișier de transfer telefon <-> calculator și folderul de pe calculator.
import { PARC } from '../parc-data.js';
import * as store from './store.js';
import { buildXlsx } from './xlsx.js';

export const TYPE_NAMES = { ptab: 'PTAB / STS', inv: 'Invertor', stalp: 'Stâlp iluminat / video', racord: 'Racord 20 kV',
  baterie: 'Baterie', tablou: 'Tablou electric', altul: 'Alt echipament' };

// Câmpurile fixe ale fiecărui tip de echipament; restul se adaugă cu „Adaugă informație”.
export const FIELDS = {
  ptab: [['serie', 'Serie', true], ['producator', 'Producător'], ['model', 'Model'], ['putere', 'Putere (kVA)']],
  inv: [['serie', 'Serie', true], ['producator', 'Producător'], ['model', 'Model'], ['putere', 'Putere (kW)']],
  stalp: [['serieBL', 'Serie cutie de comutare (BL)', true], ['serieCam1', 'Serie cameră 1', true], ['serieCam2', 'Serie cameră 2', true]],
  racord: [['serie', 'Serie / identificare', true]],
  baterie: [['serie', 'Serie', true], ['producator', 'Producător'], ['model', 'Model'], ['capacitate', 'Capacitate (kWh)']],
  tablou: [['serie', 'Serie', true], ['producator', 'Producător'], ['model', 'Model']],
  altul: [['serie', 'Serie', true], ['producator', 'Producător'], ['model', 'Model']],
};
export const fieldsOf = (type) => FIELDS[type] || FIELDS.altul;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { if (!t) return ''; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fileStamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; };

export function workbook() {
  const panouri = [['Etichetă', 'Rând', 'Masă', 'Nivel', 'Poziție', 'Serie panou', 'Invertor', 'String', 'Scanat la', 'Sursă', 'Scanat de']];
  const stringuri = [['Masă', 'Rând', 'Invertor', 'String', 'Panouri scanate', 'Total panouri']];
  for (const base of PARC.tables) {
    const t = store.getTable(base.id);
    const inv = 'INV' + pad(t.inv);
    for (let tier = 0; tier < PARC.tiers; tier++) {
      for (let col = 0; col < PARC.cols; col++) {
        const pid = store.panelId(t.id, tier, col), p = store.panels.get(pid) || {};
        panouri.push([pid, t.row, t.idx, tier === 0 ? 'Sus' : 'Jos', col + 1, p.sn || '', inv, t.str, p.sn ? stamp(p.t) : '', p.sn ? (p.src || '') : '', p.sn ? (p.by || '') : '']);
      }
    }
    stringuri.push([t.id, t.row, inv, t.str, store.tableProgress(t.id), PARC.cols * PARC.tiers]);
  }
  const echip = [['Nume', 'Tip', 'Câmp', 'Valoare']];
  for (const e of store.listEquip()) {
    const rows = [];
    for (const [k, v] of e.plan || []) rows.push([k + ' (din plan)', v]);
    for (const [key, label] of fieldsOf(e.type)) if (e[key]) rows.push([label, e[key]]);
    for (const x of e.extra || []) if (x.k || x.v) rows.push([x.k || '', x.v || '']);
    if (e.note) rows.push(['Note', e.note]);
    const names = store.filesOf(e.id).map((f) => f.name);
    if (names.length) rows.push(['Fișiere atașate', names.join(', ')]);
    if (e.type === 'inv' && e.n) rows.push(['Stringuri', store.tablesOfInverter(e.n).length]);
    if (!rows.length) rows.push(['', '']);
    for (const [k, v] of rows) echip.push([e.name, TYPE_NAMES[e.type] || e.type, k, v]);
  }
  return buildXlsx([{ name: 'Panouri', rows: panouri }, { name: 'Stringuri', rows: stringuri }, { name: 'Echipamente', rows: echip }]);
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Trimite fișierul prin meniul „Distribuie” al telefonului; pe calculator îl descarcă.
export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  download(blob, name);
  return 'downloaded';
}

export async function exportJson(withFiles) {
  const data = await store.exportData(withFiles);
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

// ---- Folderul de pe calculator (File System Access API, Chrome / Edge pe desktop) ----
export const folderSupported = 'showDirectoryPicker' in window;
const JSON_NAME = 'inventar-parc.json', XLSX_NAME = 'Inventar parc.xlsx', FILES_DIR = 'Echipamente';
let dir = null;
let blobFetcher = null;             // aduce un fișier atașat pe alt dispozitiv (prin sincronizare)
export function setBlobFetcher(fn) { blobFetcher = fn; }
const written = new Map();          // fid -> cale scrisă în folder
const removed = new Set();
export const folder = { name: '', savedAt: 0, error: '', needsPermission: false };

const safe = (s) => String(s || 'fara-nume').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'fara-nume';

async function writeFile(parent, name, blob) {
  const fh = await parent.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

export async function restoreFolder() {
  if (!folderSupported) return;
  const handle = await store.kvGet('folder');
  if (!handle || !handle.queryPermission) return;
  folder.name = handle.name;
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') { dir = handle; folder.needsPermission = false; }
  else { dir = null; folder.needsPermission = true; }
}

// Trebuie apelată dintr-un click: browserul cere acordul utilizatorului.
export async function connectFolder(reuse) {
  let handle = reuse ? await store.kvGet('folder') : null;
  if (!handle) handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'parc-inventar' });
  if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Accesul la folder nu a fost permis.');
  dir = handle; folder.name = handle.name; folder.needsPermission = false; folder.error = '';
  await store.kvSet('folder', handle);
  let stats = null;
  try {                                    // dacă folderul are deja un inventar, îl unim cu ce e în aplicație
    const fh = await dir.getFileHandle(JSON_NAME);
    stats = await store.importData(JSON.parse(await (await fh.getFile()).text()));
  } catch (e) { /* folder nou */ }
  await syncFolder();
  return stats;
}

export async function disconnectFolder() {
  dir = null; folder.name = ''; folder.needsPermission = false;
  await store.kvSet('folder', null);
}

export const folderConnected = () => !!dir;

export async function syncFolder() {
  if (!dir) return false;
  try {
    await writeFile(dir, JSON_NAME, await exportJson(false));
    await writeFile(dir, XLSX_NAME, workbook());
    const root = await dir.getDirectoryHandle(FILES_DIR, { create: true });
    for (const meta of store.files.values()) {
      const e = store.getEquip(meta.equipId);
      const sub = safe(e ? e.name : meta.equipId), name = safe(meta.name);
      if (meta.deleted) {
        if (!removed.has(meta.id)) {
          try { await (await root.getDirectoryHandle(sub)).removeEntry(name); } catch (err) { /* deja șters */ }
          removed.add(meta.id); written.delete(meta.id);
        }
        continue;
      }
      if (written.get(meta.id) === sub + '/' + name) continue;
      let blob = await store.getBlob(meta.id);
      if (!blob && blobFetcher) blob = await blobFetcher(meta);
      if (!blob) continue;
      await writeFile(await root.getDirectoryHandle(sub, { create: true }), name, blob);
      written.set(meta.id, sub + '/' + name);
    }
    folder.savedAt = Date.now(); folder.error = '';
    return true;
  } catch (e) {
    folder.error = String(e && e.message || e);
    return false;
  }
}
