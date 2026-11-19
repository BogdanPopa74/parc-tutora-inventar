// Service worker: ține aplicația în cache ca să pornească și fără semnal în parc.
// La fiecare modificare a aplicației se schimbă VERSION: browserul vede fișierul diferit, descarcă
// toate fișierele noi într-un cache separat și abia apoi le folosește, deci nu amestecă versiuni.
const VERSION = '2026-11-20.1';
const CACHE = 'parc-inventar-' + VERSION;
const FILES = ['./', 'index.html', 'app.css', 'parc-data.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'js/main.js', 'js/store.js', 'js/map.js', 'js/scanner.js', 'js/io.js', 'js/xlsx.js', 'js/sync.js', 'js/dataview.js', 'js/paleti.js', 'paleti-data.js', 'test-scanner.html', 'vendor/barcode-detector.js', 'vendor/zxing_reader.wasm'];

self.addEventListener('install', (e) => {
  // „reload” ocolește cache-ul HTTP al browserului, ca să nu salvăm copii vechi sub versiunea nouă
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('parc-inventar-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Fișierele aplicației vin mereu din cache-ul versiunii curente; rețeaua e folosită doar pentru ce lipsește.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(e.request, { ignoreSearch: true })) || fetch(e.request)));
});
