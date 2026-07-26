'use strict';
/* 手機版（GitHub Contents API）的寫入行為。
 * 這支是 2026-07-26「一整餐 6 筆沒存上去」那次事故的回歸測試：
 *   A. 一次記 6 筆只寫 2 個檔案，不是 7 次寫入
 *   B. 手機版寫入完全序列化（同一時間只有一個 PUT 在飛）
 *   C. 409 會退避重試並自己成功，使用者看不到錯誤
 *   D. 一直 409 -> 出現「還沒同步」橫幅（不會假裝已存好），恢復後重送，資料不掉
 *
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, clearAll } = require('./_setup');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

(async () => {
  await clearAll();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  /* ---- 有狀態的假 GitHub ---- */
  const files = new Map();
  let shaN = 0;
  const puts = [];              // 每次 PUT 的 path
  let inFlight = 0, maxInFlight = 0;
  let force409 = 0;             // 接下來幾次 PUT 一律回 409（模擬分支被別的 commit 佔住）

  await p.route('https://api.github.com/repos/xd1104/lose-weight-helper/contents/**', async (route) => {
    const req = route.request();
    const path = decodeURIComponent(new URL(req.url()).pathname.split('/contents/')[1]);
    const H = { 'access-control-allow-origin': '*' };
    const method = req.method();

    if (method === 'GET') {
      if (!files.has(path)) {
        return route.fulfill({ status: 404, contentType: 'application/json', headers: H, body: '{"message":"Not Found"}' });
      }
      const f = files.get(path);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: H,
        body: JSON.stringify({ sha: f.sha, content: f.content }) });
    }

    if (method === 'PUT') {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      puts.push(path);
      await new Promise((r) => setTimeout(r, 120));   // 給併發一點機會露出來
      const body = JSON.parse(req.postData());
      const done = (res) => { inFlight--; return res; };

      if (force409 > 0) {
        force409--;
        return done(route.fulfill({ status: 409, contentType: 'application/json', headers: H,
          body: '{"message":"is at abc but expected def"}' }));
      }
      const exists = files.has(path);
      if (exists && body.sha !== files.get(path).sha) {
        return done(route.fulfill({ status: 409, contentType: 'application/json', headers: H,
          body: '{"message":"stale sha"}' }));
      }
      const ns = 'sha' + (++shaN);
      files.set(path, { content: body.content, sha: ns });
      return done(route.fulfill({ status: 200, contentType: 'application/json', headers: H,
        body: JSON.stringify({ content: { sha: ns } }) }));
    }
    return route.fulfill({ status: 405, headers: H, body: '' });
  });
  await p.route('https://raw.githubusercontent.com/**', (r) =>
    r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'nf' }));

  /* AI 回 6 筆，複製 2026-07-26 那一餐的形狀 */
  const SIX = ['白飯', '叉燒肉（去皮）', '油雞腿肉（去皮）', '燒鴨肉（去皮）', '燙青菜', '蔥薑醬料'];
  await p.route('https://api.anthropic.com/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({
        items: SIX.map((n, i) => ({ name: n, portion: '一份', kcal: 100 + i * 10, protein: 5, carbs: 10, fat: 3, confidence: 'medium' })),
      }) }],
      usage: { input_tokens: 300, output_tokens: 120 },
    }),
  }));

  await p.goto(BASE + '/?store=github', { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    localStorage.setItem('lwh_gh_pat', 'github_pat_fake');
    localStorage.setItem('lwh_anthropic_key', 'sk-ant-test');
    localStorage.removeItem('lwh_user');
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);

  await p.click('[data-act="new-user"]');
  await p.waitForTimeout(400);
  await p.fill('#u-name', 'Benson');
  await p.click('#f-user button[type="submit"]');
  await p.waitForTimeout(1800);
  await p.fill('#s-weight', '80');
  await p.dispatchEvent('#s-weight', 'change');
  await p.click('#f-setup button[type="submit"]');
  await p.waitForTimeout(1800);
  const uid = [...files.keys()].map((k) => (k.match(/^data\/users\/([^/]+)\//) || [])[1]).filter(Boolean)[0];

  const addSix = async () => {
    await p.click('.fab');
    await p.waitForTimeout(400);
    await p.click('[data-tab="text"]');
    await p.waitForTimeout(300);
    await p.fill('#i-text', '燒臘便當');
    await p.click('#f-text button[type="submit"]');
    await p.waitForTimeout(1500);
    await p.click('[data-ai="save"]');
    await p.waitForTimeout(3500);
  };

  console.log('\n[A] 一次記 6 筆 → 只寫 2 個檔案（以前是 7 次寫入，自己撞自己）');
  puts.length = 0; maxInFlight = 0; inFlight = 0;
  await addSix();
  const foodPuts = puts.filter((x) => /foods\.md$/.test(x)).length;
  const dayPuts = puts.filter((x) => /days\/.+\.md$/.test(x)).length;
  check('常吃清單只寫 1 次（以前 6 次）', foodPuts === 1, { foodPuts, puts });
  check('當天紀錄只寫 1 次', dayPuts === 1, { dayPuts, puts });
  check('總共只有 2 次寫入', puts.length === 2, puts);

  console.log('\n[B] 手機版寫入完全序列化（同時只有一個 PUT 在飛）');
  check('沒有任何兩個寫入同時進行 ← 這就是 409 的根因', maxInFlight === 1, maxInFlight);

  console.log('\n[C] 遇到 409 會自己退避重試，使用者看不到錯誤');
  force409 = 2;                       // 前兩次 PUT 一律 409，第三次才放行
  puts.length = 0;
  await p.click('[data-act="edit-weight"]');
  await p.waitForTimeout(400);
  await p.fill('#w-val', '79.5');
  await p.click('#f-weigh button[type="submit"]');
  await p.waitForTimeout(4000);
  check('確實重試了（同一個檔案送了 3 次）', puts.length >= 3, puts);
  check('沒有跳出「還沒同步」橫幅', await p.$eval('#sync-bar', (e) => e.hidden), await p.textContent('#sync-bar'));
  const dayPath = [...files.keys()].find((k) => /\/days\/\d{4}-\d{2}-\d{2}\.md$/.test(k));
  check('體重真的寫進去了', /"weight": 79.5|weight: 79.5/.test(unb64(files.get(dayPath).content)),
    unb64(files.get(dayPath).content).split('\n').filter((l) => /weight/.test(l)));

  console.log('\n[D] 一直失敗 → 明白告訴使用者「還沒同步」，不會假裝存好了');
  force409 = 99;                      // 重試也救不回來
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(300);
  await p.fill('#m-name', '宵夜滷味');
  await p.fill('#m-kcal', '450');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(6000);

  check('畫面上出現「還沒同步」橫幅', !(await p.$eval('#sync-bar', (e) => e.hidden)));
  const barTxt = (await p.textContent('#sync-bar')) || '';
  check('橫幅說得出是哪一份沒同步', /紀錄|常吃清單/.test(barTxt), barTxt);
  check('橫幅有「立即重試」', !!(await p.$('#sync-retry')));
  check('橫幅沒有蓋住頁首', await p.evaluate(() => document.body.classList.contains('has-sync')));
  check('雲端上確實還沒有這筆（所以才要提醒）', !/宵夜滷味/.test(unb64(files.get(dayPath).content)));
  await p.screenshot({ path: '/tmp/sync-bar.png' });

  console.log('\n[D2] 恢復連線後按「立即重試」→ 資料補上去、橫幅消失');
  force409 = 0;
  await p.click('#sync-retry');
  await p.waitForTimeout(3000);
  check('橫幅消失', await p.$eval('#sync-bar', (e) => e.hidden), await p.textContent('#sync-bar'));
  check('宵夜滷味補寫進雲端 ← 資料沒有掉', /宵夜滷味/.test(unb64(files.get(dayPath).content)),
    unb64(files.get(dayPath).content).slice(-200));
  check('六筆午餐也還在', SIX.every((n) => unb64(files.get(dayPath).content).indexOf(n) >= 0));

  console.log('\n[D3] 回到前景也會自動重送（不用使用者自己按）');
  force409 = 99;
  await p.click('[data-act="edit-weight"]');
  await p.waitForTimeout(400);
  await p.fill('#w-val', '79.1');
  await p.click('#f-weigh button[type="submit"]');
  await p.waitForTimeout(5000);
  check('又出現橫幅', !(await p.$eval('#sync-bar', (e) => e.hidden)));
  force409 = 0;
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(3000);
  check('切回前景就自動補寫，橫幅消失', await p.$eval('#sync-bar', (e) => e.hidden), await p.textContent('#sync-bar'));
  check('79.1 有寫進去', /79.1/.test(unb64(files.get(dayPath).content)));

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log('uid:', uid, '/ 檔案:', [...files.keys()]);
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
