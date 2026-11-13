// Aplicația: leagă harta, scanarea, fișele de detalii și salvarea datelor.
import { PARC } from '../parc-data.js';
import * as store from './store.js';
import * as io from './io.js';
import { createMap, invColor } from './map.js';
import { createScanner, beep } from './scanner.js';

const $ = (id) => document.getElementById(id);
const VERSION = '2026-11-13.2';
const TOTAL = PARC.tables.length * PARC.cols * PARC.tiers;
const PER_TABLE = PARC.cols * PARC.tiers;
const invName = (n) => 'INV' + String(n).padStart(2, '0');
const isWide = () => window.innerWidth >= 900;

// Mic ajutor pentru construit elemente: h('button', { class: 'x', onclick: fn }, 'Text')
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Buton care cere o a doua apăsare înainte de o acțiune care șterge date.
function confirmButton(label, sure, action) {
  let armed = 0;
  const btn = h('button', { type: 'button', class: 'danger', onclick: () => {
    if (Date.now() < armed) { armed = 0; btn.textContent = label; action(); return; }
    armed = Date.now() + 3500; btn.textContent = sure;
    setTimeout(() => { if (Date.now() >= armed) btn.textContent = label; }, 3600);
  } }, label);
  return btn;
}

// ---- Hartă -------------------------------------------------------------------
const map = createMap($('map'), onMapTap);
const scanner = createScanner({ video: $('video'), overlay: $('overlay'), viewer: $('viewer') }, (code) => handleCode(code, 'cameră'));
let current = null;                 // fișa deschisă: { kind, id }
let placing = null;                 // plasare echipament pe hartă: { type, name } sau { moveId }

function updateInsets() {
  const sheet = $('sheet'), sp = $('scanPanel');
  if (isWide()) map.setInset({ top: 0, bottom: 0, right: sheet.hidden ? 0 : 400, left: sp.hidden ? 0 : 412 });
  else map.setInset({ left: 0, right: 0, top: sp.hidden ? 0 : sp.offsetHeight, bottom: sheet.hidden ? 0 : sheet.offsetHeight });
}

function updateProgress() {
  const n = store.scannedCount();
  $('progress').textContent = n + ' / ' + TOTAL + ' panouri';
  $('progressFill').style.width = (100 * n / TOTAL).toFixed(1) + '%';
}

function onMapTap(hit) {
  if (placing) {
    if (placing.moveId) { store.setEquip(placing.moveId, { x: hit.x, y: hit.y }); openEquip(placing.moveId); }
    else openEquip(store.addEquip(placing.type, placing.name, hit.x, hit.y));
    placing = null; $('placing').hidden = true;
    return;
  }
  if (scan.active) {
    if (scan.target) return;
    if (hit.kind === 'panel') { scan.firstTier = store.parsePanel(hit.id).tier; setCursor(hit.id); clearNotice(); scanMsg('', 'Poziție aleasă. Scanează.'); }
    else if (hit.kind === 'table') { map.showTable(hit.id, map.panelScale()); toast('Atinge panoul de la care începi.'); }
    return;
  }
  if (hit.kind === 'equip') openEquip(hit.id);
  else if (hit.kind === 'panel') openPanel(hit.id);
  else if (hit.kind === 'table') openTable(hit.id);
  else closeSheet();
}

// ---- Fișa de detalii ---------------------------------------------------------
function openSheet(title, nodes, sel) {
  const body = $('sheetBody'), same = current && sel && current.kind === sel.kind && current.id === sel.id;
  const scroll = same ? body.scrollTop : 0;
  $('sheetTitle').textContent = title;
  body.replaceChildren(...nodes.flat().filter(Boolean));
  body.scrollTop = scroll;
  $('sheet').hidden = false;
  document.body.classList.add('sheet-open');
  current = sel || null;
  map.state.selected = sel && ['panel', 'table', 'equip'].includes(sel.kind) ? sel : null;
  updateInsets(); map.invalidate();
}
function closeSheet() {
  $('sheet').hidden = true;
  document.body.classList.remove('sheet-open');
  current = null; map.state.selected = null;
  updateInsets(); map.invalidate();
}
function reopen() {
  if (!current) return;
  const { kind, id } = current;
  if (kind === 'panel') openPanel(id, true);
  else if (kind === 'table') openTable(id, true);
  else if (kind === 'equip') openEquip(id, true);
  else if (kind === 'menu') openMenu();
  else if (kind === 'equipList') openEquipList();
}

function field(label, control) { return h('label', { class: 'field' }, h('span', {}, label), control); }

function openPanel(pid, keepView) {
  const { tableId, tier, col } = store.parsePanel(pid);
  const t = store.getTable(tableId), rec = store.panels.get(pid) || {};
  const input = h('input', { type: 'text', class: 'mono', value: rec.sn || '', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'nescanat',
    onchange: () => {
      const v = input.value.trim(), at = v && store.snIndex.get(v);
      if (at && at !== pid) { toast('Seria e deja la ' + at); input.value = rec.sn || ''; return; }
      store.setPanel(pid, v, v ? 'tastat' : '');
    } });
  openSheet(pid, [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Masă'), h('dd', {}, tableId + ' (rândul ' + t.row + ')'),
      h('dt', {}, 'Poziție'), h('dd', {}, (tier === 0 ? 'sus' : 'jos') + ', panoul ' + (col + 1) + ' din ' + PARC.cols),
      h('dt', {}, 'Invertor'), h('dd', {}, invName(t.inv) + ', string ' + t.str)),
    field('Serie panou', input),
    rec.sn ? h('p', { class: 'muted' }, 'Scanat ' + new Date(rec.t).toLocaleString('ro-RO') + (rec.src ? ' · ' + rec.src : '')) : null,
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'primary', onclick: () => startScan(pid) }, 'Scanează de aici'),
      h('button', { type: 'button', onclick: () => openTable(tableId) }, 'Vezi masa'),
      rec.sn ? confirmButton('Șterge seria', 'Sigur? Apasă din nou', () => store.setPanel(pid, '', '')) : null),
  ], { kind: 'panel', id: pid });
  if (!keepView) map.showPanel(pid);
}

function openTable(tid, keepView) {
  const t = store.getTable(tid), done = store.tableProgress(tid);
  const sel = h('select', { onchange: () => store.setTable(tid, { inv: Number(sel.value) }) },
    store.inverterNumbers().map((n) => h('option', { value: n, selected: n === t.inv }, invName(n))));
  const str = h('input', { type: 'number', min: '1', inputmode: 'numeric', value: t.str,
    onchange: () => { const v = Number(str.value); if (v > 0) store.setTable(tid, { str: v }); } });
  openSheet('Masa ' + tid, [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Rând'), h('dd', {}, t.row + ', masa ' + t.idx),
      h('dt', {}, 'Panouri scanate'), h('dd', {}, done + ' din ' + PER_TABLE)),
    h('div', { class: 'bar2' }, h('i', { style: 'width:' + (100 * done / PER_TABLE) + '%' })),
    field('Invertor', sel),
    field('String (intrarea în invertor)', str),
    h('p', { class: 'muted' }, 'Legătura masă → invertor vine din planul de cabluri. Corecteaz-o aici dacă în teren e altfel.'),
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'primary', onclick: () => startScan(store.panelId(tid, 0, 0)) }, 'Scanează masa'),
      h('button', { type: 'button', onclick: () => map.showTable(tid, map.panelScale()) }, 'Mărește pe masă'),
      done ? confirmButton('Golește masa', 'Sigur? Șterge ' + done + ' serii', () => {
        for (let tier = 0; tier < PARC.tiers; tier++) for (let c = 0; c < PARC.cols; c++) {
          const pid = store.panelId(tid, tier, c);
          if (store.getSn(pid)) store.setPanel(pid, '', '');
        }
      }) : null),
  ], { kind: 'table', id: tid });
  if (!keepView) map.showTable(tid);
}

function openEquip(eid, keepView) {
  const e = store.getEquip(eid);
  if (!e || e.deleted) { closeSheet(); return; }
  const save = (patch) => store.setEquip(eid, patch);
  const nodes = [h('p', { class: 'muted' }, io.TYPE_NAMES[e.type] || 'Echipament')];
  if (e.custom) {
    const name = h('input', { type: 'text', value: e.name || '', onchange: () => { save({ name: name.value.trim() || 'Echipament' }); $('sheetTitle').textContent = name.value.trim() || 'Echipament'; } });
    nodes.push(field('Nume', name));
  }
  for (const [key, label, scannable] of io.fieldsOf(e.type)) {
    const input = h('input', { type: 'text', value: e[key] || '', class: scannable ? 'mono' : '', spellcheck: 'false', onchange: () => save({ [key]: input.value.trim() }) });
    nodes.push(field(label, h('div', { class: 'row' }, input,
      scannable ? h('button', { type: 'button', onclick: () => startScan(null, { equipId: eid, key, label }) }, 'Scanează') : null)));
  }
  if (e.type === 'inv' && e.n) {
    const list = store.tablesOfInverter(e.n);
    const done = list.reduce((a, t) => a + store.tableProgress(t.id), 0);
    nodes.push(h('h3', {}, 'Stringuri: ' + list.length + ' · panouri scanate ' + done + ' din ' + list.length * PER_TABLE),
      h('ul', { class: 'list' }, list.map((t) => h('li', {},
        h('span', { class: 'swatch', style: 'background:' + invColor(e.n) }),
        h('button', { type: 'button', class: 'link', onclick: () => openTable(t.id) }, 'String ' + t.str + ' · ' + t.id),
        h('small', {}, store.tableProgress(t.id) + '/' + PER_TABLE)))));
  }

  // Informații suplimentare: perechi „denumire – valoare” adăugate liber
  const extra = (e.extra || []).map((x) => ({ ...x }));
  const extraBox = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const saveExtra = () => save({ extra: extra.map((x) => ({ k: x.k, v: x.v })) });
  const drawExtra = () => {
    extraBox.replaceChildren(...extra.map((x, i) => {
      const k = h('input', { type: 'text', value: x.k || '', placeholder: 'Denumire', 'aria-label': 'Denumire', onchange: () => { x.k = k.value.trim(); saveExtra(); } });
      const v = h('input', { type: 'text', value: x.v || '', placeholder: 'Valoare', 'aria-label': 'Valoare', onchange: () => { x.v = v.value.trim(); saveExtra(); } });
      return h('div', { class: 'row' }, k, v, h('button', { type: 'button', class: 'icon', 'aria-label': 'Șterge informația', onclick: () => { extra.splice(i, 1); saveExtra(); drawExtra(); } }, '×'));
    }));
  };
  drawExtra();
  nodes.push(h('h3', {}, 'Informații suplimentare'), extraBox,
    h('button', { type: 'button', onclick: () => { extra.push({ k: '', v: '' }); drawExtra(); extraBox.lastChild.querySelector('input').focus(); } }, 'Adaugă informație'));
  const note = h('textarea', { onchange: () => save({ note: note.value.trim() }) });
  note.value = e.note || '';
  nodes.push(field('Note', note));

  // Fișiere atașate
  const fl = store.filesOf(eid);
  nodes.push(h('h3', {}, 'Fișiere atașate'));
  if (fl.length) {
    nodes.push(h('ul', { class: 'list' }, fl.map((f) => h('li', {},
      h('button', { type: 'button', class: 'link', onclick: () => openFile(f) }, f.name),
      h('small', {}, f.size > 1e6 ? (f.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1e3)) + ' kB'),
      h('button', { type: 'button', class: 'x', 'aria-label': 'Șterge fișierul ' + f.name, onclick: async () => { await store.deleteFile(f.id); openEquip(eid, true); } }, '×')))));
  }
  nodes.push(h('button', { type: 'button', onclick: () => { const inp = $('fileInput'); inp.dataset.equip = eid; inp.click(); } }, 'Adaugă fișier (PDF, poze)'));
  nodes.push(h('p', { class: 'muted' }, io.folderConnected()
    ? 'Fișierele se copiază în folderul „' + io.folder.name + '”, la Echipamente / ' + e.name + '.'
    : io.folderSupported ? 'Ca fișierele să ajungă într-un folder de pe calculator, alege folderul din Meniu.' : 'Fișierele se păstrează în aplicație, pe acest dispozitiv.'));
  if (e.custom) {
    nodes.push(h('div', { class: 'btns' },
      h('button', { type: 'button', onclick: () => { placing = { moveId: eid }; $('placing').hidden = false; closeSheet(); } }, 'Mută pe hartă'),
      confirmButton('Șterge echipamentul', 'Sigur? Apasă din nou', () => { store.setEquip(eid, { deleted: true }); closeSheet(); })));
  }
  openSheet(e.name, nodes, { kind: 'equip', id: eid });
  if (!keepView) map.centerOn(e.x + (e.w || 0) / 2, e.y + (e.h || 0) / 2);
}

async function openFile(f) {
  const blob = await store.getBlob(f.id);
  if (!blob) { toast('Fișierul nu se află pe acest dispozitiv.'); return; }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, target: '_blank', rel: 'noopener' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

$('fileInput').addEventListener('change', async () => {
  const inp = $('fileInput'), eid = inp.dataset.equip;
  const list = [...inp.files];
  inp.value = '';
  if (!eid || !list.length) return;
  for (const f of list) await store.addFile(eid, f);
  toast(list.length === 1 ? 'Fișier adăugat' : list.length + ' fișiere adăugate');
  if (current && current.kind === 'equip' && current.id === eid) openEquip(eid, true);
});

function openEquipList() {
  const groups = {};
  for (const e of store.listEquip()) (groups[e.type] = groups[e.type] || []).push(e);
  const nodes = [];
  for (const type of ['ptab', 'inv', 'baterie', 'tablou', 'altul', 'racord', 'stalp']) {
    if (!groups[type]) continue;
    nodes.push(h('h3', {}, io.TYPE_NAMES[type]),
      h('ul', { class: 'list' }, groups[type].map((e) => h('li', {},
        e.type === 'inv' && e.n ? h('span', { class: 'swatch', style: 'background:' + invColor(e.n) }) : null,
        h('button', { type: 'button', class: 'link', onclick: () => openEquip(e.id) }, e.name),
        h('small', { class: 'mono' }, e.serie || e.serieBL || (store.filesOf(e.id).length ? store.filesOf(e.id).length + ' fișiere' : ''))))));
  }
  nodes.push(h('button', { type: 'button', class: 'primary', onclick: openAddEquip }, 'Adaugă echipament'));
  openSheet('Echipamente', nodes, { kind: 'equipList' });
}

function openAddEquip() {
  const type = h('select', {}, ['baterie', 'ptab', 'inv', 'tablou', 'altul'].map((t) => h('option', { value: t }, io.TYPE_NAMES[t])));
  const name = h('input', { type: 'text', placeholder: 'ex. Baterie 1' });
  openSheet('Adaugă echipament', [
    field('Tip', type), field('Nume', name),
    h('p', { class: 'muted' }, 'După ce apeși butonul, atinge harta în locul unde se află echipamentul.'),
    h('button', { type: 'button', class: 'primary', onclick: () => {
      placing = { type: type.value, name: name.value.trim() || io.TYPE_NAMES[type.value] };
      closeSheet(); $('placing').hidden = false;
    } }, 'Alege locul pe hartă'),
  ], { kind: 'addEquip' });
}
$('placeCancel').addEventListener('click', () => { placing = null; $('placing').hidden = true; });

function openSearch() {
  const results = h('ul', { class: 'list' });
  const input = h('input', { type: 'text', class: 'mono', placeholder: 'Serie sau nume', spellcheck: 'false', oninput: () => run() });
  const run = () => {
    const q = input.value.trim().toLowerCase();
    const out = [];
    if (q.length >= 2) {
      for (const [sn, pid] of store.snIndex) {
        if (sn.toLowerCase().includes(q)) out.push(h('li', {}, h('button', { type: 'button', class: 'link mono', onclick: () => { openPanel(pid); map.showPanel(pid, map.panelScale()); } }, sn), h('small', {}, pid)));
        if (out.length >= 40) break;
      }
      for (const e of store.listEquip()) {
        const text = [e.name, e.serie, e.serieBL, e.serieCam1, e.serieCam2, e.model].filter(Boolean).join(' ').toLowerCase();
        if (text.includes(q)) out.push(h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => openEquip(e.id) }, e.name), h('small', { class: 'mono' }, e.serie || '')));
      }
      for (const t of PARC.tables) if (t.id.toLowerCase().includes(q)) out.push(h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => openTable(t.id) }, 'Masa ' + t.id)));
    }
    results.replaceChildren(...out.slice(0, 60));
    results.hidden = !out.length;
    empty.hidden = !!out.length || q.length < 2;
  };
  const empty = h('p', { class: 'muted', hidden: true }, 'Nimic găsit.');
  results.hidden = true;
  openSheet('Caută', [input, results, empty], { kind: 'search' });
  input.focus();
}

function openMenu() {
  const n = store.scannedCount();
  const nodes = [
    h('p', {}, PARC.specs.mese + ' mese × ' + PARC.specs.panouriPeMasa + ' panouri = ' + TOTAL + ' panouri, ' + PARC.specs.invertoare + ' invertoare, 1 PTAB.'),
    h('p', { class: 'muted' }, 'Scanate: ' + n + ' (' + (100 * n / TOTAL).toFixed(1) + '%). ' + PARC.specs.note + '.'),
    !store.persistent ? h('div', { class: 'banner' }, 'Browserul nu permite salvarea pe dispozitiv (fereastră privată?). Datele se pierd la închidere.') : null,
    h('div', { class: 'btns' },
      h('button', { type: 'button', onclick: openEquipList }, 'Echipamente'),
      h('button', { type: 'button', onclick: openAddEquip }, 'Adaugă echipament'),
      h('button', { type: 'button', onclick: () => { io.download(io.workbook(), 'Inventar parc ' + io.fileStamp() + '.xlsx'); } }, 'Descarcă Excel')),
    h('h3', {}, 'Transfer între telefon și calculator'),
    h('p', { class: 'muted' }, 'Trimite datele de pe telefon (WhatsApp, e-mail, Drive, cablu), apoi importă fișierul pe calculator. La import se păstrează, pentru fiecare panou, varianta cea mai nouă.'),
  ];
  const withFiles = h('input', { type: 'checkbox', checked: true, style: 'width:22px;height:22px;min-height:0' });
  nodes.push(h('label', { class: 'row' }, withFiles, h('span', {}, 'Include fișierele atașate')),
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'primary', onclick: async () => {
        const res = await io.shareOrDownload(await io.exportJson(withFiles.checked), 'parc-tutora-' + io.fileStamp() + '.json');
        if (res === 'downloaded') toast('Fișierul de date a fost descărcat');
      } }, 'Trimite datele'),
      h('button', { type: 'button', onclick: () => $('importInput').click() }, 'Importă date')));

  nodes.push(h('h3', {}, 'Folder pe calculator'));
  if (!io.folderSupported) {
    nodes.push(h('p', { class: 'muted' }, 'Salvarea directă într-un folder merge în Chrome sau Edge pe calculator. Pe telefon folosește „Trimite datele”.'));
  } else if (io.folderConnected()) {
    nodes.push(h('div', { class: io.folder.error ? 'banner' : 'okbox' }, io.folder.error ? 'Eroare la salvare: ' + io.folder.error
      : 'Conectat: „' + io.folder.name + '”.' + (io.folder.savedAt ? ' Salvat la ' + new Date(io.folder.savedAt).toLocaleTimeString('ro-RO') + '.' : '')),
      h('p', { class: 'muted' }, 'În folder se scriu automat: „Inventar parc.xlsx”, „inventar-parc.json” și fișierele atașate, în Echipamente / numele echipamentului.'),
      h('div', { class: 'btns' },
        h('button', { type: 'button', onclick: async () => { await io.syncFolder(); openMenu(); toast(io.folder.error ? 'Salvarea a eșuat' : 'Salvat în folder'); } }, 'Salvează acum'),
        h('button', { type: 'button', onclick: async () => { await io.disconnectFolder(); openMenu(); } }, 'Deconectează')));
  } else {
    nodes.push(h('p', { class: 'muted' }, io.folder.needsPermission
      ? 'Folderul „' + io.folder.name + '” trebuie reconectat după repornirea browserului.'
      : 'Alege un folder de pe calculator. Aplicația scrie acolo inventarul în Excel și fișierele atașate echipamentelor.'),
      h('div', { class: 'btns' },
        io.folder.needsPermission ? h('button', { type: 'button', class: 'primary', onclick: () => connect(true) }, 'Reconectează „' + io.folder.name + '”') : null,
        h('button', { type: 'button', class: io.folder.needsPermission ? '' : 'primary', onclick: () => connect(false) }, 'Alege folderul')));
  }
  nodes.push(h('h3', {}, 'Altele'), h('div', { class: 'btns' },
    h('a', { class: 'btn', href: 'test-scanner.html' }, 'Test scanner'),
    h('button', { type: 'button', onclick: () => { map.fit(); closeSheet(); } }, 'Arată tot parcul')),
  h('p', { class: 'muted' }, 'Harta: ' + PARC.source + '. Versiunea aplicației: ' + VERSION + '.'));
  openSheet('Meniu', nodes, { kind: 'menu' });
}

async function connect(reuse) {
  try {
    const stats = await io.connectFolder(reuse);
    toast(stats && (stats.panouri || stats.echipamente || stats.fisiere) ? 'Folder conectat. Date preluate din folder.' : 'Folder conectat');
  } catch (e) {
    if (!e || e.name !== 'AbortError') toast(String(e && e.message || e));
  }
  openMenu();
}

$('importInput').addEventListener('change', async () => {
  const inp = $('importInput'), f = inp.files[0];
  inp.value = '';
  if (!f) return;
  try {
    const s = await store.importData(JSON.parse(await f.text()));
    toast('Importat: ' + s.panouri + ' panouri, ' + s.echipamente + ' echipamente, ' + s.fisiere + ' fișiere');
  } catch (e) { toast('Import eșuat: ' + (e && e.message || e)); }
});

// ---- Scanare -----------------------------------------------------------------
const scan = { active: false, target: null, cursor: null, dir: 1, order: 'col', firstTier: 0, history: [] };

function stepSame(pid, d) {                        // vecinul de pe același nivel, trecând la masa următoare din rând
  const { tableId, tier, col } = store.parsePanel(pid);
  const c = col + d;
  if (c >= 0 && c < PARC.cols) return store.panelId(tableId, tier, c);
  const t = store.baseTables.get(tableId);
  const next = PARC.tables.find((x) => x.row === t.row && x.idx === t.idx + d);
  return next ? store.panelId(next.id, tier, d > 0 ? 0 : PARC.cols - 1) : null;
}
function nextPos(pid) {
  if (scan.order === 'row') return stepSame(pid, scan.dir);
  const p = store.parsePanel(pid);
  if (p.tier === scan.firstTier) return store.panelId(p.tableId, 1 - p.tier, p.col);   // celălalt panou din coloană
  const n = stepSame(pid, scan.dir);
  if (!n) return null;
  const q = store.parsePanel(n);
  return store.panelId(q.tableId, scan.firstTier, q.col);
}

function scanMsg(kind, text) {
  const m = $('scanMsg');
  m.className = 'msg ' + (kind || '');
  m.textContent = text || '';
}
function flash(kind) {
  const f = $('flash');
  f.className = 'flash'; void f.offsetWidth; f.classList.add(kind);
  beep(kind);
}
let noticeAction = null;
function notice(text, label, action) {
  $('noticeText').textContent = text; $('noticeBtn').textContent = label;
  noticeAction = action; $('scanNotice').hidden = false; updateInsets();
}
function clearNotice() { if (!$('scanNotice').hidden) { $('scanNotice').hidden = true; noticeAction = null; updateInsets(); } }
$('noticeBtn').addEventListener('click', () => { const a = noticeAction; clearNotice(); if (a) a(); });

function setCursor(pid) {
  scan.cursor = pid; map.state.cursor = pid;
  $('scanPos').textContent = pid || 'alege pe hartă';
  if (pid) map.showPanel(pid, map.panelScale()); else map.invalidate();
}

function updateScanUi() {
  const eq = !!scan.target;
  $('scanLbl').textContent = eq ? store.getEquip(scan.target.equipId).name + ' · ' + scan.target.label : 'Poziția curentă';
  if (eq) $('scanPos').textContent = 'scanează eticheta';
  for (const id of ['dirBtn', 'orderBtn', 'skipBtn', 'undoBtn']) $(id).hidden = eq;
  $('dirBtn').textContent = scan.dir > 0 ? 'Spre est →' : '← Spre vest';
  $('orderBtn').textContent = scan.order === 'col' ? 'Sus-jos' : 'Pe rând';
}

async function startCamera() {
  const res = await scanner.start();
  if (!res.ok) { $('camMsg').textContent = res.error; $('idle').hidden = false; $('reticle').hidden = true; return; }
  $('idle').hidden = true; $('reticle').hidden = false;
  $('torchBtn').hidden = !res.torch; $('torchBtn').setAttribute('aria-pressed', 'false');
  if (res.zoom) {
    const z = $('camZoom');
    z.min = res.zoom.min; z.max = res.zoom.max; z.step = res.zoom.step || 0.1; z.value = res.zoom.min;
    $('zoomLabel').textContent = 'Zoom ' + Number(z.value).toFixed(1) + '×';
    $('zoomRow').hidden = false;
  } else $('zoomRow').hidden = true;
  updateInsets();
}
function stopCamera() {
  scanner.stop();
  $('idle').hidden = false; $('reticle').hidden = true; $('torchBtn').hidden = true; $('zoomRow').hidden = true;
}

async function startScan(pid, target) {
  closeSheet();
  scan.active = true; scan.target = target || null; scan.history = [];
  $('scanPanel').hidden = false; $('scanFab').hidden = true;
  clearNotice(); scanMsg('', '');
  updateScanUi();
  updateInsets();
  if (!scan.target) {
    if (pid) { scan.firstTier = store.parsePanel(pid).tier; setCursor(pid); }
    else { setCursor(null); scanMsg('', 'Atinge pe hartă panoul de la care începi.'); }
  }
  if (await scanner.ready) await startCamera();
  else { $('camMsg').textContent = 'Acest browser nu are cititor de coduri. Scrie codul mai jos sau folosește un scanner Bluetooth / USB.'; $('camStart').hidden = true; if (isWide()) $('scanInput').focus(); }
  updateInsets();
  if (scan.cursor) map.showPanel(scan.cursor, map.panelScale());
}

function stopScan() {
  const target = scan.target;
  stopCamera();
  scan.active = false; scan.target = null; scan.cursor = null; map.state.cursor = null;
  $('scanPanel').hidden = true; $('scanFab').hidden = false;
  updateInsets(); map.invalidate();
  if (target) openEquip(target.equipId);
}

function place(code, src, movedFrom) {
  const pid = scan.cursor;
  scan.history.push({ pid, prev: store.getSn(pid), movedFrom });
  store.setPanel(pid, code, src);
  flash('ok'); scanMsg('ok', code + ' → ' + pid);
  advance();
}
function advance() {
  const n = nextPos(scan.cursor);
  if (n) { setCursor(n); return; }
  setCursor(null);
  beep('end');
  scanMsg('', 'Capăt de rând. Atinge pe hartă primul panou al rândului următor.');
}

function handleCode(raw, src) {
  const code = String(raw || '').trim();
  if (!scan.active || !code) return;
  clearNotice();
  if (scan.target) {
    store.setEquip(scan.target.equipId, { [scan.target.key]: code });
    flash('ok'); toast(scan.target.label + ': ' + code);
    stopScan();
    return;
  }
  if (!scan.cursor) { flash('dup'); scanMsg('dup', 'Alege mai întâi panoul de start pe hartă.'); scanner.release(); return; }
  const at = store.snIndex.get(code), cur = store.getSn(scan.cursor);
  if (at === scan.cursor) { flash('ok'); scanMsg('ok', 'Confirmat: ' + code); scan.history.push({ pid: scan.cursor, prev: cur }); advance(); return; }
  if (at) {
    flash('dup'); scanMsg('dup', 'Dublură');
    notice('Codul ' + code + ' este deja la ' + at + '.', 'Mută aici', () => { store.setPanel(at, '', ''); place(code, src, { pid: at, sn: code }); });
    return;
  }
  if (cur) {
    flash('dup'); scanMsg('dup', 'Poziție ocupată');
    notice('Poziția are deja seria ' + cur + '.', 'Înlocuiește', () => place(code, src));
    return;
  }
  place(code, src);
}

$('scanFab').addEventListener('click', () => {
  const pid = current && current.kind === 'panel' ? current.id : current && current.kind === 'table' ? store.panelId(current.id, 0, 0) : null;
  startScan(pid);
});
$('scanDone').addEventListener('click', stopScan);
$('camStart').addEventListener('click', startCamera);
$('scanManual').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('scanInput');
  if (input.value.trim()) { handleCode(input.value, 'tastat'); input.value = ''; }
});
$('dirBtn').addEventListener('click', () => { scan.dir = -scan.dir; updateScanUi(); savePrefs(); });
$('orderBtn').addEventListener('click', () => { scan.order = scan.order === 'col' ? 'row' : 'col'; updateScanUi(); savePrefs(); });
$('skipBtn').addEventListener('click', () => {
  if (!scan.cursor) return;
  clearNotice();
  scan.history.push({ pid: scan.cursor, prev: store.getSn(scan.cursor) });
  scanMsg('', 'Sărit: ' + scan.cursor);
  advance();
});
$('undoBtn').addEventListener('click', () => {
  const last = scan.history.pop();
  if (!last) { toast('Nimic de anulat'); return; }
  clearNotice();
  if (store.getSn(last.pid) !== last.prev) store.setPanel(last.pid, last.prev, last.prev ? 'refăcut' : '');
  if (last.movedFrom) store.setPanel(last.movedFrom.pid, last.movedFrom.sn, 'refăcut');
  setCursor(last.pid);
  scanMsg('', 'Anulat. Ești din nou la ' + last.pid + '.');
  scanner.release();
});
$('torchBtn').addEventListener('click', async () => {
  const btn = $('torchBtn'), on = btn.getAttribute('aria-pressed') !== 'true';
  if (await scanner.setTorch(on)) btn.setAttribute('aria-pressed', String(on)); else toast('Lanterna nu a putut fi comutată');
});
$('camZoom').addEventListener('input', (e) => { scanner.setZoom(e.target.value); $('zoomLabel').textContent = 'Zoom ' + Number(e.target.value).toFixed(1) + '×'; });
document.addEventListener('visibilitychange', () => { if (document.hidden && scanner.running) stopCamera(); });
function savePrefs() { store.kvSet('scanPrefs', { dir: scan.dir, order: scan.order }); }

// ---- Bară și butoane de hartă ------------------------------------------------
$('menuBtn').addEventListener('click', () => (current && current.kind === 'menu' ? closeSheet() : openMenu()));
$('searchBtn').addEventListener('click', openSearch);
$('sheetClose').addEventListener('click', closeSheet);
$('zoomIn').addEventListener('click', () => map.zoom(1.5));
$('zoomOut').addEventListener('click', () => map.zoom(1 / 1.5));
$('zoomFit').addEventListener('click', () => map.fit());
function setMode(mode) {
  map.state.mode = mode;
  $('modeProgres').setAttribute('aria-pressed', String(mode === 'progres'));
  $('modeInv').setAttribute('aria-pressed', String(mode === 'inv'));
  map.invalidate();
}
$('modeProgres').addEventListener('click', () => setMode('progres'));
$('modeInv').addEventListener('click', () => setMode('inv'));
window.addEventListener('resize', updateInsets);

// ---- Pornire -----------------------------------------------------------------
let saveTimer = 0;
store.onChange((what) => {
  updateProgress(); map.invalidate();
  const typing = document.activeElement && $('sheet').contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (what === 'import' || (!typing && current && (current.kind === 'panel' || current.kind === 'table') && what === 'panels')) reopen();
  if (io.folderConnected()) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => { await io.syncFolder(); if (current && current.kind === 'menu') openMenu(); if (io.folder.error) toast('Salvarea în folder a eșuat'); }, 1200);
  }
});

(async function init() {
  await store.init();
  const prefs = await store.kvGet('scanPrefs');
  if (prefs) { scan.dir = prefs.dir === -1 ? -1 : 1; scan.order = prefs.order === 'row' ? 'row' : 'col'; }
  try { await io.restoreFolder(); } catch (e) { /* fără folder */ }
  $('parkName').textContent = PARC.name;
  updateProgress(); updateInsets(); map.fit();
  if (io.folder.needsPermission) toast('Folderul „' + io.folder.name + '” trebuie reconectat din Meniu');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__app = { store, map, scan, io, handleCode };       // pentru depanare din consolă
})();
