// Aplicația: leagă harta, scanarea, fișele de detalii și salvarea datelor.
import { PARC } from '../parc-data.js';
import * as store from './store.js';
import * as io from './io.js';
import { createMap, invColor } from './map.js';
import { createScanner, beep } from './scanner.js';
import * as sync from './sync.js';
import * as pal from './paleti.js';
import { createDataView } from './dataview.js';

const $ = (id) => document.getElementById(id);
let VERSION = '';                   // vine din sw.js (numele cache-ului), ca să existe un singur loc de schimbat
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
let assign = null;                  // atribuire de mese unui invertor: { n, eid, count }

function showBar(text, label) {
  $('placingText').textContent = text; $('placeCancel').textContent = label; $('placing').hidden = false;
}
function startAssign(e) {
  assign = { n: e.n, eid: e.id, count: 0 };
  closeSheet(); setMode('inv');
  showBar('Atinge mesele care intră în ' + invName(e.n) + '.', 'Gata');
}
function assignTable(tid) {
  const t = store.getTable(tid);
  if (t.inv === assign.n) { toast(tid + ' este deja pe ' + invName(assign.n)); return; }
  const used = store.tablesOfInverter(assign.n).map((x) => x.str);
  store.setTable(tid, { inv: assign.n, str: Math.max(0, ...used) + 1 });
  assign.count++;
  showBar(invName(assign.n) + ': ' + assign.count + (assign.count === 1 ? ' masă mutată' : ' mese mutate') + '. Atinge următoarea.', 'Gata');
}

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
  if (assign) {
    const tid = hit.kind === 'table' ? hit.id : hit.kind === 'panel' ? hit.tableId : null;
    if (tid) assignTable(tid);
    return;
  }
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

// Butonul „Înapoi” al telefonului închide ce e deschis (tabel, scanare, fișă), nu aplicația.
let backArmed = false;
function armBack() {
  if (backArmed) return;
  try { history.pushState({ overlay: 1 }, ''); backArmed = true; } catch (e) { /* fără istoric */ }
}
window.addEventListener('popstate', () => {
  backArmed = false;
  if (dataView.isOpen) dataView.close();
  else if (scan.active) stopScan();
  else if (!$('sheet').hidden) closeSheet();
  if (dataView.isOpen || scan.active || !$('sheet').hidden) armBack();
});

// ---- Fișa de detalii ---------------------------------------------------------
function openSheet(title, nodes, sel) {
  armBack();
  const body = $('sheetBody'), same = current && sel && current.kind === sel.kind && current.id === sel.id;
  const scroll = same ? body.scrollTop : 0;
  $('sheetTitle').textContent = title;
  body.replaceChildren(...nodes.flat().filter(Boolean));
  body.scrollTop = scroll;
  $('sheet').hidden = false;
  $('sheet').classList.toggle('tall', !!(sel && ['pallet', 'equip', 'menu', 'help'].includes(sel.kind)));
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
  else if (kind === 'sync') openSync();
  else if (kind === 'pallet') openPallet(id);
}

function field(label, control) { return h('label', { class: 'field' }, h('span', {}, label), control); }

function openPanel(pid, keepView) {
  const { tableId, tier, col } = store.parsePanel(pid);
  const t = store.getTable(tableId), rec = store.panels.get(pid) || {};
  const input = h('input', { type: 'text', class: 'mono', value: rec.sn || '', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'nescanat',
    onchange: () => {
      const v = pal.normalize(input.value), at = v && store.snIndex.get(v);
      if (at && at !== pid) { toast('Seria e deja la ' + at); input.value = rec.sn || ''; return; }
      store.setPanel(pid, v, v ? 'tastat' : '');
    } });
  openSheet(pid, [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Masă'), h('dd', {}, tableId + ' (rândul ' + t.row + ')'),
      h('dt', {}, 'Poziție'), h('dd', {}, (tier === 0 ? 'sus' : 'jos') + ', panoul ' + (col + 1) + ' din ' + PARC.cols),
      h('dt', {}, 'Invertor'), h('dd', {}, invName(t.inv) + ', string ' + t.str)),
    field('Serie panou', input),
    panelModule(rec.sn, pid),
    rec.sn ? h('p', { class: 'muted' }, 'Scanat ' + new Date(rec.t).toLocaleString('ro-RO') + (rec.src ? ' · ' + rec.src : '') + (rec.by ? ' · de ' + rec.by : '')) : null,
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'primary', onclick: () => startScan(pid) }, 'Scanează de aici'),
      h('button', { type: 'button', onclick: () => openTable(tableId) }, 'Vezi masa'),
      rec.sn ? confirmButton('Șterge seria', 'Sigur? Apasă din nou', () => store.setPanel(pid, '', '')) : null),
  ], { kind: 'panel', id: pid });
  if (!keepView) map.showPanel(pid);
}

function panelModule(sn, pid) {
  if (!sn) return null;
  const info = pal.lookup(sn);
  if (!info) return h('div', { class: 'banner' }, 'Seria nu este în lista de paleți.');
  const p = pal.pallet(info.palet);
  const mix = Object.keys(pal.tableClasses(pid.slice(0, 7), pid)).filter((c) => c !== info.cls);
  return h('div', { class: 'modinfo' },
    h('div', { class: 'top' }, h('span', { class: 'cls', style: 'background:' + pal.classColor(info.cls) }, info.cls), h('span', {}, info.clsText)),
    h('div', {}, 'Palet ', h('button', { type: 'button', class: 'link', onclick: () => openPallet(info.palet) }, info.palet), ' (' + info.paletFull + ') · ' + pal.countsText(p.counts)),
    info.note ? h('div', { class: info.broken || info.separate ? 'warn' : '' }, info.note) : null,
    mix.length ? h('div', { class: 'warn' }, 'Pe aceeași masă sunt și module ' + mix.join(', ') + '.') : null);
}

// Fișa unui palet: ce clase conține, câte module sunt montate și unde.
function openPallet(id) {
  const p = pal.pallet(id);
  if (!p) { toast('Paletul ' + id + ' nu este în listă'); return; }
  const tables = [...new Set(p.mods.filter((m) => m.pid).map((m) => m.pid.slice(0, 7)))];
  openSheet('Palet ' + p.id, [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Număr complet'), h('dd', { class: 'mono' }, p.full),
      h('dt', {}, 'Conține'), h('dd', {}, pal.countsText(p.counts)),
      h('dt', {}, 'Montate'), h('dd', {}, p.mounted + ' din ' + p.mods.length + (tables.length ? ' · mesele ' + tables.join(', ') : ''))),
    p.note ? h('div', { class: 'banner' }, p.note) : null,
    h('h3', {}, 'Modulele paletului'),
    h('ul', { class: 'list' }, p.mods.map((m) => h('li', {},
      h('span', { class: 'cls sm', style: 'background:' + pal.classColor(m.cls) }, m.cls),
      m.pid ? h('button', { type: 'button', class: 'link mono', onclick: () => { openPanel(m.pid); map.showPanel(m.pid, map.panelScale()); } }, m.six + ' → ' + m.pid)
        : h('span', { class: 'mono', style: 'flex:1' }, m.six),
      h('small', { class: m.note ? 'warnline' : '' }, m.note ? m.note.replace(/^Palet cu două clase — /, '') : m.pid ? '' : 'nemontat')))),
  ], { kind: 'pallet', id });
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
  if (e.plan && e.plan.length) {
    nodes.push(h('h3', {}, 'Din plan'), h('dl', { class: 'kv' }, e.plan.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  }
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
    nodes.push(h('button', { type: 'button', onclick: () => startAssign(e) }, 'Alege pe hartă mesele acestui invertor'),
      h('h3', {}, 'Stringuri: ' + list.length + ' · panouri scanate ' + done + ' din ' + list.length * PER_TABLE),
      h('ul', { class: 'list' }, list.map((t) => h('li', {},
        h('span', { class: 'swatch', style: 'background:' + invColor(e.n) }),
        h('button', { type: 'button', class: 'link', onclick: () => openTable(t.id) }, 'String ' + t.str + ' · ' + t.id),
        h('small', {}, store.tableProgress(t.id) + '/' + PER_TABLE)))));
    if (!list.length) nodes.pop();                 // fără listă goală
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
      h('button', { type: 'button', onclick: () => { placing = { moveId: eid }; closeSheet(); showBar('Atinge harta acolo unde se află echipamentul.', 'Renunță'); } }, 'Mută pe hartă'),
      confirmButton('Șterge echipamentul', 'Sigur? Apasă din nou', () => {
        if (e.type === 'inv' && e.n && store.tablesOfInverter(e.n).length) { toast('Mută întâi mesele pe alt invertor.'); return; }
        store.setEquip(eid, { deleted: true }); closeSheet();
      })));
  }
  openSheet(e.name, nodes, { kind: 'equip', id: eid });
  if (!keepView) map.centerOn(e.x + (e.w || 0) / 2, e.y + (e.h || 0) / 2);
}

async function openFile(f) {
  let blob = await store.getBlob(f.id);
  if (!blob && f.up && sync.state.on) { toast('Se descarcă fișierul…'); blob = await sync.fetchFile(f).catch(() => null); }
  if (!blob) { toast(f.up ? 'Fișierul nu a putut fi descărcat. Verifică internetul.' : 'Fișierul nu a ajuns încă de pe dispozitivul pe care a fost adăugat.'); return; }
  // Doar PDF-urile și pozele se deschid direct, și doar pe calculator; orice altceva se descarcă,
  // ca un fișier primit de la alt dispozitiv să nu poată rula cod în aplicație.
  const type = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(blob.type) ? blob.type : 'application/octet-stream';
  const inline = type !== 'application/octet-stream' && !matchMedia('(pointer: coarse)').matches;
  const url = URL.createObjectURL(new Blob([blob], { type }));
  const a = inline ? h('a', { href: url, target: '_blank', rel: 'noopener' }) : h('a', { href: url, download: f.name || 'fisier' });
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
  const name = h('input', { type: 'text', placeholder: 'ex. Baterie 1 (invertoarele se numerotează singure)' });
  openSheet('Adaugă echipament', [
    field('Tip', type), field('Nume', name),
    h('p', { class: 'muted' }, 'După ce apeși butonul, atinge harta în locul unde se află echipamentul.'),
    h('button', { type: 'button', class: 'primary', onclick: () => {
      placing = { type: type.value, name: name.value.trim() || io.TYPE_NAMES[type.value] };
      closeSheet(); showBar('Atinge harta acolo unde se află echipamentul.', 'Renunță');
    } }, 'Alege locul pe hartă'),
  ], { kind: 'addEquip' });
}
$('placeCancel').addEventListener('click', () => {
  const done = assign;
  placing = null; assign = null; $('placing').hidden = true;
  if (done) openEquip(done.eid);
});

function openSearch() {
  const results = h('ul', { class: 'list' });
  const input = h('input', { type: 'text', class: 'mono', placeholder: 'Serie, palet, masă sau nume', spellcheck: 'false', oninput: () => run() });
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
      const qp = q.replace(/^palet\s*/, '').replace(/^6100001987-3-/, '');
      for (const id of pal.palletIds) if (/^\d{2,4}$/.test(qp) && id.includes(qp)) out.push(h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => openPallet(id) }, 'Palet ' + id), h('small', {}, pal.countsText(pal.pallet(id).counts))));
      const info = /^\d{6}$/.test(q) || q.length === 19 ? pal.lookup(q) : null;
      if (info && !store.snIndex.get(info.serial)) out.push(h('li', {}, h('button', { type: 'button', class: 'link mono', onclick: () => openPallet(info.palet) }, info.six + ' · ' + info.cls), h('small', {}, 'palet ' + info.palet + ', nemontat')));
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
      h('button', { type: 'button', onclick: () => { closeSheet(); dataView.open(); armBack(); } }, 'Tabel cu date'),
      h('button', { type: 'button', class: 'primary', onclick: startDetect }, 'Detectare paleți'),
      h('button', { type: 'button', onclick: () => { closeSheet(); dataView.open('paleti'); armBack(); } }, 'Paleți'),
      h('button', { type: 'button', onclick: openEquipList }, 'Echipamente'),
      h('button', { type: 'button', onclick: openAddEquip }, 'Adaugă echipament'),
      h('button', { type: 'button', onclick: () => { io.download(io.workbook(), 'Inventar parc ' + io.fileStamp() + '.xlsx'); } }, 'Descarcă Excel')),
    h('h3', {}, 'Date live între dispozitive'),
    sync.state.on
      ? h('div', { class: sync.state.status === 'error' ? 'banner' : 'okbox' }, syncLine())
      : h('p', { class: 'muted' }, 'Pornește sincronizarea ca scanările de pe telefon să apară singure pe laptop și pe celelalte telefoane.'),
    h('div', { class: 'btns' }, h('button', { type: 'button', class: sync.state.on ? '' : 'primary', onclick: () => openSync() }, sync.state.on ? 'Setări sincronizare' : 'Pornește sincronizarea')),
    h('h3', {}, 'Instalare pe telefon'),
    standalone ? h('p', { class: 'muted' }, 'Aplicația este instalată pe acest dispozitiv.')
      : installEvent ? h('div', { class: 'btns' }, h('button', { type: 'button', class: 'primary', onclick: async () => { const ev = installEvent; installEvent = null; ev.prompt(); await ev.userChoice.catch(() => {}); openMenu(); } }, 'Instalează aplicația'))
        : h('p', { class: 'muted' }, 'În Chrome, deschide meniul ⋮ și alege „Instalează aplicația” sau „Adaugă pe ecranul de pornire”. Apare ca o aplicație obișnuită și pornește și fără semnal.'),
    h('h3', {}, 'Transfer manual, prin fișier'),
    h('p', { class: 'muted' }, 'Fără sincronizare: trimite datele de pe telefon (WhatsApp, e-mail, Drive, cablu), apoi importă fișierul pe calculator. La import se păstrează, pentru fiecare panou, varianta cea mai nouă.'),
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
    h('button', { type: 'button', onclick: openHelp }, 'Cum scanez'),
    h('a', { class: 'btn', href: 'test-scanner.html' }, 'Test scanner'),
    h('button', { type: 'button', onclick: () => { map.fit(); closeSheet(); } }, 'Arată tot parcul')),
  h('p', { class: 'muted' }, 'Harta: ' + PARC.source + '.' + (VERSION ? ' Versiunea aplicației: ' + VERSION + '.' : '')));
  openSheet('Meniu', nodes, { kind: 'menu' });
}

function openHelp() {
  const steps = [
    'Apasă „Scanează”. Prima dată, permite accesul la cameră.',
    'Atinge pe hartă panoul de la care începi (primul din rând). Chenarul portocaliu arată poziția curentă.',
    'Ține eticheta panoului în chenarul galben. La bip, seria e salvată și poziția trece singură la panoul următor.',
    '„Sus-jos” înseamnă: panoul de sus, apoi cel de jos din aceeași coloană, apoi coloana următoare. „Pe rând” parcurge toate panourile de pe același nivel. „Spre est / vest” schimbă direcția.',
    '„Sari” lasă poziția goală (etichetă lipsă sau ilizibilă). „Anulează” șterge ultima scanare și te întoarce la ea.',
    'La capăt de rând auzi două sunete. Atinge primul panou al rândului următor și continuă.',
    'Semnal roșu: seria e deja scanată în alt loc sau poziția e ocupată. Alege „Mută aici” / „Înlocuiește” ori scanează alt panou.',
    'După fiecare scanare vezi clasa modulului (de ex. 715L = 715 W, curent mic; H = curent mare), paletul din care vine și ce conține paletul. Roșu înseamnă: modul spart, serie care nu e în listă sau clase amestecate pe aceeași masă.',
    'Fără semnal poți scana mai departe. Sus scrie „offline”, iar datele pleacă singure când revine internetul.',
    'Dacă închizi aplicația, „Scanează” te duce înapoi la poziția la care ai rămas.',
  ];
  openSheet('Cum scanez', [h('ol', { class: 'steps' }, steps.map((t) => h('li', {}, t))),
    h('p', { class: 'muted' }, 'Eticheta nu se citește? Încearcă lanterna și zoomul din ecranul de scanare, apropie telefonul la 10–20 cm sau scrie seria de mână.')], { kind: 'help' });
}

// ---- Sincronizare live -------------------------------------------------------
let installEvent = null;
const standalone = matchMedia('(display-mode: standalone)').matches;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (current && current.kind === 'menu') openMenu(); });
window.addEventListener('appinstalled', () => { installEvent = null; toast('Aplicația a fost instalată'); });

function syncLine() {
  const st = sync.state;
  if (st.status === 'error' || st.status === 'offline') return st.error + (st.pending ? ' De trimis: ' + st.pending + (st.pending === 1 ? ' fișier de date.' : ' fișiere de date.') : '');
  const at = st.lastSync ? ' Ultima sincronizare: ' + new Date(st.lastSync).toLocaleTimeString('ro-RO') + '.' : ' Se sincronizează…';
  return 'Conectat la ' + st.repo + '.' + at + (st.pending ? ' De trimis: ' + st.pending + '.' : '');
}

function updatePill() {
  const pill = $('syncPill'), st = sync.state;
  pill.hidden = !st.on;
  if (!st.on) return;
  const kind = st.status === 'error' ? 'err' : st.status === 'offline' ? 'off' : st.pending ? 'wait' : 'ok';
  pill.className = 'pill ' + kind;
  pill.textContent = kind === 'err' ? 'eroare' : kind === 'off' ? 'offline' + (st.pending ? ' · ' + st.pending : '') : kind === 'wait' ? 'se trimite' : 'live';
  pill.title = syncLine();
}

async function saveDeviceName(name) {
  name = String(name || '').trim().slice(0, 40);
  if (!name) return;
  store.setDeviceName(name);
  await store.kvSet('device', { name });
}

let syncBox = null;                 // caseta de stare din fișa de sincronizare, actualizată pe loc
function openSync(prefill) {
  const st = sync.state;
  const name = h('input', { type: 'text', value: store.deviceName, placeholder: 'ex. Telefon Ion, Laptop birou', onchange: () => saveDeviceName(name.value) });
  const nodes = [];
  const run = async (btn, repo, token) => {
    btn.disabled = true;
    try {
      await saveDeviceName(name.value);
      const info = await sync.connect(repo, token);
      toast('Conectat. Datele se sincronizează.');
      if (!info.private) toast('Atenție: depozitul de date este public.');
      openSync();
    } catch (e) { btn.disabled = false; err.textContent = String(e && e.message || e); err.hidden = false; }
  };
  const err = h('div', { class: 'banner', hidden: true });
  if (st.on) {
    syncBox = h('div', { class: st.status === 'error' ? 'banner' : 'okbox' }, syncLine());
    nodes.push(syncBox);
    if (st.skipped.length) nodes.push(h('div', { class: 'banner' }, 'Prea mari pentru sincronizare (peste 25 MB), rămân doar pe acest dispozitiv: ' + st.skipped.join(', ')));
    nodes.push(field('Numele acestui dispozitiv', name),
      h('p', { class: 'muted' }, 'Numele apare lângă fiecare scanare, ca să se vadă cine a scanat.'),
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'primary', onclick: async () => { await sync.syncNow(true); openSync(); } }, 'Sincronizează acum'),
        h('button', { type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(sync.connectLink()); toast('Link copiat. Trimite-l pe telefon.'); } catch (e) { link.hidden = false; link.select(); } } }, 'Copiază linkul pentru alt dispozitiv')));
    const link = h('textarea', { readonly: true, hidden: true, class: 'mono', 'aria-label': 'Link de conectare' });
    link.value = sync.connectLink();
    nodes.push(link,
      h('p', { class: 'muted' }, 'Deschide linkul pe telefon (trimis pe WhatsApp sau e-mail) și telefonul se conectează singur. Dă-l doar oamenilor care scanează: cine are linkul poate modifica datele.'),
      h('div', { class: 'btns' }, confirmButton('Deconectează acest dispozitiv', 'Sigur? Apasă din nou', async () => { await sync.disconnect(); openSync(); })));
  } else if (prefill) {
    const go = h('button', { type: 'button', class: 'primary', onclick: () => run(go, prefill.repo, prefill.token) }, 'Conectează');
    nodes.push(h('p', {}, 'Ai primit un link de conectare pentru depozitul ' + prefill.repo + '.'),
      field('Numele acestui dispozitiv', name), err, h('div', { class: 'btns' }, go));
  } else {
    const code = h('textarea', { class: 'mono', placeholder: 'PARC1.…', 'aria-label': 'Cod sau link de conectare' });
    const goCode = h('button', { type: 'button', class: 'primary', onclick: () => {
      const c = sync.parseCode(code.value);
      if (!c) { err.textContent = 'Codul nu este valid. Copiază tot linkul primit.'; err.hidden = false; return; }
      run(goCode, c.repo, c.token);
    } }, 'Conectează cu linkul');
    const repo = h('input', { type: 'text', placeholder: 'utilizator/parc-tutora-date', spellcheck: 'false', autocapitalize: 'none' });
    const token = h('input', { type: 'text', class: 'mono', placeholder: 'github_pat_…', spellcheck: 'false', autocapitalize: 'none', autocomplete: 'off' });
    const go = h('button', { type: 'button', onclick: () => run(go, repo.value, token.value) }, 'Conectează cu token');
    nodes.push(
      h('p', {}, 'Cu sincronizarea pornită, ce se scanează pe telefon apare în câteva secunde pe laptop și pe celelalte telefoane. Fără semnal, scanările rămân pe telefon și pleacă singure când revine internetul.'),
      field('Numele acestui dispozitiv', name), err,
      h('h3', {}, 'Am primit un link de conectare'),
      code, h('div', { class: 'btns' }, goCode),
      h('h3', {}, 'Prima configurare (o singură dată)'),
      h('p', { class: 'muted' }, 'Datele se țin într-un depozit privat de pe GitHub. Creează un depozit privat (de exemplu parc-tutora-date, cu „Add a README” bifat), apoi un token „fine-grained” cu acces doar la acel depozit și permisiunea Contents: Read and write.'),
      field('Depozitul de date', repo), field('Token GitHub', token),
      h('div', { class: 'btns' }, go));
  }
  openSheet('Sincronizare', nodes, { kind: 'sync' });
}
$('syncPill').addEventListener('click', () => openSync());
sync.onStatus((st) => {
  updatePill();
  if (current && current.kind === 'sync' && syncBox && syncBox.isConnected && st.status !== 'syncing') {
    syncBox.className = st.status === 'error' ? 'banner' : 'okbox';
    syncBox.textContent = syncLine();
  }
});

// ---- Tabelul cu date ---------------------------------------------------------
const dataView = createDataView($('dataView'), {
  onPanel: (pid) => { dataView.close(); openPanel(pid); map.showPanel(pid, map.panelScale()); },
  onEquip: (eid) => { dataView.close(); openEquip(eid); },
  onPallet: (id) => { dataView.close(); openPallet(id); },
});
$('dataBtn').addEventListener('click', () => { if (dataView.isOpen) dataView.close(); else { closeSheet(); dataView.open(); armBack(); } });
$('dvClose').addEventListener('click', () => dataView.close());

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
  if (pid && !scan.target) store.kvSet('lastCursor', { pid, firstTier: scan.firstTier });
  $('scanPos').textContent = pid || 'alege pe hartă';
  if (pid) map.showPanel(pid, map.panelScale()); else map.invalidate();
}

function updateScanUi() {
  const eq = !!scan.target, det = !!(scan.target && scan.target.detect);
  $('scanLbl').textContent = det ? 'Detectare paleți' : eq ? store.getEquip(scan.target.equipId).name + ' · ' + scan.target.label : 'Poziția curentă';
  if (eq) $('scanPos').textContent = det ? 'scanează un modul' : 'scanează eticheta';
  $('scanPanel').classList.toggle('detect', det);
  document.body.classList.toggle('detecting', det);
  for (const id of ['dirBtn', 'orderBtn', 'skipBtn', 'undoBtn']) $(id).hidden = eq;
  $('dirBtn').textContent = scan.dir > 0 ? 'Spre est →' : '← Spre vest';
  $('orderBtn').textContent = scan.order === 'col' ? 'Sus-jos' : 'Pe rând';
}

async function startCamera() {
  if ($('camStart').disabled) return;
  $('camStart').disabled = true;
  const res = await scanner.start();
  $('camStart').disabled = false;
  if (res.cancelled || !scan.active) return;
  if (!res.ok) { $('camMsg').textContent = res.error; $('idle').hidden = false; $('reticle').hidden = true; return; }
  $('idle').hidden = true; $('reticle').hidden = false;
  $('scanLbl').title = 'Cititor: ' + scanner.info.engine;
  $('torchBtn').hidden = !res.torch; $('torchBtn').setAttribute('aria-pressed', 'false');
  if (res.zoom) {
    const z = $('camZoom');
    z.min = res.zoom.min; z.max = res.zoom.max; z.step = res.zoom.step || 0.1; z.value = res.zoom.value;
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
  armBack();
  scan.active = true; scan.target = target || null; scan.history = [];
  $('modInfo').hidden = true;
  $('scanPanel').hidden = false; $('scanFab').hidden = true; $('detectFab').hidden = true;
  clearNotice(); scanMsg('', '');
  updateScanUi();
  updateInsets();
  if (!scan.target) {
    const last = pid ? null : await store.kvGet('lastCursor');
    if (pid) { scan.firstTier = store.parsePanel(pid).tier; setCursor(pid); }
    else if (last && last.pid && store.baseTables.has(last.pid.slice(0, 7))) {
      scan.firstTier = last.firstTier === 1 ? 1 : 0; setCursor(last.pid);
      scanMsg('', 'Continui de unde ai rămas. Atinge alt panou pe hartă ca să schimbi locul.');
    } else { setCursor(null); scanMsg('', 'Atinge pe hartă panoul de la care începi.'); }
  }
  if (await scanner.ready) await startCamera();
  else { $('camMsg').textContent = 'Cititorul de coduri nu a putut porni în acest browser. Scrie codul mai jos sau folosește „Din poză”.'; $('camStart').hidden = true; if (isWide()) $('scanInput').focus(); }
  updateInsets();
  if (scan.cursor) map.showPanel(scan.cursor, map.panelScale());
}

function stopScan() {
  const target = scan.target;
  stopCamera();
  scan.active = false; scan.target = null; scan.cursor = null; map.state.cursor = null;
  $('scanPanel').hidden = true; $('scanFab').hidden = false; $('detectFab').hidden = false;
  $('scanPanel').classList.remove('detect');
  document.body.classList.remove('detecting');
  updateInsets(); map.invalidate();
  if (target && target.equipId) openEquip(target.equipId);
}

// ---- Detectare paleți --------------------------------------------------------
// Se scanează un modul (de exemplu după ce s-a rupt cartonul) și se află paletul, clasa și ce conține paletul.
// Nimic nu se pune pe hartă. A doua serie din același palet confirmă identificarea.
let detectLast = null;
let detectHistory = [];                              // [{ palet, six, t }], cele mai noi primele

function detectCode(code) {
  const info = pal.lookup(code);
  const box = $('modInfo');
  if (!info) {
    flash('dup'); scanMsg('dup', 'Seria nu e în listă');
    $('scanPos').textContent = '—';
    box.replaceChildren(h('div', { class: 'warn' }, 'Seria ' + code + ' nu este în lista de paleți. Verifică eticheta sau tastează ultimele 6 cifre.'), historyBox());
    box.hidden = false; updateInsets();
    return;
  }
  const p = pal.pallet(info.palet);
  let confirm = null;
  if (detectLast && detectLast.six !== info.six) {
    confirm = detectLast.palet === info.palet
      ? h('div', { class: 'okline' }, '✓ Confirmat: și seria ' + detectLast.six + ' e din paletul ' + info.palet + '.')
      : h('div', { class: 'warn' }, 'Seria anterioară (' + detectLast.six + ') era din paletul ' + detectLast.palet + '. Dacă sunt pe același palet, verifică etichetele.');
  } else if (!detectLast || detectLast.six === info.six) {
    confirm = h('div', { class: 'muted' }, 'Pentru siguranță, scanează încă un modul de pe același palet.');
  }
  detectLast = { palet: info.palet, six: info.six };
  detectHistory = [{ palet: info.palet, six: info.six, t: Date.now() }, ...detectHistory.filter((x) => x.palet !== info.palet)].slice(0, 50);
  store.kvSet('detectHistory', detectHistory);
  flash(info.broken ? 'dup' : 'ok');
  scanMsg(info.broken ? 'dup' : 'ok', 'Seria ' + info.six + ' · ' + info.cls);
  $('scanPos').textContent = 'Palet ' + info.palet;
  box.replaceChildren(...[
    h('div', { class: 'top' },
      h('span', { class: 'cls', style: 'background:' + pal.classColor(info.cls) }, info.cls),
      h('span', {}, 'Modulul scanat: ' + info.clsText)),
    h('div', {}, h('strong', {}, 'Paletul ' + info.palet), ' (' + p.full + ') conține:'),
    h('div', { class: 'top' }, Object.entries(p.counts).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
      h('span', { class: 'chipcls' }, h('span', { class: 'cls sm', style: 'background:' + pal.classColor(c) }, c), ' ' + n + ' module · ' + (PALETI_TXT[c] || '')))),
    info.note ? h('div', { class: 'warn' }, 'Modulul ' + info.six + ': ' + info.note) : null,
    p.note ? h('div', { class: 'warn' }, p.note) : null,
    h('div', { class: 'muted' }, 'Scrie pe palet: „' + info.palet + ' – ' + Object.keys(p.counts).join(' + ') + '”. Montate deja: ' + p.mounted + ' din ' + p.mods.length + '.'),
    confirm,
    h('div', {}, h('button', { type: 'button', class: 'link', onclick: () => { stopScan(); openPallet(info.palet); } }, 'Vezi toate cele ' + p.mods.length + ' module ale paletului')),
    historyBox(info.palet),
  ].filter(Boolean));
  box.hidden = false; updateInsets();
}
const PALETI_TXT = { '720L': '720 W, curent mic', '715L': '715 W, curent mic', '710H': '710 W, curent mare', '710L': '710 W, curent mic' };

function historyBox(skip) {
  const list = detectHistory.filter((x) => x.palet !== skip).slice(0, 6);
  if (!list.length) return null;
  return h('div', { class: 'muted' }, 'Detectate înainte: ', list.map((x, i) => [i ? ', ' : '',
    h('button', { type: 'button', class: 'link', onclick: () => { stopScan(); openPallet(x.palet); } }, x.palet + ' (' + Object.keys(pal.pallet(x.palet).counts).join('+') + ')')]).flat());
}

function startDetect() {
  detectLast = null;
  startScan(null, { detect: true }).then(() => {
    const box = $('modInfo');
    box.replaceChildren(...[h('div', {}, 'Scanează codul de bare de pe un modul. Afli din ce palet face parte și ce tipuri de module sunt în acel palet.'), historyBox()].filter(Boolean));
    box.hidden = false; updateInsets();
  });
}

// Caseta din scanare: clasa (putere + intensitate), paletul și ce conține paletul.
function moduleBox(code, pid) {
  const box = $('modInfo');
  const info = pal.lookup(code);
  if (!info) {
    box.replaceChildren(h('div', { class: 'warn' }, 'Seria ' + code + ' nu este în lista de paleți. Verifică eticheta.'));
  } else {
    const p = pal.pallet(info.palet);
    const tid = pid ? pid.slice(0, 7) : '';
    const others = tid ? pal.tableClasses(tid, pid) : {};
    const mix = Object.keys(others).filter((c) => c !== info.cls);
    box.replaceChildren(...[
      h('div', { class: 'top' },
        h('span', { class: 'cls', style: 'background:' + pal.classColor(info.cls) }, info.cls),
        h('span', {}, info.clsText)),
      h('div', {}, h('button', { type: 'button', class: 'link', onclick: () => openPallet(info.palet) }, 'Palet ' + info.palet),
        ' · ' + pal.countsText(p.counts) + ' · montate ' + p.mounted + '/33'),
      info.note ? h('div', { class: info.broken || info.separate ? 'warn' : '' }, info.note) : null,
      mix.length ? h('div', { class: 'warn' }, 'Atenție: pe masa ' + tid + ' sunt deja module ' + mix.join(', ') + '. Clasele nu se amestecă în același string.') : null,
    ].filter(Boolean));
  }
  box.hidden = false;
  updateInsets();
  return info;
}

function place(code, src, movedFrom) {
  const pid = scan.cursor;
  scan.history.push({ pid, prev: store.getSn(pid), movedFrom });
  store.setPanel(pid, code, src);
  const info = moduleBox(code, pid);
  const tid = pid.slice(0, 7), mixed = info && Object.keys(pal.tableClasses(tid)).length > 1;
  if (!info || mixed) { flash('dup'); scanMsg('dup', code + ' → ' + pid + (info ? ' · clase amestecate' : ' · serie necunoscută')); }
  else { flash('ok'); scanMsg('ok', code + ' → ' + pid + ' · ' + info.cls + ' · palet ' + info.palet); }
  advance();
}
function advance() {
  const n = nextPos(scan.cursor);
  if (n) { setCursor(n); return; }
  setCursor(null);
  store.kvSet('lastCursor', null);
  beep('end');
  scanMsg('', 'Capăt de rând. Atinge pe hartă primul panou al rândului următor.');
}

function handleCode(raw, src) {
  let code = String(raw || '').trim();
  if (!scan.active || !code) return;
  clearNotice();
  if (!scan.target) code = pal.normalize(code);         // „000716” tastat devine seria completă
  if (scan.target && scan.target.detect) { detectCode(pal.normalize(code)); return; }
  if (scan.target) {
    store.setEquip(scan.target.equipId, { [scan.target.key]: code });
    flash('ok'); toast(scan.target.label + ': ' + code);
    stopScan();
    return;
  }
  if (!scan.cursor) { flash('dup'); scanMsg('dup', 'Alege mai întâi panoul de start pe hartă.'); scanner.release(); return; }
  const at = store.snIndex.get(code), cur = store.getSn(scan.cursor);
  if (at === scan.cursor) { flash('ok'); scanMsg('ok', 'Confirmat: ' + code); moduleBox(code, scan.cursor); scan.history.push({ pid: scan.cursor, prev: cur }); advance(); return; }
  const info = pal.lookup(code);
  if (info && info.broken && !at) {
    flash('dup'); scanMsg('dup', 'Modul spart'); moduleBox(code);
    notice('Modulul ' + info.six + ' (palet ' + info.palet + ') e marcat SPART — NU se montează.', 'Pune oricum', () => place(code, src));
    return;
  }
  if (at) {
    flash('dup'); scanMsg('dup', 'Dublură');
    notice('Codul ' + code + ' este deja la ' + at + '.' + (cur ? ' Seria ' + cur + ' de aici va fi înlocuită.' : ''), 'Mută aici', () => { store.setPanel(at, '', ''); place(code, src, { pid: at, sn: code }); });
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
$('viewer').addEventListener('click', (e) => {
  if (!scanner.running) return;
  const r = $('viewer').getBoundingClientRect();
  scanner.focusAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
});

// Scanner extern (Bluetooth / USB, „ca o tastatură”): tastează foarte repede și apasă Enter.
// Codul se prinde oriunde în aplicație cât e deschisă scanarea, fără să atingi câmpul de text.
let wedge = { buf: '', t: 0 };
document.addEventListener('keydown', (e) => {
  if (!scan.active || e.ctrlKey || e.altKey || e.metaKey) return;
  const inField = e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.id !== 'scanInput';
  if (inField) return;
  const now = performance.now();
  if (now - wedge.t > 80) wedge.buf = '';
  wedge.t = now;
  if (e.key === 'Enter') {
    if (wedge.buf.length >= 6) { e.preventDefault(); const code = wedge.buf; wedge.buf = ''; if (e.target.id === 'scanInput') e.target.value = ''; handleCode(code, 'scanner'); }
    return;
  }
  if (e.key.length === 1) wedge.buf += e.key;
}, true);

// Poză cu rezoluție completă: merge mai bine la etichete mici sau în soare puternic.
$('photoInput').addEventListener('change', async () => {
  const inp = $('photoInput'), file = inp.files && inp.files[0];
  inp.value = '';
  if (!file || !scan.active) return;
  scanMsg('', 'Caut coduri în poză…');
  const codes = await scanner.detectFile(file);
  if (!codes.length) { flash('dup'); scanMsg('dup', 'Niciun cod găsit în poză. Apropie-te la 15–30 cm, ține telefonul drept și evită reflexia.'); return; }
  if (scan.target && scan.target.detect) {
    const infos = codes.map((c) => pal.lookup(pal.normalize(c))).filter(Boolean);
    detectCode(pal.normalize(codes[0]));
    if (codes.length > 1) {                          // mai multe etichete în poză: din ce paleți sunt
      const per = {};
      for (const i of infos) per[i.palet] = (per[i.palet] || 0) + 1;
      const txt = Object.entries(per).map(([p, n]) => n + ' din paletul ' + p).join(', ');
      $('modInfo').prepend(h('div', { class: Object.keys(per).length > 1 ? 'warn' : 'okline' },
        'În poză: ' + codes.length + ' coduri' + (txt ? ' — ' + txt : '') + (infos.length < codes.length ? ', ' + (codes.length - infos.length) + ' necunoscute' : '') + '.'));
    }
    return;
  }
  handleCode(codes[0], 'poză');
  if (codes.length > 1) toast('În poză erau ' + codes.length + ' coduri; l-am luat pe cel din mijloc.');
});
$('detectFab').addEventListener('click', startDetect);
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
  $('modeCls').setAttribute('aria-pressed', String(mode === 'clase'));
  map.invalidate();
}
$('modeProgres').addEventListener('click', () => setMode('progres'));
$('modeCls').addEventListener('click', () => { setMode('clase'); toast('720L albastru · 715L verde · 710L portocaliu · 710H roșu. Chenar roșu = clase amestecate.'); });
$('modeInv').addEventListener('click', () => setMode('inv'));
window.addEventListener('resize', updateInsets);

// ---- Pornire -----------------------------------------------------------------
let saveTimer = 0;
store.onChange((what) => {
  if (what === 'storage') toast('Atenție: telefonul nu mai poate salva date (memorie plină?). Nu închide aplicația până nu se sincronizează.');
  updateProgress(); map.invalidate();
  const typing = document.activeElement && $('sheet').contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  const viewing = current && ['panel', 'table', 'equip', 'equipList', 'menu', 'pallet'].includes(current.kind);
  if (what === 'import' || (!typing && what === 'sync' && viewing)
    || (!typing && current && (current.kind === 'panel' || current.kind === 'table') && what === 'panels')) reopen();
  if (io.folderConnected()) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => { await io.syncFolder(); if (current && current.kind === 'menu') openMenu(); if (io.folder.error) toast('Salvarea în folder a eșuat'); }, 1200);
  }
});

(async function init() {
  await store.init();
  const prefs = await store.kvGet('scanPrefs');
  if (prefs) { scan.dir = prefs.dir === -1 ? -1 : 1; scan.order = prefs.order === 'row' ? 'row' : 'col'; }
  detectHistory = (await store.kvGet('detectHistory')) || [];
  const dev = await store.kvGet('device');
  store.setDeviceName(dev && dev.name ? dev.name : (matchMedia('(pointer: coarse)').matches ? 'Telefon ' : 'Laptop ') + Math.floor(100 + Math.random() * 900));
  if (!dev || !dev.name) await store.kvSet('device', { name: store.deviceName });
  try { await io.restoreFolder(); } catch (e) { /* fără folder */ }
  io.setBlobFetcher((f) => (sync.state.on && f.up ? sync.fetchFile(f).catch(() => null) : null));
  try { await sync.restore(); } catch (e) { /* fără sincronizare */ }
  updatePill();
  const pair = location.hash.match(/^#conectare=(.+)$/);
  if (pair) {                                       // link de conectare primit de la alt dispozitiv
    history.replaceState(null, '', location.pathname + location.search);
    const c = sync.parseCode(decodeURIComponent(pair[1]));
    if (!c) toast('Linkul de conectare nu este valid');
    else if (sync.state.on && sync.state.repo === c.repo) toast('Dispozitivul este deja conectat');
    else openSync(c);
  }
  $('parkName').textContent = PARC.name;
  updateProgress(); updateInsets(); map.fit();
  if (io.folder.needsPermission) toast('Folderul „' + io.folder.name + '” trebuie reconectat din Meniu');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('Versiune nouă instalată. Se aplică la următoarea deschidere a aplicației.'); });
    navigator.serviceWorker.register('sw.js').catch(() => {});
    try {
      const key = (await caches.keys()).filter((k) => k.startsWith('parc-inventar-')).sort().pop();
      if (key) VERSION = key.slice('parc-inventar-'.length);
    } catch (e) { /* fără cache */ }
  }
  window.__app = { store, map, scan, io, sync, handleCode };       // pentru depanare din consolă
})();
