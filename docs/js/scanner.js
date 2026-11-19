// Cititorul de coduri de bare: camera telefonului + BarcodeDetector (nativ în Chrome pe Android).
// Pe lângă cititorul nativ există ZXing (docs/vendor), folosit când nativul lipsește sau nu găsește
// nimic: se aplică pe zona din chenar la rezoluția completă a camerei, ceea ce ajută la etichete mici.
const WANTED = ['code_128', 'code_39', 'code_93', 'codabar', 'itf', 'ean_13', 'ean_8',
  'upc_a', 'upc_e', 'qr_code', 'data_matrix', 'pdf417', 'aztec'];
const RETICLE = { w: 0.86, h: 0.44 };   // la fel ca în CSS (.reticle)
const CONFIRM_FRAMES = 2, CONFIRM_WINDOW = 700, HOLD_MS = 2500;

const ZX_FORMATS = ['code_128', 'code_39', 'code_93', 'itf', 'ean_13', 'qr_code', 'data_matrix'];
let zxPromise = null;
export function loadZxing() {
  if (zxPromise) return zxPromise;
  zxPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'vendor/barcode-detector.js';
    el.onload = () => {
      try {
        const api = window.BarcodeDetectionAPI;
        const wasm = new URL('vendor/zxing_reader.wasm', location.href).href;
        api.setZXingModuleOverrides({ locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasm : prefix + path) });
        resolve(new api.BarcodeDetector({ formats: ZX_FORMATS }));
      } catch (e) { reject(e); }
    };
    el.onerror = reject;
    document.head.append(el);
  }).catch(() => null);
  return zxPromise;
}

let audio = null;
export function beep(kind) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const tones = kind === 'ok' ? [[1250, 0, 0.09]] : kind === 'end' ? [[880, 0, 0.1], [660, 0.14, 0.18]] : [[330, 0, 0.16], [330, 0.22, 0.16]];
    for (const [freq, at, len] of tones) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.15;
      o.connect(g); g.connect(audio.destination);
      o.start(audio.currentTime + at); o.stop(audio.currentTime + at + len);
    }
  } catch (e) { /* fără sunet */ }
  try { if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : [90, 70, 90]); } catch (e) { /* fără vibrație */ }
}

export function createScanner(els, onCode) {
  const { video, overlay, viewer } = els;
  let detector = null, zx = null, stream = null, track = null, caps = {};
  let lastHit = 0, frame = 0, crop = null;
  const info = { engine: '', native: false, zxing: false, lastEngine: '' };
  let running = false, wakeLock = null;
  let pending = { code: null, n: 0, t: 0 }, held = { code: null, seen: 0 };

  const ready = (async () => {
    try {
      if ('BarcodeDetector' in window) {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = WANTED.filter((f) => supported.includes(f));
        if (formats.includes('code_128')) detector = new window.BarcodeDetector({ formats });
      }
    } catch (e) { detector = null; }
    info.native = !!detector;
    zx = await loadZxing();                          // al doilea cititor, mereu disponibil (și fără internet)
    info.zxing = !!zx;
    info.engine = detector && zx ? 'nativ + ZXing' : detector ? 'nativ' : zx ? 'ZXing' : '';
    return !!(detector || zx);
  })();

  // Zona din chenar, la rezoluția completă a camerei, desenată pe o pânză pentru ZXing.
  function cropReticle(g) {
    const sx = Math.max(0, Math.floor(g.rx0)), sy = Math.max(0, Math.floor(g.ry0));
    const sw = Math.min(video.videoWidth - sx, Math.ceil(g.rx1 - g.rx0)), sh = Math.min(video.videoHeight - sy, Math.ceil(g.ry1 - g.ry0));
    if (sw < 10 || sh < 10) return null;
    crop = crop || document.createElement('canvas');
    if (crop.width !== sw || crop.height !== sh) { crop.width = sw; crop.height = sh; }
    crop.getContext('2d', { willReadFrequently: true }).drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    return { canvas: crop, sx, sy };
  }
  const shift = (b, dx, dy) => ({ ...b, boundingBox: { x: b.boundingBox.x + dx, y: b.boundingBox.y + dy, width: b.boundingBox.width, height: b.boundingBox.height },
    cornerPoints: (b.cornerPoints || []).map((p) => ({ x: p.x + dx, y: p.y + dy })) });

  function geometry() {
    const cw = viewer.clientWidth, ch = viewer.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
    if (!cw || !ch || !vw || !vh) return null;
    const scale = Math.max(cw / vw, ch / vh);
    const visW = cw / scale, visH = ch / scale;
    const rw = visW * RETICLE.w, rh = visH * RETICLE.h;
    return { cw, ch, scale, offX: (vw - visW) / 2, offY: (vh - visH) / 2, cx: vw / 2, cy: vh / 2,
      rx0: vw / 2 - rw / 2, rx1: vw / 2 + rw / 2, ry0: vh / 2 - rh / 2, ry1: vh / 2 + rh / 2 };
  }

  function centerOf(b) {
    const pts = b.cornerPoints;
    if (pts && pts.length) return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    return { x: b.boundingBox.x + b.boundingBox.width / 2, y: b.boundingBox.y + b.boundingBox.height / 2 };
  }

  function draw(found, g, chosen) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(g.cw * dpr), H = Math.round(g.ch * dpr);
    if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.cw, g.ch);
    for (const b of found) {
      const r = b.boundingBox;
      const pts = (b.cornerPoints && b.cornerPoints.length) ? b.cornerPoints
        : [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = (p.x - g.offX) * g.scale, y = (p.y - g.offY) * g.scale;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.lineWidth = b === chosen ? 4 : 2;
      ctx.strokeStyle = b === chosen ? '#35e07a' : 'rgba(255,255,255,0.75)';
      ctx.stroke();
    }
  }

  function handle(found) {
    const g = geometry();
    if (!g) return;
    let chosen = null, best = Infinity;
    for (const b of found) {
      if (!b.rawValue) continue;
      const c = centerOf(b);
      if (c.x < g.rx0 || c.x > g.rx1 || c.y < g.ry0 || c.y > g.ry1) continue;
      const d = (c.x - g.cx) ** 2 + (c.y - g.cy) ** 2;
      if (d < best) { best = d; chosen = b; }
    }
    draw(found, g, chosen);
    if (!chosen) return;
    const now = performance.now(), code = chosen.rawValue.trim();
    if (code === held.code && now - held.seen < HOLD_MS) { held.seen = now; return; }
    if (code === pending.code && now - pending.t < CONFIRM_WINDOW) pending.n++;
    else pending = { code, n: 1, t: now };
    pending.t = now;
    if (pending.n >= CONFIRM_FRAMES) {
      held = { code, seen: now };
      pending = { code: null, n: 0, t: 0 };
      onCode(code, chosen.format);
    }
  }

  async function tick() {
    if (!running) return;
    if (video.readyState >= 2 && (detector || zx)) {
      let found = [];
      frame++;
      if (detector) { try { found = await detector.detect(video); if (found.length) info.lastEngine = 'nativ'; } catch (e) { /* cadru sărit */ } }
      // ZXing: când nu există cititor nativ, sau când nativul n-a găsit nimic de peste o secundă (din 2 în 2 cadre)
      const g = geometry();
      if (!found.length && zx && g && (!detector || (performance.now() - lastHit > 1000 && frame % 2 === 0))) {
        const c = cropReticle(g);
        if (c) { try { found = (await zx.detect(c.canvas)).map((b) => shift(b, c.sx, c.sy)); if (found.length) info.lastEngine = 'ZXing'; } catch (e) { /* cadru sărit */ } }
      }
      if (found.length) lastHit = performance.now();
      if (running) handle(found);
    }
    schedule();
  }
  function schedule() {
    if (!running) return;
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => tick());
    else setTimeout(tick, 60);
  }

  let gen = 0;                                      // o pornire depășită de o oprire se anulează
  async function start(deviceId) {
    stop();
    const my = gen;
    if (!(await ready)) return { ok: false, error: 'Browserul nu are cititor de coduri de bare. Folosește Chrome pe Android sau introdu codul manual.' };
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, error: 'Camera merge doar pe o adresă HTTPS.' };
    }
    const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: 'environment' } } });
    } catch (e) {
      if (deviceId) return start('');
      return { ok: false, error: e && e.name === 'NotAllowedError'
        ? 'Camera e blocată. Apasă pe lacătul din bara de adrese → Permisiuni → Cameră → Permite.'
        : 'Camera nu a pornit: ' + (e && e.message || e) };
    }
    if (my !== gen) { for (const t of stream.getTracks()) t.stop(); stream = null; return { ok: false, cancelled: true }; }
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* pornește la următorul gest */ }
    track = stream.getVideoTracks()[0];
    caps = (track.getCapabilities && track.getCapabilities()) || {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    running = true;
    pending = { code: null, n: 0, t: 0 }; held = { code: null, seen: 0 };
    schedule();
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* opțional */ }
    return { ok: true, torch: !!caps.torch, zoom: caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null };
  }

  function stop() {
    gen++;
    running = false;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null; track = null; caps = {};
    video.srcObject = null;
    const ctx = overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  // Codurile dintr-o poză (rezoluție completă): cele mai apropiate de centru primele.
  async function detectFile(file) {
    await ready;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { return []; }
    const all = [];
    for (const d of [detector, zx]) {
      if (!d) continue;
      try { for (const b of await d.detect(bmp)) if (b.rawValue) all.push(b); } catch (e) { /* încercăm celălalt */ }
    }
    const cx = bmp.width / 2, cy = bmp.height / 2;
    if (bmp.close) bmp.close();
    const seen = new Map();
    for (const b of all) {
      const c = centerOf(b), d = (c.x - cx) ** 2 + (c.y - cy) ** 2, v = b.rawValue.trim();
      if (!seen.has(v) || seen.get(v) > d) seen.set(v, d);
    }
    return [...seen].sort((a, b) => a[1] - b[1]).map(([v]) => v);
  }

  return {
    ready, start, stop, detectFile, info,
    get running() { return running; },
    release() { held = { code: null, seen: 0 }; },      // permite recitirea imediată a aceluiași cod
    async setTorch(on) { if (!track) return false; try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch (e) { return false; } },
    setZoom(z) { if (track) track.applyConstraints({ advanced: [{ zoom: Number(z) }] }).catch(() => {}); },
  };
}
