/* Service worker: хранит приложение и тексты на устройстве, чтобы всё работало без сети. */
const VERSION = '2d9235ddf2';
const SHELL = 'npa-shell-' + VERSION;
const TEXTS = 'npa-texts';
const ASSETS = ["./", "index.html", "app.css", "app.js", "match.js", "search-worker.js", "manifest.webmanifest", "data/catalog.json", "icons/icon.svg", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png"];
const CATALOG = new URL('data/catalog.json', self.registration.scope).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('npa-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Перечень: сначала сеть (чтобы видеть обновления), без сети — копия.
  if (url.pathname.endsWith('/data/catalog.json')) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req, { cache: 'no-cache' });
        if (r.ok) (await caches.open(SHELL)).put(CATALOG, r.clone());
        return r;
      } catch (err) {
        return (await caches.match(CATALOG)) || Response.error();
      }
    })());
    return;
  }

  // Тексты документов: из кэша, иначе из сети с сохранением.
  if (url.pathname.includes('/data/texts/')) {
    e.respondWith((async () => {
      const c = await caches.open(TEXTS);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    })());
    return;
  }

  // Оболочка приложения: из кэша, иначе сеть. Навигация всегда получает index.html.
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') return (await caches.match('./')) || (await caches.match('index.html'));
      throw err;
    }
  })());
});
