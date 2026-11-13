// Cititorul de coduri de bare: camera telefonului + BarcodeDetector (nativ în Chrome pe Android).
const WANTED = ['code_128', 'code_39', 'code_93', 'codabar', 'itf', 'ean_13', 'ean_8',
  'upc_a', 'upc_e', 'qr_code', 'data_matrix', 'pdf417', 'aztec'];
const RETICLE = { w: 0.86, h: 0.44 };   // la fel ca în CSS (.reticle)
const CONFIRM_FRAMES = 2, CONFIRM_WINDOW = 700, HOLD_MS = 2500;

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
  let detector = null, stream = null, track = null, caps = {};
  let running = false, wakeLock = null;
  let pending = { code: null, n: 0, t: 0 }, held = { code: null, seen: 0 };

  const ready = (async () => {
    try {
      if ('BarcodeDetector' in window) {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = WANTED.filter((f) => supported.includes(f));
        if (formats.length) detector = new window.BarcodeDetector({ formats });
      }
    } catch (e) { detector = null; }
    return !!detector;
  })();

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
    if (video.readyState >= 2 && detector) {
      let found = [];
      try { found = await detector.detect(video); } catch (e) { /* cadru sărit */ }
      if (running) handle(found);
    }
    schedule();
  }
  function schedule() {
    if (!running) return;
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => tick());
    else setTimeout(tick, 60);
  }

  async function start(deviceId) {
    stop();
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
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* pornește la următorul gest */ }
    track = stream.getVideoTracks()[0];
    caps = (track.getCapabilities && track.getCapabilities()) || {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    running = true;
    pending = { code: null, n: 0, t: 0 };
    schedule();
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* opțional */ }
    return { ok: true, torch: !!caps.torch, zoom: caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null };
  }

  function stop() {
    running = false;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null; track = null; caps = {};
    video.srcObject = null;
    const ctx = overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  return {
    ready, start, stop,
    get running() { return running; },
    release() { held = { code: null, seen: 0 }; },      // permite recitirea imediată a aceluiași cod
    async setTorch(on) { if (!track) return false; try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch (e) { return false; } },
    setZoom(z) { if (track) track.applyConstraints({ advanced: [{ zoom: Number(z) }] }).catch(() => {}); },
  };
}
