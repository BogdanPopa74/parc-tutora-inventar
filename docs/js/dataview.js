// Tabelul cu date: toate panourile și echipamentele, cu filtre, pentru verificare (mai ales pe laptop).
import { PARC } from '../parc-data.js';
import * as store from './store.js';
import { invColor } from './map.js';
import { TYPE_NAMES, fieldsOf } from './io.js';
import * as pal from './paleti.js';

const PAGE = 200;
const invName = (n) => 'INV' + String(n).padStart(2, '0');
const when = (t) => (t ? new Date(t).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

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

export function createDataView(root, { onPanel, onEquip, onPallet }) {
  const f = { tab: 'panouri', q: '', row: '', inv: '', cls: '', status: 'toate', sort: 'pozitie', limit: PAGE };
  const body = root.querySelector('#dvBody'), summary = root.querySelector('#dvSummary'), filters = root.querySelector('#dvFilters');
  let timer = 0;

  const search = h('input', { type: 'text', placeholder: 'Caută serie sau poziție', spellcheck: 'false', 'aria-label': 'Caută', oninput: () => { f.q = search.value.trim().toLowerCase(); f.limit = PAGE; draw(); } });
  const rowSel = h('select', { 'aria-label': 'Rând', onchange: () => { f.row = rowSel.value; f.limit = PAGE; draw(); } },
    h('option', { value: '' }, 'Toate rândurile'), [...new Set(PARC.tables.map((t) => t.row))].map((r) => h('option', { value: r }, 'Rândul ' + r)));
  const invSel = h('select', { 'aria-label': 'Invertor', onchange: () => { f.inv = invSel.value; f.limit = PAGE; draw(); } });
  const statusSel = h('select', { 'aria-label': 'Stare', onchange: () => { f.status = statusSel.value; f.limit = PAGE; draw(); } },
    [['toate', 'Toate'], ['scanate', 'Scanate'], ['nescanate', 'Nescanate'], ['dubluri', 'Dubluri'], ['probleme', 'De verificat (clase amestecate, serii necunoscute, sparte)']].map(([v, t]) => h('option', { value: v }, t)));
  const clsSel = h('select', { 'aria-label': 'Clasă', onchange: () => { f.cls = clsSel.value; f.limit = PAGE; draw(); } },
    h('option', { value: '' }, 'Toate clasele'), pal.CLASSES.map((c) => h('option', { value: c }, c)));
  const sortSel = h('select', { 'aria-label': 'Ordine', onchange: () => { f.sort = sortSel.value; draw(); } },
    h('option', { value: 'pozitie' }, 'În ordinea pozițiilor'), h('option', { value: 'recente' }, 'Cele mai recente primele'));
  const tabP = h('button', { type: 'button', onclick: () => setTab('panouri') }, 'Panouri');
  const tabE = h('button', { type: 'button', onclick: () => setTab('echipamente') }, 'Echipamente');
  const tabL = h('button', { type: 'button', onclick: () => setTab('paleti') }, 'Paleți');
  root.querySelector('#dvTabs').replaceChildren(tabP, tabL, tabE);
  filters.replaceChildren(search, rowSel, invSel, clsSel, statusSel, sortSel);

  function setTab(tab) { f.tab = tab; f.limit = PAGE; draw(); }

  function fillInverters() {
    const keep = f.inv;
    invSel.replaceChildren(h('option', { value: '' }, 'Toate invertoarele'), store.inverterNumbers().map((n) => h('option', { value: n }, invName(n))));
    invSel.value = keep;
  }

  function panelRows() {
    const dups = new Map();
    for (const d of store.findDuplicates()) for (const pid of d.pids) dups.set(pid, d.pids.length);
    const rows = [];
    const mixed = f.status === 'probleme' ? new Set(pal.mixedTables()) : null;
    for (const base of PARC.tables) {
      const t = store.getTable(base.id);
      if (f.row && String(t.row) !== f.row) continue;
      if (f.inv && String(t.inv) !== f.inv) continue;
      for (let tier = 0; tier < PARC.tiers; tier++) {
        for (let col = 0; col < PARC.cols; col++) {
          const pid = store.panelId(t.id, tier, col), rec = store.panels.get(pid) || {}, sn = rec.sn || '';
          if (f.status === 'scanate' && !sn) continue;
          if (f.status === 'nescanate' && sn) continue;
          if (f.status === 'dubluri' && !dups.has(pid)) continue;
          const info = sn ? pal.lookup(sn) : null;
          if (f.cls && (!info || info.cls !== f.cls)) continue;
          if (mixed && !(sn && (!info || info.broken || dups.has(pid) || mixed.has(t.id)))) continue;
          if (f.q && !sn.toLowerCase().includes(f.q) && !pid.toLowerCase().includes(f.q)) continue;
          rows.push({ pid, sn, t, rec, dup: dups.has(pid), info });
        }
      }
    }
    if (f.sort === 'recente') rows.sort((a, b) => (b.sn ? b.rec.t || 0 : 0) - (a.sn ? a.rec.t || 0 : 0));
    return { rows, dupCount: store.findDuplicates().length };
  }

  function drawSummary(dupCount) {
    const per = new Map();
    for (const base of PARC.tables) {
      const t = store.getTable(base.id), p = per.get(t.inv) || { done: 0, total: 0 };
      p.done += store.tableProgress(t.id); p.total += PARC.cols * PARC.tiers;
      per.set(t.inv, p);
    }
    const total = PARC.tables.length * PARC.cols * PARC.tiers, done = store.scannedCount();
    summary.replaceChildren(...[
      h('strong', {}, 'Scanate ' + done + ' din ' + total + ' (' + (100 * done / total).toFixed(1) + '%)'),
      dupCount ? h('button', { type: 'button', class: 'chip warn', onclick: () => { statusSel.value = f.status = 'dubluri'; setTab('panouri'); } }, 'Serii duble: ' + dupCount) : null,
      h('div', { class: 'chips' }, [...per].sort((a, b) => a[0] - b[0]).map(([n, p]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.inv === String(n)),
        onclick: () => { f.inv = f.inv === String(n) ? '' : String(n); invSel.value = f.inv; setTab('panouri'); } },
      h('span', { class: 'swatch', style: 'background:' + invColor(n) }), invName(n) + ' ' + p.done + '/' + p.total))),
    ].filter(Boolean));
  }

  function draw() {
    if (root.hidden) return;
    tabP.setAttribute('aria-pressed', String(f.tab === 'panouri'));
    tabE.setAttribute('aria-pressed', String(f.tab === 'echipamente'));
    tabL.setAttribute('aria-pressed', String(f.tab === 'paleti'));
    filters.hidden = f.tab !== 'panouri';
    fillInverters();
    const scroll = body.scrollTop;
    if (f.tab === 'paleti') {
      drawSummary(store.findDuplicates().length);
      const list = pal.palletIds.map((id) => pal.pallet(id));
      const done = list.filter((p) => p.mounted === p.mods.length).length, started = list.filter((p) => p.mounted && p.mounted < p.mods.length).length;
      const rows = list.map((p) => {
        const tables = [...new Set(p.mods.filter((m) => m.pid).map((m) => m.pid.slice(0, 7)))];
        return h('tr', { tabindex: '0', onclick: () => onPallet(p.id), onkeydown: (ev) => { if (ev.key === 'Enter') onPallet(p.id); } },
          h('td', { class: 'mono' }, p.id),
          h('td', {}, Object.keys(p.counts).map((c) => h('span', { class: 'cls sm', style: 'background:' + pal.classColor(c) + ';margin-right:4px' }, c))),
          h('td', {}, pal.countsText(p.counts)),
          h('td', { class: 'num' }, p.mounted + ' / ' + p.mods.length),
          h('td', {}, tables.join(', ')), h('td', { class: p.note ? 'warnline' : '' }, p.note));
      });
      body.replaceChildren(
        h('p', { class: 'muted' }, list.length + ' paleți · ' + pal.TOTAL_MODULES + ' module · ' + done + ' montați complet, ' + started + ' începuți, ' + (list.length - done - started) + ' neatinși.'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Palet', 'Clasă', 'Conține', 'Montate', 'Mese', 'Observații'].map((c) => h('th', {}, c)))), h('tbody', {}, rows)));
    } else if (f.tab === 'echipamente') {
      drawSummary(store.findDuplicates().length);
      const rows = store.listEquip().map((e) => {
        const info = fieldsOf(e.type).filter(([key]) => e[key]).map(([key, label]) => label + ': ' + e[key])
          .concat((e.extra || []).filter((x) => x.k || x.v).map((x) => x.k + ': ' + x.v));
        return h('tr', { tabindex: '0', onclick: () => onEquip(e.id), onkeydown: (ev) => { if (ev.key === 'Enter') onEquip(e.id); } },
          h('td', {}, e.name), h('td', {}, TYPE_NAMES[e.type] || e.type), h('td', {}, info.join(' · ')),
          h('td', {}, String(store.filesOf(e.id).length || '')));
      });
      body.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Nume', 'Tip', 'Informații', 'Fișiere'].map((c) => h('th', {}, c)))), h('tbody', {}, rows)));
    } else {
      const { rows, dupCount } = panelRows();
      drawSummary(dupCount);
      const shown = rows.slice(0, f.limit);
      const trs = shown.map((r) => h('tr', { tabindex: '0', class: r.dup ? 'dup' : '', onclick: () => onPanel(r.pid), onkeydown: (ev) => { if (ev.key === 'Enter') onPanel(r.pid); } },
        h('td', { class: 'mono' }, r.pid), h('td', { class: 'mono sn' }, r.sn || '—'),
        h('td', {}, r.info ? h('span', { class: 'cls sm', style: 'background:' + pal.classColor(r.info.cls) }, r.info.cls) : r.sn ? h('span', { class: 'warnline' }, 'necunoscută') : ''),
        h('td', { class: 'mono' }, r.info ? r.info.palet : ''),
        h('td', {}, h('span', { class: 'swatch', style: 'background:' + invColor(r.t.inv) }), ' ' + invName(r.t.inv)),
        h('td', { class: 'num' }, String(r.t.str)), h('td', {}, r.sn ? when(r.rec.t) : ''), h('td', {}, r.sn ? (r.rec.by || r.rec.src || '') : '')));
      body.replaceChildren(...[
        h('p', { class: 'muted' }, rows.length + (rows.length === 1 ? ' panou' : ' panouri') + (shown.length < rows.length ? ', afișate primele ' + shown.length : '') + '. Apasă pe un rând ca să îl vezi pe hartă.'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Poziție', 'Serie', 'Clasă', 'Palet', 'Invertor', 'String', 'Scanat', 'De cine'].map((c) => h('th', {}, c)))), h('tbody', {}, trs)),
        shown.length < rows.length ? h('button', { type: 'button', onclick: () => { f.limit += PAGE * 2; draw(); } }, 'Arată mai multe') : null,
      ].filter(Boolean));
    }
    body.scrollTop = scroll;
  }

  store.onChange(() => {                             // se actualizează singur când vin date noi
    if (root.hidden) return;
    clearTimeout(timer);
    timer = setTimeout(draw, 400);
  });

  return {
    open(tab) { if (tab) { f.tab = tab; f.limit = PAGE; } root.hidden = false; draw(); },
    close() { root.hidden = true; },
    get isOpen() { return !root.hidden; },
  };
}
