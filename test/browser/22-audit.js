'use strict';
/* 全 app 的「基本功」稽核。Benson：「不想再花時間去檢查這些基本的東西」。
 * 這一支不測某個功能，而是把「同一類錯誤」一次掃掉，之後加新欄位也會被抓到：
 *   A. 每個 number 欄位都要有 step，而且 inputmode 要跟 step 對得起來
 *      （inputmode="decimal" 卻沒 step ＝ 給你小數點鍵盤又不讓你送出，最糟的組合）
 *   B. 實際打小數進去要能通過驗證（熱量、身高、體重、三大營養素）
 *   C. 所有可點的東西 ≥ 44px（CLAUDE.md 的鐵律，之前有幾個漏掉）
 *   D. 所有輸入框字級 ≥ 16px（iOS 會自動放大整頁）
 *   E. 欄位取得焦點時要被捲進畫面（照片多的時候補充說明會被鍵盤蓋住）
 *   F. 七天長條圖要有目標線（沒有的話「0 天達標」配七根滿格＝圖在騙人）
 *   G. 同一頁不要把同一件事講兩次（設定頁的版本號）
 *
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, seedUser, openSet, openMeals } = require('./_setup');
const path = require('path');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

/* 一個畫面上所有「可以點 / 可以打字」的東西，回傳太小的那些 */
const SMALL = `(() => {
  const bad = [];
  document.querySelectorAll('button, input, textarea, select, label.pbtn').forEach((el) => {
    if (el.type === 'hidden' || el.hidden) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;               // 沒顯示出來的不算
    if (r.height < 43.5) bad.push((el.id || el.className || el.tagName) + ' h=' + r.height.toFixed(0));
  });
  return bad;
})()`;
const TINYFONT = `(() => {
  const bad = [];
  document.querySelectorAll('input, textarea, select').forEach((el) => {
    if (el.type === 'hidden' || el.hidden) return;
    if (!el.getBoundingClientRect().height) return;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 16) bad.push((el.id || el.className) + ' ' + fs + 'px');
  });
  return bad;
})()`;

(async () => {
  const u = await seedUser({ age: 27, height: 168, weight: 80, activity: 1.2, goal: -300 });
  await fetch(BASE + '/api/days', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, date: today(), weight: 79.2, moves: [],
      entries: [{ id: 'x1', time: '12:30', meal: 'lunch', name: '排骨便當', kcal: 900, p: 34, c: 120, f: 30,
        portion: '便當盒、白飯約 1.5 碗', src: 'ai' }] }),
  });
  await fetch(BASE + '/api/foods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, foods: [{ id: 'f1', name: '排骨便當', kcal: 900, p: 34, c: 120, f: 30, portion: '便當盒', n: 3 }] }),
  });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route('https://api.anthropic.com/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ items: [
        { name: '排骨便當', portion: '便當盒', kcal: 900, protein: 34, carbs: 120, fat: 30, confidence: 'medium' }],
        note: 'x' }) }], usage: { input_tokens: 900, output_tokens: 100 } }),
  }));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.addInitScript(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);

  const closeAll = async () => { await p.evaluate(() => closeAllSheets()); await p.waitForTimeout(350); };
  const openAdd = async (tab) => {
    await closeAll();
    await p.click('[data-nav="today"]');           // FAB 只在今天頁
    await p.waitForTimeout(450);
    await p.click('.fab'); await p.waitForTimeout(400);
    await p.click('[data-tab="' + tab + '"]'); await p.waitForTimeout(450);
  };

  /* ───────── A. 每個 number 欄位都要有 step ───────── */
  console.log('\n[A] number 欄位的 step 與 inputmode 要對得起來');
  const screens = [];
  const grab = async (label) => {
    screens.push([label, await p.$$eval('input[type="number"]', (els) => els.map((el) => ({
      id: el.id || el.getAttribute('data-num') || el.getAttribute('data-f') || '?',
      step: el.getAttribute('step'), mode: el.getAttribute('inputmode'),
    })))]);
  };
  await openAdd('manual'); await grab('手動記錄');
  await openAdd('fav'); await p.click('.food-item .food-row'); await p.waitForTimeout(300);
  await closeAll();
  await p.click('[data-nav="today"]'); await p.waitForTimeout(450);
  await openMeals(p);
  await p.click('.row[data-act="edit-entry"]'); await p.waitForTimeout(500); await grab('編輯一筆');
  await closeAll();
  await p.click('[data-act="edit-weight"]'); await p.waitForTimeout(500); await grab('體重');
  await closeAll();
  await p.click('.fab'); await p.waitForTimeout(400); await p.click('[data-act="add-move"]').catch(() => {});
  await closeAll();
  for (const sec of ['body', 'activity', 'goal']) { await openSet(p, sec); await grab('設定/' + sec); }
  await closeAll();

  const noStep = [];
  const mismatch = [];
  screens.forEach(([label, list]) => list.forEach((f) => {
    if (!f.step) noStep.push(label + ':' + f.id);
    else if (f.mode === 'decimal' && f.step === '1') mismatch.push(label + ':' + f.id);
    else if (f.mode === 'numeric' && f.step !== '1') mismatch.push(label + ':' + f.id + ' step=' + f.step);
  }));
  check('每個 number 欄位都寫了 step（沒寫＝預設 1＝小數被擋）', noStep.length === 0, noStep);
  check('inputmode 跟 step 對得起來（不會給小數鍵盤又不收小數）', mismatch.length === 0, mismatch);

  /* ───────── B. 小數真的打得進去 ───────── */
  console.log('\n[B] 小數真的通過驗證');
  const valid = async (sel, v) => {
    await p.fill(sel, v);
    return p.$eval(sel, (el) => el.checkValidity());
  };
  await openAdd('manual');
  check('手動：熱量 187.5 合法 ← Benson 踩到的', await valid('#m-kcal', '187.5'));
  check('手動：蛋白 2.5 合法', await valid('#m-p', '2.5'));
  await closeAll();
  await p.click('[data-nav="today"]'); await p.waitForTimeout(450);
  await openMeals(p);
  await p.click('.row[data-act="edit-entry"]'); await p.waitForTimeout(500);
  check('編輯一筆：熱量 187.5 合法', await valid('#e-kcal', '187.5'));
  await closeAll();
  await openSet(p, 'body');
  check('身高 170.5 合法 ← 原本給了小數鍵盤卻擋下來', await valid('[data-num="height"]', '170.5'));
  check('體重 59.45 合法', await valid('[data-num="weight"]', '59.45'));
  await closeAll();

  /* ───────── C+D. 觸控目標與字級 ───────── */
  console.log('\n[C] 可點的東西都要 ≥ 44px');
  const scan = async (label) => {
    const small = await p.evaluate(SMALL);
    const tiny = await p.evaluate(TINYFONT);
    check(label + '：沒有小於 44px 的可點元素', small.length === 0, small);
    check(label + '：輸入框字級都 ≥ 16px（iOS 才不會放大整頁）', tiny.length === 0, tiny);
  };
  await scan('今天');
  await p.click('[data-nav="macros"]'); await p.waitForTimeout(600); await scan('營養');
  await p.click('[data-nav="history"]'); await p.waitForTimeout(2400); await scan('歷史');
  await p.click('[data-nav="settings"]'); await p.waitForTimeout(600); await scan('設定');
  await p.click('[data-nav="today"]'); await p.waitForTimeout(500);
  await openAdd('manual'); await scan('記一筆/手動');
  await openAdd('text'); await p.fill('#i-text', '排骨便當');
  await p.click('#f-text button[type="submit"]'); await p.waitForTimeout(1600); await scan('AI 結果');
  await closeAll();

  /* ───────── E. 焦點要被捲進畫面 ───────── */
  console.log('\n[E] 欄位取得焦點時要看得到（照片多的時候補充說明會掉到最下面）');
  await openAdd('photo');
  const img = path.join(__dirname, 'meal.png');
  await p.setInputFiles('#i-lib', [img, img, img, img]);
  await p.waitForTimeout(2600);
  const before = await p.$eval('#i-hint', (el) => el.getBoundingClientRect().top);
  await p.click('#i-hint');
  await p.waitForTimeout(900);
  const after = await p.evaluate(() => {
    const r = document.querySelector('#i-hint').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
  });
  check('補充說明本來在很下面', before > 400, before);
  check('點下去之後被捲到畫面中間看得到',
    after.top > 0 && after.bottom < after.vh - 60, after);
  await closeAll();

  /* ───────── F. 圖表要有基準，不能讓最高那根永遠貼頂 ───────── */
  console.log('\n[F] 圖表要有基準');
  /* v6.4：首頁的七天長條圖拿掉了（最上面的體重趨勢講的是同一件事，而且講得更好）。
     長條圖現在只剩營養頁的蛋白質在用，目標線那條鐵律照樣要成立。 */
  await p.click('[data-nav="macros"]'); await p.waitForTimeout(700);
  check('營養頁的蛋白質圖有目標線', !!(await p.$('.spark .goal-line')));
  check('線上標了是什麼的目標', /目標/.test(await p.textContent('.spark .goal-line b')),
    await p.textContent('.spark .goal-line b').catch(() => ''));
  await p.click('[data-nav="today"]'); await p.waitForTimeout(700);
  check('首頁不再有七天長條圖（跟趨勢圖講同一件事）', !(await p.$('.spark')));

  /* ───────── G. 同一頁不要講兩次 ───────── */
  console.log('\n[G] 設定頁的版本號只該出現一次');
  await p.click('[data-nav="settings"]'); await p.waitForTimeout(600);
  const ver = await p.evaluate(() => APP_VER);
  const hits = (await p.textContent('#app')).split('v' + ver).length - 1;
  check('版本號只印一次（原本列上一次、頁尾又一次）', hits === 1, hits);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
