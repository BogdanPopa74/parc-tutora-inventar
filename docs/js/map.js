// Harta parcului: desen pe canvas, cu deplasare, zoom și selecție prin atingere.
import { PARC } from '../parc-data.js';
import * as store from './store.js';
import { lookup, classColor, tableClasses } from './paleti.js';

export const INV_COLORS = ['#e6194b', '#f58231', '#b8960a', '#2e9e45', '#149c9c', '#3f63d8', '#8e24aa', '#d6409f', '#8a5a2b',
  '#5b6b7a', '#7cb518', '#c1121f', '#0077b6', '#6a4c93', '#bc6c25', '#2a9d8f'];
export const invColor = (n) => INV_COLORS[(n - 1) % INV_COLORS.length] || '#777';

const PANEL_MIN_PX = 5;      // sub această lățime a panoului desenăm doar masa, ca bloc
const rowEnds = PARC.tables.filter((t, i) => !PARC.tables[i + 1] || PARC.tables[i + 1].row !== t.row);   // ultima masă din fiecare rând
const PW = (t) => t.w / PARC.cols;
const PH = (t) => t.h / PARC.tiers;

export function createMap(canvas, onTap) {
  const ctx = canvas.getContext('2d');
  const view = { s: 1, tx: 0, ty: 0 };
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  const state = { mode: 'progres', selected: null, cursor: null, placing: false };
  let css = {};
  let cw = 0, ch = 0, dpr = 1, dirty = false;

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    css = { bg: v('--map-bg'), ink: v('--ink'), muted: v('--muted'), line: v('--line'), empty: v('--panel-empty'),
      ok: v('--panel-ok'), okInk: v('--panel-ok-ink'), cursor: v('--cursor'), select: v('--select'), outline: v('--outline'),
      surface: v('--surface') };
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    cw = r.width; ch = r.height;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    invalidate();
  }

  function invalidate() {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => { dirty = false; draw(); });
  }

  // ---- Transformări -------------------------------------------------------
  const toScreen = (x, y) => [x * view.s + view.tx, y * view.s + view.ty];
  const toWorld = (px, py) => [(px - view.tx) / view.s, (py - view.ty) / view.s];
  const panelsVisible = () => PW(PARC.tables[0]) * view.s >= PANEL_MIN_PX;

  function visibleCenter() {
    return [inset.left + (cw - inset.left - inset.right) / 2, inset.top + (ch - inset.top - inset.bottom) / 2];
  }
  function clampScale(s) { return Math.min(90, Math.max(0.4, s)); }

  function fit() {
    const w = cw - inset.left - inset.right - 24, h = ch - inset.top - inset.bottom - 24;
    view.s = clampScale(Math.min(w / PARC.width, h / PARC.height));
    const [cx, cy] = visibleCenter();
    view.tx = cx - (PARC.width / 2) * view.s;
    view.ty = cy - (PARC.height / 2) * view.s;
    invalidate();
  }

  function centerOn(x, y, minScale) {
    if (minScale && view.s < minScale) view.s = clampScale(minScale);
    const [cx, cy] = visibleCenter();
    view.tx = cx - x * view.s;
    view.ty = cy - y * view.s;
    invalidate();
  }

  function zoomAt(px, py, factor) {
    const s = clampScale(view.s * factor);
    const [wx, wy] = toWorld(px, py);
    view.s = s;
    view.tx = px - wx * s;
    view.ty = py - wy * s;
    invalidate();
  }

  function panelRect(pid) {
    const { tableId, tier, col } = store.parsePanel(pid);
    const t = store.baseTables.get(tableId);
    if (!t) return null;
    return { x: t.x + col * PW(t), y: t.y + tier * PH(t), w: PW(t), h: PH(t) };
  }

  function showPanel(pid, minScale) {
    const r = panelRect(pid);
    if (r) centerOn(r.x + r.w / 2, r.y + r.h / 2, minScale || 0);
  }
  function showTable(tid, minScale) {
    const t = store.baseTables.get(tid);
    if (t) centerOn(t.x + t.w / 2, t.y + t.h / 2, minScale || 0);
  }

  // ---- Desen --------------------------------------------------------------
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css.bg;
    ctx.fillRect(0, 0, cw, ch);
    const s = view.s;
    const [wx0, wy0] = toWorld(0, 0), [wx1, wy1] = toWorld(cw, ch);

    ctx.strokeStyle = css.outline; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of PARC.outline) {
      const a = toScreen(x1, y1), b = toScreen(x2, y2);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();

    const detailed = panelsVisible();
    const sel = state.selected;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const base of rowEnds) drawRowLabel(base);
    for (const base of PARC.tables) {
      if (base.x > wx1 || base.x + base.w < wx0 || base.y > wy1 + 2 || base.y + base.h < wy0 - 2) continue;
      const t = store.getTable(base.id);
      if (detailed) drawPanels(t, s); else drawBlock(t, s);
      if (sel && sel.kind === 'table' && sel.id === t.id) {
        const [x, y] = toScreen(t.x, t.y);
        ctx.strokeStyle = css.select; ctx.lineWidth = 3;
        ctx.strokeRect(x - 2, y - 2, t.w * s + 4, t.h * s + 4);
      }
    }
    for (const pid of [sel && sel.kind === 'panel' ? sel.id : null, state.cursor]) {
      if (!pid) continue;
      const r = panelRect(pid);
      if (!r) continue;
      const [x, y] = toScreen(r.x, r.y);
      ctx.strokeStyle = pid === state.cursor ? css.cursor : css.select;
      ctx.lineWidth = pid === state.cursor ? 4 : 3;
      ctx.strokeRect(x - 1, y - 1, r.w * s + 2, r.h * s + 2);
    }
    for (const e of store.listEquip()) drawEquip(e, s);
  }

  function drawRowLabel(t) {
    const s = view.s;
    if (s < 1.1) return;
    const [x, y] = toScreen(t.x + t.w + 3.2, t.y + t.h / 2);
    const r = Math.min(11, Math.max(7, s * 1.6));
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = css.surface; ctx.fill();
    ctx.strokeStyle = css.muted; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = css.ink; ctx.font = '600 ' + Math.round(r * 1.05) + 'px system-ui, sans-serif';
    ctx.fillText(String(t.row), x, y + 0.5);
  }

  function drawBlock(t, s) {
    const [x, y] = toScreen(t.x, t.y);
    const w = Math.max(1, t.w * s - 1), h = Math.max(1, t.h * s);
    const done = store.tableProgress(t.id) / (PARC.cols * PARC.tiers);
    if (state.mode === 'inv') {
      ctx.fillStyle = invColor(t.inv);
      ctx.globalAlpha = 0.6 + 0.4 * done;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
    } else if (state.mode === 'clase') {
      const cls = Object.entries(tableClasses(t.id));
      ctx.fillStyle = css.empty; ctx.fillRect(x, y, w, h);
      let px = x;
      for (const [c, n] of cls.sort((a, b) => b[1] - a[1])) { const pw2 = w * n / (PARC.cols * PARC.tiers); ctx.fillStyle = classColor(c); ctx.fillRect(px, y, pw2, h); px += pw2; }
      if (cls.length > 1) { ctx.strokeStyle = '#ff2d55'; ctx.lineWidth = 3; ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3); }
    } else {
      ctx.fillStyle = css.empty; ctx.fillRect(x, y, w, h);
      if (done > 0) { ctx.fillStyle = css.ok; ctx.fillRect(x, y, w * done, h); }
    }
    if (h >= 11 && w >= 60) {
      ctx.fillStyle = state.mode !== 'progres' && done > 0.5 ? '#fff' : (done > 0.5 ? css.okInk : css.ink);
      ctx.font = '600 ' + Math.min(12, Math.round(h * 0.7)) + 'px system-ui, sans-serif';
      ctx.fillText(t.id, x + w / 2, y + h / 2 + 0.5);
    }
  }

  function drawPanels(t, s) {
    const pw = PW(t) * s, ph = PH(t) * s, gap = Math.min(2, pw * 0.08);
    const col = invColor(t.inv);
    const showText = pw >= 18;
    const [tx0, ty0] = toScreen(t.x, t.y);
    for (let tier = 0; tier < PARC.tiers; tier++) {
      for (let c = 0; c < PARC.cols; c++) {
        const x = tx0 + c * pw, y = ty0 + tier * ph;
        if (x > cw || x + pw < 0) continue;
        const sn = store.getSn(store.panelId(t.id, tier, c));
        const info = state.mode === 'clase' && sn ? lookup(sn) : null;
        if (state.mode === 'inv') {
          ctx.fillStyle = col; ctx.globalAlpha = sn ? 1 : 0.28;
          ctx.fillRect(x + gap / 2, y + gap / 2, pw - gap, ph - gap);
          ctx.globalAlpha = 1;
        } else if (state.mode === 'clase') {
          ctx.fillStyle = info ? classColor(info.cls) : sn ? '#555' : css.empty;
          ctx.fillRect(x + gap / 2, y + gap / 2, pw - gap, ph - gap);
          if (info && info.broken) { ctx.strokeStyle = '#ff2d55'; ctx.lineWidth = 2; ctx.strokeRect(x + gap, y + gap, pw - 2 * gap, ph - 2 * gap); }
        } else {
          ctx.fillStyle = sn ? css.ok : css.empty;
          ctx.fillRect(x + gap / 2, y + gap / 2, pw - gap, ph - gap);
        }
        if (!showText) continue;
        const ink = state.mode !== 'progres' ? (sn ? '#fff' : css.ink) : (sn ? css.okInk : css.muted);
        ctx.fillStyle = ink;
        if (info && ph >= 40) {                      // în modul „Clase” se scrie clasa, nu seria
          ctx.save(); ctx.translate(x + pw / 2, y + ph / 2); ctx.rotate(-Math.PI / 2);
          ctx.font = '700 ' + Math.min(14, Math.max(8, pw * 0.42)) + 'px system-ui, sans-serif';
          ctx.fillText(info.cls, 0, 0.5); ctx.restore();
        } else if (sn) {
          const size = Math.min(14, Math.max(8, pw * 0.42));
          const fits = Math.floor((ph - 8) / (size * 0.62));
          const text = sn.length > fits ? '…' + sn.slice(-(Math.max(3, fits - 1))) : sn;
          ctx.save();
          ctx.translate(x + pw / 2, y + ph / 2);
          ctx.rotate(-Math.PI / 2);
          ctx.font = '600 ' + size + 'px ui-monospace, Menlo, Consolas, monospace';
          ctx.fillText(text, 0, 0.5);
          ctx.restore();
        } else {
          ctx.font = Math.min(13, Math.max(8, pw * 0.4)) + 'px system-ui, sans-serif';
          ctx.fillText(String(c + 1), x + pw / 2, y + ph / 2);
        }
      }
    }
    const rowGap = 1.6 * s;
    if (rowGap >= 12) {
      ctx.fillStyle = css.ink; ctx.textAlign = 'left';
      ctx.font = '600 ' + Math.min(13, Math.round(rowGap * 0.7)) + 'px system-ui, sans-serif';
      const label = t.id + '  ·  INV' + String(t.inv).padStart(2, '0') + ' · string ' + t.str;
      const lw = ctx.measureText(label).width, right = tx0 + t.w * s - lw - 6;
      if (right >= tx0) ctx.fillText(label, Math.min(Math.max(tx0, 4), right), ty0 - rowGap / 2);
      ctx.textAlign = 'center';
    }
  }

  function equipBox(e) {
    const [x, y] = toScreen(e.x, e.y);
    if (e.w && e.h) {
      const w = Math.max(14, e.w * view.s), h = Math.max(10, e.h * view.s);
      return { x: x + (e.w * view.s - w) / 2, y: y + (e.h * view.s - h) / 2, w, h };
    }
    const r = e.type === 'stalp' ? 4 : 8;
    return { x: x - r, y: y - r, w: r * 2, h: r * 2 };
  }

  function drawEquip(e, s) {
    const b = equipBox(e);
    if (b.x > cw || b.x + b.w < 0 || b.y > ch || b.y + b.h < 0) return;
    const selected = state.selected && state.selected.kind === 'equip' && state.selected.id === e.id;
    let label = e.name;
    ctx.lineWidth = 1.5;
    if (e.type === 'inv') {
      ctx.fillStyle = e.n ? invColor(e.n) : css.ink;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      label = e.n ? 'INV' + String(e.n).padStart(2, '0') : e.name;
    } else if (e.type === 'ptab') {
      ctx.fillStyle = css.ink; ctx.fillRect(b.x, b.y, b.w, b.h);
    } else if (e.type === 'stalp') {
      if (s < 1.6) return;
      ctx.beginPath(); ctx.arc(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, 0, Math.PI * 2);
      ctx.fillStyle = css.surface; ctx.fill(); ctx.strokeStyle = css.muted; ctx.stroke();
      label = s >= 3 ? e.name.replace('Stâlp ', '') : '';
    } else {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = b.w / 2;
      ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
      ctx.fillStyle = e.type === 'baterie' ? '#1f8a70' : css.ink; ctx.fill();
    }
    if (selected) {
      ctx.strokeStyle = css.select; ctx.lineWidth = 3;
      ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    }
    if (label && (s >= 1.3 || e.type === 'ptab' || e.custom)) {
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      const w = ctx.measureText(label).width;
      const lx = e.type === 'ptab' ? b.x - w - 6 : b.x + b.w + 4, ly = b.y + b.h / 2;
      ctx.fillStyle = css.surface; ctx.globalAlpha = 0.85;
      ctx.fillRect(lx - 2, ly - 8, w + 4, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = css.ink; ctx.fillText(label, lx, ly + 0.5);
      ctx.textAlign = 'center';
    }
  }

  // ---- Ce se află sub deget ---------------------------------------------------
  function hit(px, py) {
    const [wx, wy] = toWorld(px, py);
    let best = null, bestD = Infinity;
    for (const e of store.listEquip()) {
      if (e.type === 'stalp' && view.s < 1.6) continue;
      const b = equipBox(e), pad = 10;
      if (px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad) {
        const d = Math.hypot(px - (b.x + b.w / 2), py - (b.y + b.h / 2));
        if (d < bestD) { bestD = d; best = e; }
      }
    }
    if (best) return { kind: 'equip', id: best.id, x: wx, y: wy };
    const padY = 6 / view.s;
    for (const t of PARC.tables) {
      if (wx >= t.x && wx <= t.x + t.w && wy >= t.y - padY && wy <= t.y + t.h + padY) {
        if (!panelsVisible()) return { kind: 'table', id: t.id, x: wx, y: wy };
        const col = Math.min(PARC.cols - 1, Math.max(0, Math.floor((wx - t.x) / PW(t))));
        const tier = wy < t.y + PH(t) ? 0 : 1;
        return { kind: 'panel', id: store.panelId(t.id, tier, col), tableId: t.id, x: wx, y: wy };
      }
    }
    return { kind: 'none', x: wx, y: wy };
  }

  // ---- Gesturi ----------------------------------------------------------------
  const pointers = new Map();
  let moved = 0, pinch = null, downAt = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 1) { moved = 0; downAt = Date.now(); }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      moved = 99;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
    p.x = e.offsetX; p.y = e.offsetY;
    if (pointers.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 6) { view.tx += dx; view.ty += dy; invalidate(); }
    } else if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.d > 0 && d > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
      pinch.d = d;
    }
  });
  const up = (e) => {
    const had = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (had && pointers.size === 0 && moved <= 6 && e.type === 'pointerup' && Date.now() - downAt < 700) {
      onTap(hit(e.offsetX, e.offsetY));
    }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); invalidate(); });
  new ResizeObserver(resize).observe(canvas);
  readTheme();
  resize();

  return {
    state, view, inset, invalidate, fit, centerOn, showPanel, showTable, panelsVisible, hit,
    zoom(factor) { const [cx, cy] = visibleCenter(); zoomAt(cx, cy, factor); },
    setInset(patch) { Object.assign(inset, patch); },
    panelScale() { return 26 / PW(PARC.tables[0]); },   // zoom la care se citesc seriile pe panouri
  };
}
