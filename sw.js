// Офлайн-кэш оболочки приложения: сначала сеть (обновления приходят сразу), при её отсутствии — кэш.
const CACHE = 'avto-v4';
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'icons.js', 'core.js', 'sync.js', 'app.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest', 'vendor/swiper-bundle.min.js', 'vendor/swiper-bundle.min.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сначала сеть, но не дольше NET_TIMEOUT: при слабом/«ложном» интернете (значок сети есть, а данные не идут)
// браузер может ждать ответа минуту и дольше — тогда сразу отдаём сохранённую копию, а свежая версия
// докачивается в фоне и попадёт в кэш к следующему запуску.
const NET_TIMEOUT = 3000;
let slowUntil = 0; // сеть только что «висла» — следующие файлы сразу берём из кэша, не ждём снова

async function fromCache(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit || req.mode !== 'navigate') return hit;
  return (await c.match('./')) || c.match('index.html'); // любая страница приложения → главная
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
  e.waitUntil(network.catch(() => {})); // даём фоновой загрузке завершиться и обновить кэш

  e.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const useCache = () => fromCache(req).then((hit) => {
      if (hit) finish(hit);
      else network.then(finish, () => finish(Response.error()));
    });
    const wait = Date.now() < slowUntil ? 0 : NET_TIMEOUT;
    const timer = setTimeout(() => { slowUntil = Date.now() + 30000; useCache(); }, wait);
    network.then((res) => { clearTimeout(timer); slowUntil = 0; finish(res); }, () => { clearTimeout(timer); useCache(); });
  }));
});

// Нажатие на уведомление-напоминание открывает приложение (или переключает на уже открытое окно).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === location.origin);
      return open ? open.focus() : self.clients.openWindow('./');
    })
  );
});
