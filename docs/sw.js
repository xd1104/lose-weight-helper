/* 減重助手 service worker
 * - App shell：cache-first
 * - 讀取類 /api（GET）：network-first、失敗退 cache（離線仍看得到上次載入的紀錄）
 * - 寫入類 /api：network-only，失敗回明確的離線 JSON
 * - 跨網域（Anthropic API / GitHub API / raw）一律放行不攔
 * 鐵律：skipWaiting + activate 清舊快取 + clients.claim，已安裝的 PWA 才吃得到新版
 * 改前端記得把 cache 版本號 +1
 */
const SHELL_CACHE = 'lwh-shell-v48';
const DATA_CACHE = 'lwh-data-v48';
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

/* ---- 每日提醒 ----
 * 推播由 GitHub Actions 排程送出（.github/workflows/daily-reminder.yml）。
 * v5.2 起送的是「有內容」的推播（文字在 e.data 裡）。原本送無內容的，
 * Apple 回 201 收下了、手機卻不顯示——payload-less 在 iOS 上是唯一沒把握的環節。
 * 下面的預設文字保留：舊訂閱沒存加密金鑰時，送出端仍會退回無內容送法。
 * ⚠️ userVisibleOnly:true 是 iOS 的硬性要求 —— 收到 push 一定要跳一則通知出來，
 * 靜靜吃掉的話瀏覽器會直接把訂閱撤銷。所以這裡不做任何「要不要顯示」的判斷，
 * 「今天已經量過就不要吵」是在送出端決定的（Actions 會先看當天的紀錄）。 */
self.addEventListener('push', (e) => {
  let title = '早安 ☀️ 量個體重吧';
  let body = '30 秒的事。順便把昨天沒記的補一補。';
  if (e.data) {
    try {
      const d = e.data.json();
      if (d && d.title) title = d.title;
      if (d && d.body) body = d.body;
    } catch { /* 沒內容或不是 JSON：用預設文字 */ }
  }
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: BASE + 'icons/icon-192.png',
    badge: BASE + 'icons/icon-192.png',
    tag: 'lwh-daily',      // 同一個 tag：沒點掉的舊提醒會被新的取代，不會疊一整排
    renotify: true,
    data: { url: BASE },
  }));
});

/* 點通知：已經開著就切過去，沒開才開新的（不然會開出第二個實例） */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.indexOf(BASE) >= 0 && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(BASE) : undefined;
    })
  );
});

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
