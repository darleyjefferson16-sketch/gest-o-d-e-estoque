const CACHE = 'estoque-v1';
const ASSETS = [
  'login.html',
  'dashboard.html',
  'estoque.html',
  'entrada.html',
  'saida.html',
  'requisicoes.html',
  'ferramentas.html',
  'historico.html',
  'usuarios.html',
  'desenvolvedor.html',
  'mapa-estoque.html',
  'css/style.css',
  'js/db.js',
  'js/auth.js',
  'js/utils.js',
  'js/app.js',
  'js/firebase-config.js',
  'manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname.includes('firebase') || url.hostname.includes('gstatic') ||
      url.hostname.includes('googleapis') || url.hostname.includes('cdnjs') ||
      url.hostname.includes('fonts')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
  );
});
