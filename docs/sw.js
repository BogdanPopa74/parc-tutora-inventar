// Service worker: ține aplicația în cache ca să pornească și fără semnal în parc.
const CACHE = 'parc-inventar-v3';
const FILES = ['./', 'index.html', 'app.css', 'parc-data.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'js/main.js', 'js/store.js', 'js/map.js', 'js/scanner.js', 'js/io.js', 'js/xlsx.js', 'test-scanner.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Cu semnal: ia versiunea nouă de pe rețea (și o pune în cache). Fără semnal sau cu rețea lentă: răspunde din cache.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; });
    try {
      return await Promise.race([net, new Promise((_, reject) => setTimeout(() => reject(new Error('lent')), 3000))]);
    } catch (err) {
      net.catch(() => {});
      return (await cache.match(e.request, { ignoreSearch: true })) || net;
    }
  })());
});
