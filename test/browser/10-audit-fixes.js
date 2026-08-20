'use strict';
/* 2026-07 稽核修正的回歸測試（每一項都會在「沒修」的版本上失敗）
 *   A. 讀取失敗不再留下空白的一天（原本會永遠不重試，還會把雲端紀錄蓋成空的）
 *   B. 歷史頁「載入的天數」與「畫出來的天數」是同一個窗口（原本載 30、畫 60）
 *   C. 當天剛記的第一筆會馬上出現在歷史頁（原本要重開 app 才看得到）
 *   D. 模型選 Haiku 4.5 時不送 output_config.effort（原本每次都白打一次才降級）
 *   E. 常吃清單可以刪單筆（原本只能整份清空）
 *
 * ⚠️ 這支會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），
 *    跑之前請先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, seedUser, openSet, openMeals } = require('./_setup');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const dk = (off) => {
  const d = new Date(); d.setDate(d.getDate() + (off || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const postDay = (u, date, kcal) => fetch(BASE + '/api/days', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ u, date, entries: [{ id: 'e-' + date, name: '測試餐', kcal, meal: 'lunch' }] }),
});
const getFoods = (u) => fetch(BASE + '/api/core?u=' + encodeURIComponent(u)).then((r) => r.json()).then((j) => j.foods || []);

async function open(browser, uid) {
  /* serviceWorkers:'block'：SW 接手後 fetch 不會經過 page.route，
   * 這支測試要靠攔截請求製造「讀取失敗」，所以必須把 SW 擋掉 */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => { localStorage.setItem('lwh_user', id); }, uid);
  p.__errs = errs;
  return p;
}
/* 加一筆手動紀錄 */
async function addManual(p, name, kcal) {
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(300);
  await p.fill('#m-name', name);
  await p.fill('#m-kcal', String(kcal));
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1400);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  /* ───────── A. 讀取失敗的那一天，之後還能重試 ───────── */
  console.log('\n[A] 讀取紀錄失敗後，那一天不會被當成「空白的一天」卡住');
  {
    const u = await seedUser();
    const old = dk(-40);
    await postDay(u, old, 700);

    const p = await open(browser, u);
    /* 只擋「歷史頁批次載入」那一次（開 app 時只載最近 7 天，不含這一天），之後放行 */
    let blocked = 0;
    await p.route('**/api/days?**', (r) => {
      const url = decodeURIComponent(r.request().url());
      if (blocked === 0 && url.indexOf(old) >= 0) { blocked++; return r.abort('failed'); }
      return r.continue();
    });
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);

    await p.click('[data-nav="history"]');
    await p.waitForTimeout(1500);
    const row = await p.$('[data-act="open-day"][data-date="' + old + '"]');
    check('讀失敗時歷史頁仍列出那一天', !!row);
    check('讀失敗時顯示「—」而不是 0（0 會被誤讀成那天沒吃）',
      /—/.test(await p.textContent('[data-date="' + old + '"] .v')));

    /* 關鍵：再次進入那一天要「真的重讀」，而不是拿空殼直接顯示 */
    await row.click();
    await p.waitForTimeout(1600);
    const eaten = (await p.textContent('.eatcard .eatnow')).trim();
    check('重新進入那一天會重讀，抓回真正的 700 大卡 ← 沒修的話會停在 0', eaten === '700', eaten);

    /* 那天的檔案不能被空白覆蓋掉 */
    const onDisk = await fetch(BASE + '/api/days?u=' + u + '&dates=' + old).then((r) => r.json());
    check('伺服器上的紀錄沒有被空白蓋掉', (onDisk.days[0].entries || []).length === 1, onDisk.days[0]);
    check('沒有 pageerror', p.__errs.length === 0, p.__errs);
    await p.context().close();
  }

  /* ───────── B. 歷史頁載入窗口 = 繪製窗口 ───────── */
  console.log('\n[B] 歷史頁列出來的每一天都有內容（不會列 60 天卻只載 30 天）');
  {
    const u = await seedUser();
    /* index 要超過 30 筆，才會踩到原本 slice(-30) 的截斷 */
    for (let i = 1; i <= 40; i++) await postDay(u, dk(-i), 500 + i);
    await postDay(u, dk(-55), 999);

    const p = await open(browser, u);
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    await p.click('[data-nav="history"]');
    await p.waitForTimeout(3000);

    const d40 = (await p.textContent('[data-date="' + dk(-40) + '"] .v') || '').trim();
    const d55 = (await p.textContent('[data-date="' + dk(-55) + '"] .v') || '').trim();
    check('第 40 天有數字（原本第 31 天以後永遠是「—」）', /540/.test(d40), d40);
    check('第 55 天有數字（窗口內就要載到）', /999/.test(d55), d55);

    const dashes = await p.$$eval('.hrow .v.none', (e) => e.length);
    check('列出來的日子沒有任何一天是空的', dashes === 0, dashes);
    check('沒有 pageerror', p.__errs.length === 0, p.__errs);
    await p.context().close();
  }

  /* ───────── C. 當天新記的紀錄馬上進歷史 ───────── */
  console.log('\n[C] 今天剛記的第一筆，同一次使用中就會出現在歷史頁');
  {
    const u = await seedUser();
    const p = await open(browser, u);
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);

    /* 先進歷史一次（把 histLoaded 鎖起來，這正是原本的 bug 條件） */
    await p.click('[data-nav="history"]');
    await p.waitForTimeout(1500);
    check('一開始歷史頁是空的', /還沒有任何紀錄/.test(await p.textContent('.card .desc').catch(() => '')));

    await p.click('[data-nav="today"]');
    await p.waitForTimeout(500);
    await addManual(p, '滷肉飯', 480);

    await p.click('[data-nav="history"]');
    await p.waitForTimeout(1200);
    const today = await p.$('[data-date="' + dk(0) + '"]');
    check('今天出現在歷史清單 ← 沒修的話要重開 app 才看得到', !!today);
    check('數字是剛記的 480', /480/.test((await p.textContent('[data-date="' + dk(0) + '"] .v')) || ''));

    /* 反向：整天清空後要從清單消失 */
    await p.click('[data-nav="today"]');
    await p.waitForTimeout(600);
    await openMeals(p);
    await p.click('.row[data-act="edit-entry"]');
    await p.waitForTimeout(500);
    p.once('dialog', (d) => d.accept());
    await p.click('[data-del]');
    await p.waitForTimeout(1500);
    await p.click('[data-nav="history"]');
    await p.waitForTimeout(1000);
    check('清空後那天從歷史消失（不留一列「—」）', !(await p.$('[data-date="' + dk(0) + '"]')));
    check('沒有 pageerror', p.__errs.length === 0, p.__errs);
    await p.context().close();
  }

  /* ───────── D. Haiku 4.5 不送 effort ───────── */
  console.log('\n[D] 模型選 Haiku 4.5 時不送 output_config.effort（送了會 400，白打一次）');
  {
    const u = await seedUser();
    const p = await open(browser, u);
    const sent = [];
    await p.route('https://api.anthropic.com/**', (r) => {
      sent.push(JSON.parse(r.request().postData()));
      return r.fulfill({
        status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ items: [{ name: '炒飯', portion: '一盤', kcal: 700, protein: 20, carbs: 95, fat: 22, confidence: 'medium' }] }) }],
          usage: { input_tokens: 300, output_tokens: 80 },
        }),
      });
    });
    await p.addInitScript(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);

    await openSet(p, 'ai');
    await p.click('[data-set="model"][data-val="claude-haiku-4-5"]');
    await p.waitForTimeout(1200);
    await p.click('[data-sheet="close"]');
    await p.waitForTimeout(400);
    await p.click('[data-nav="today"]');
    await p.waitForTimeout(500);

    await p.click('.fab');
    await p.waitForTimeout(400);
    await p.click('[data-tab="text"]');
    await p.waitForTimeout(300);
    await p.fill('#i-text', '炒飯加飯');
    await p.click('#f-text button[type="submit"]');
    await p.waitForTimeout(1500);

    check('只打了一次請求（沒有先被 400 再降級）', sent.length === 1, sent.length);
    const h = sent[0] || {};
    check('模型確實是 haiku', h.model === 'claude-haiku-4-5', h.model);
    check('沒有帶 effort ← 這就是修正的重點', !(h.output_config && h.output_config.effort), h.output_config);
    check('structured outputs 還是有用（只是拿掉 effort）', !!(h.output_config && h.output_config.format));

    /* 換回 Sonnet：effort 要回來，別誤把兩邊都拔掉 */
    await p.click('[data-ai="cancel"], [data-sheet="close"]').catch(() => {});
    await p.waitForTimeout(400);
    await openSet(p, 'ai');
    await p.click('[data-set="model"][data-val="claude-sonnet-5"]');
    await p.waitForTimeout(1200);
    await p.click('[data-sheet="close"]');
    await p.waitForTimeout(400);
    await p.click('[data-nav="today"]');
    await p.waitForTimeout(500);
    await p.click('.fab');
    await p.waitForTimeout(400);
    await p.click('[data-tab="text"]');
    await p.waitForTimeout(300);
    await p.fill('#i-text', '炒飯加飯');
    await p.click('#f-text button[type="submit"]');
    await p.waitForTimeout(1500);
    const s = sent[1] || {};
      /* 食物估算刻意用 medium：low 太容易「隨手抓一個看起來合理的數字」，
       同一張照片兩次就落在不同的地方（Benson 反映的問題）。 */
    check('Sonnet 仍然帶 effort（食物估算是 medium）',
      s.output_config && s.output_config.effort === 'medium', s.output_config);
    check('沒有 pageerror', p.__errs.length === 0, p.__errs);
    await p.context().close();
  }

  /* ───────── E. 常吃清單刪單筆 ───────── */
  console.log('\n[E] 常吃清單可以刪掉單一項目（AI 有時會生出「甜椒配料 3 大卡」這種垃圾）');
  {
    const u = await seedUser();
    const p = await open(browser, u);
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    await addManual(p, '滷肉飯', 480);
    await addManual(p, '甜椒配料', 3);

    await p.click('.fab');
    await p.waitForTimeout(400);
    await p.click('[data-tab="fav"]');
    await p.waitForTimeout(400);
    check('兩筆都在常吃清單', (await p.$$('[data-fav]')).length === 2);
    /* v3.4 起刪除收進「編輯」裡（一列不塞兩顆破壞性按鈕），入口變成 ✎ */
    check('每一筆都有編輯鈕', (await p.$$('[data-fav-edit]')).length === 2);

    const box = await p.$eval('[data-fav-edit]', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    check('編輯鈕觸控目標 ≥ 44px', box.w >= 44 && box.h >= 44, box);

    /* 誤觸保護：取消就不能刪 */
    await (await p.$('[data-fav-edit][aria-label*="甜椒"]')).click();
    await p.waitForTimeout(600);
    p.once('dialog', (d) => d.dismiss());
    await p.click('[data-fd-del]');
    await p.waitForTimeout(800);
    check('取消確認時不會刪掉', !!(await p.$('[data-fd-del]')));

    p.once('dialog', (d) => d.accept());
    await p.click('[data-fd-del]');
    await p.waitForTimeout(1500);
    check('確認後從畫面移除', (await p.$$('[data-fav]')).length === 1);
    const names = await p.$$eval('.food-row b', (e) => e.map((x) => x.textContent.trim()));
    check('留下來的是滷肉飯', /滷肉飯/.test(names[0] || ''), names);

    const foods = await getFoods(u);
    check('伺服器上的常吃清單也真的少一筆', foods.length === 1 && /滷肉飯/.test(foods[0].name), foods.map((f) => f.name));

    /* 已經記進今天的飲食不受影響 */
    await p.click('[data-sheet="close"]').catch(() => {});
    await p.waitForTimeout(500);
    const eaten = (await p.textContent('.eatcard .eatnow')).trim();
    check('已記錄的飲食不受影響（480+3=483）', eaten === '483', eaten);
    check('沒有 pageerror', p.__errs.length === 0, p.__errs);
    await p.context().close();
  }

  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
