// Lista modulelor pe paleți: din seria scanată află clasa modulului (putere + intensitate), paletul
// și ce conține paletul. Datele vin din docs/paleti-data.js (generat din Excelul de la furnizor).
import { PALETI } from '../paleti-data.js';
import { PARC } from '../parc-data.js';
import * as store from './store.js';

export const CLASS_COLORS = { '720L': '#1f6fd6', '715L': '#16a085', '710L': '#e08a00', '710H': '#c0392b' };
export const classColor = (c) => CLASS_COLORS[c] || '#777';
export const CLASSES = Object.keys(PALETI.clase);
export const TOTAL_MODULES = Object.values(PALETI.paleti).reduce((a, p) => a + p.s.split(' ').length, 0);

const bySerial = new Map();                          // ultimele 6 cifre -> { palet, cls }
const palletMods = new Map();                        // palet -> [{ six, cls }]
for (const [pal, p] of Object.entries(PALETI.paleti)) {
  const mods = p.s.split(' ').map((six) => ({ six, cls: (p.x && p.x[six]) || p.c }));
  palletMods.set(pal, mods);
  for (const m of mods) bySerial.set(m.six, { palet: pal, cls: m.cls });
}
export const palletIds = [...palletMods.keys()];

// Seria completă din ce s-a citit sau tastat. Etichetele de pe ramă au și clasa de curent la final
// („A161098744B97012353-L”), uneori cu spațiu; se păstrează doar seria. Merg și doar ultimele 6 cifre.
const SERIAL_RE = new RegExp(PALETI.prefixSerie + '\\s*(\\d{6})', 'i');
export function normalize(code) {
  const c = String(code || '').trim().toUpperCase().replace(/[\u0000-\u001f]/g, '');
  const m = c.match(SERIAL_RE);
  if (m) return PALETI.prefixSerie + m[1];
  const six = c.match(/^(\d{6})(\s*-\s*[LH])?$/);
  if (six && bySerial.has(six[1])) return PALETI.prefixSerie + six[1];
  return c;
}
// Litera de pe etichetă (L sau H), dacă a fost citită.
export function labelCurrent(code) {
  const m = String(code || '').toUpperCase().match(/\d{6}\s*-\s*([LH])\s*$/);
  return m ? m[1] : '';
}
function sixOf(sn) {
  const c = String(sn || '').trim().toUpperCase();
  const m = c.match(SERIAL_RE);
  if (m) return m[1];
  if (/^\d{6}$/.test(c)) return c;
  return null;
}

// Informații despre un modul după serie; null dacă seria nu e în listă.
export function lookup(sn) {
  const six = sixOf(sn);
  const hit = six && bySerial.get(six);
  if (!hit) return null;
  const note = PALETI.observatii[six] || '';
  return { six, serial: PALETI.prefixSerie + six, palet: hit.palet, paletFull: PALETI.prefixPalet + hit.palet, cls: hit.cls,
    clsText: PALETI.clase[hit.cls] || hit.cls, note, broken: /SPART/i.test(note), separate: /separat/i.test(note) };
}

// Componența unui palet: clase și număr de module, plus unde a ajuns fiecare modul în parc.
export function pallet(pal) {
  const mods = palletMods.get(pal);
  if (!mods) return null;
  const counts = {};
  for (const m of mods) counts[m.cls] = (counts[m.cls] || 0) + 1;
  const list = mods.map((m) => {
    const serial = PALETI.prefixSerie + m.six;
    return { six: m.six, serial, cls: m.cls, note: PALETI.observatii[m.six] || '', pid: store.snIndex.get(serial) || '' };
  });
  return { id: pal, full: PALETI.prefixPalet + pal, cls: PALETI.paleti[pal].c, note: PALETI.paleti[pal].n || '', counts, mods: list,
    mounted: list.filter((m) => m.pid).length };
}
export const countsText = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => n + ' × ' + c).join(', ');

// Clasele modulelor deja montate pe o masă (o masă = un string; clasele nu se amestecă în același string).
export function tableClasses(tid, exceptPid) {
  const out = {};
  for (let tier = 0; tier < PARC.tiers; tier++) {
    for (let col = 0; col < PARC.cols; col++) {
      const pid = store.panelId(tid, tier, col);
      if (pid === exceptPid) continue;
      const info = lookup(store.getSn(pid));
      if (info) out[info.cls] = (out[info.cls] || 0) + 1;
    }
  }
  return out;
}

// Mese cu module de clase diferite (de verificat).
export function mixedTables() {
  return PARC.tables.filter((t) => Object.keys(tableClasses(t.id)).length > 1).map((t) => t.id);
}

// Serii scanate care nu apar în lista de paleți.
export function unknownSerials() {
  const out = [];
  for (const [pid, p] of store.panels) if (p && p.sn && !lookup(p.sn)) out.push({ pid, sn: p.sn });
  return out.sort((a, b) => (a.pid < b.pid ? -1 : 1));
}
