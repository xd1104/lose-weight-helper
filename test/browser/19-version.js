'use strict';
/* 「我怎麼知道現在開起來的是不是最新版？」
 * PWA 的殼是 cache-first，手機上跑的那份不會自己變新，使用者完全看不到這件事。
 *   A. 設定裡看得到現在跑的版本號
 *   B. 可以主動檢查；沒有新版就明講「已經是最新版」
 *   C. 真的有新版時偵測得到（改掉 sw.js 再 update()，這是真的端對端）
 *   D. 偵測到之後：設定索引標出來、sheet 換成「立即更新」
 *
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 * ⚠️ 會暫時改寫 public/sw.js，結束時一定會還原（finally）。
 */
const { chromium } = require('playwright');
const { BASE, seedUser, openSet } = require('./_setup');
const fs = require('fs');
const path = require('path');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const txt = async (p, sel) => (await p.textContent(sel).catch(() => '')) || '';

const SW = path.join(__dirname, '..', '..', 'public', 'sw.js');
const ORIGINAL = fs.readFileSync(SW, 'utf8');

(async () => {
  const u = await seedUser();
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errs = [];
  try {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1500);

    /* service worker 要先真的接管，之後的更新才有「舊的那一份」可以比 */
    await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 })
      .catch(() => {});
    check('service worker 已經接管這一頁', await p.evaluate(() => !!navigator.serviceWorker.controller));
    const ver = await p.evaluate(() => APP_VER);

    console.log('\n[A] 設定裡看得到現在跑的版本');
    await p.click('[data-nav="settings"]');
    await p.waitForTimeout(600);
    const row = await txt(p, '[data-sec="ver"]');
    check('有「版本」這一列', /版本/.test(row), row);
    check('列上就寫著版本號 v' + ver, row.indexOf('v' + ver) >= 0, row);
    check('底下那行版本字跟常數同一個來源',
      (await txt(p, '#app')).indexOf('減重助手 v' + ver) >= 0);

    console.log('\n[B] 沒有新版時要明講「已經是最新版」');
    await openSet(p, 'ver');
    check('sheet 裡寫出現在跑的版本', new RegExp('v' + ver).test(await txt(p, '.sheet')), await txt(p, '.sheet'));
    check('有「檢查有沒有新版本」', !!(await p.$('[data-ver="check"]')));
    check('還沒檢查時不該出現「立即更新」', !(await p.$('[data-ver="reload"]')));
    await p.click('[data-ver="check"]');
    await p.waitForTimeout(2600);
    check('回報已經是最新版', /已經是最新版/.test(await txt(p, '#ver-state')), await txt(p, '#ver-state'));
    check('沒有假警報（沒冒出立即更新）', !(await p.$('[data-ver="reload"]')));

    console.log('\n[C] 真的有新版：改掉 sw.js 再檢查一次');
    fs.writeFileSync(SW, ORIGINAL.replace(/lwh-shell-v(\d+)/, (m, n) => 'lwh-shell-v' + (+n + 1))
                                 .replace(/lwh-data-v(\d+)/, (m, n) => 'lwh-data-v' + (+n + 1)), 'utf8');
    await p.evaluate(() => closeAllSheets());
    await p.waitForTimeout(300);
    await openSet(p, 'ver');
    await p.click('[data-ver="check"]');
    await p.waitForTimeout(3500);
    check('偵測到新版本', await p.evaluate(() => updateReady === true),
      await p.evaluate(() => updateReady));
    check('換成「立即更新」', !!(await p.$('[data-ver="reload"]')));
    check('講清楚要重新載入才會換過去', /重新載入/.test(await txt(p, '#ver-state')), await txt(p, '#ver-state'));
    check('順便安撫：記到一半的不會不見', /不會不見/.test(await txt(p, '#ver-state')));

    console.log('\n[D] 設定索引也要標出來（不然他不會知道要進去看）');
    await p.evaluate(() => closeAllSheets());
    await p.waitForTimeout(500);
    const row2 = await txt(p, '[data-sec="ver"]');
    check('索引那一列改口成「有新版本」', /有新版本/.test(row2), row2);
    check('而且掛上黃色提醒點', !!(await p.$('[data-sec="ver"] .wdot.amber')));
    await p.screenshot({ path: '/tmp/ver.png', clip: { x: 0, y: 300, width: 390, height: 544 } });

    console.log('\npageerrors:', errs.length ? errs : 'none');
  } finally {
    fs.writeFileSync(SW, ORIGINAL, 'utf8');
    check('sw.js 已經還原', fs.readFileSync(SW, 'utf8') === ORIGINAL);
    await b.close();
  }
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  process.exit(fail.length ? 1 : 0);
})();
