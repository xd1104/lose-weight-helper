/* 減重助手 service worker
 * - App shell：cache-first
 * - 讀取類 /api（GET）：network-first、失敗退 cache（離線仍看得到上次載入的紀錄）
 * - 寫入類 /api：network-only，失敗回明確的離線 JSON
 * - 跨網域（Anthropic API / GitHub API / raw）一律放行不攔
 * 鐵律：skipWaiting + activate 清舊快取 + clients.claim，已安裝的 PWA 才吃得到新版
 * 改前端記得把 cache 版本號 +1
 */
const SHELL_CACHE = 'lwh-shell-v1';
const DATA_CACHE = 'lwh-data-v1';
const KEEP = [SHELL_CACHE, DATA_CACHE];

// 相對於 SW scope 解析（localhost 根目錄或 Pages 子路徑 /lose-weight-helper/ 都對）
const BASE = new URL('./', self.location).pathname;
const SHELL = [
  BASE,
  BASE + 'index.html',
  BASE + 'styles.css',
  BASE + 'store.js',
  BASE + 'ai.js',
  BASE + 'app.js',
  BASE + 'manifest.json',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'icons/icon-maskable-512.png',
  BASE + 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function offlineJson() {
  return new Response(JSON.stringify({ ok: false, code: 'offline', message: '目前離線或連不到減重助手伺服器。' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy));
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineJson();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Anthropic / GitHub 等跨網域直接放行

  if (url.pathname.includes('/api/')) {
    // 讀取：network-first（不能 cache-first，會服務到舊資料）
    if (req.method === 'GET') {
      e.respondWith(networkFirst(req, DATA_CACHE));
      return;
    }
    // 寫入：network-only
    e.respondWith(fetch(req).catch(() => offlineJson()));
    return;
  }

  // App shell：cache-first，退 network，再退 index.html
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req)
        .then((res) => {
          if (res.ok && req.method === 'GET') {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(BASE + 'index.html'))
    )
  );
});
