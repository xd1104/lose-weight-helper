'use strict';
/* 非同步流程的中斷（第三輪稽核，v5.0 抓到的兩個真 bug）。
 * 這一類 bug 不會出現在截圖裡，只有真的「送出去等、然後反悔」才會踩到。
 *
 *   A. AI 估算失敗要回得到輸入頁
 *      v4.1 把 runAi 的參數從 photo 改成 photos，catch 裡漏改一處，變成 ReferenceError。
 *      它在 .catch 裡面，所以整個 catch 從那行起中斷、drawAddSheet 永遠不跑 ——
 *      畫面卡在「AI 估算中」轉圈圈回不去，打的字全沒了，而且錯誤被 unhandled
 *      rejection 吃掉，console 也不會紅。
 *   B. 估算中按「關閉」，AI 回來之後 sheet 不可以自己彈回來
 *      原本 .then 無條件 replaceSheet，關掉之後它會自己長回來蓋住整個 app，
 *      導覽列點不到，只能重開。
 *   C. 關掉之後改開別張 sheet，AI 回來也不可以把別人的內容換掉
 *   D. 講評與「重估其中一項」同一個毛病，一併守住
 *
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, seedUser } = require('./_setup');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const FOOD = { items: [{ name: '滷肉飯', portion: '一碗（約一個拳頭，180g）', kcal: 500, protein: 15, carbs: 70, fat: 16, confidence: 'medium' }], note: 'x' };
const COACH = { verdict: '今天蛋白質偏低', good: ['青菜有吃到'], issues: ['蛋白質差 50g'], next: '晚餐加一份雞胸' };

(async () => {
  const u = await seedUser();
  await fetch(BASE + '/api/days', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, date: today(), moves: [], entries: [{
      id: 'e1', time: '12:00', meal: 'lunch', name: '排骨便當', kcal: 900, p: 34, c: 120, f: 30,
      portion: '便當盒', src: 'ai' }] }),
  });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  /* unhandled rejection 不會變成 pageerror —— A 那個 bug 就是這樣躲過去的 */
  await p.addInitScript(() => {
    window.__rej = [];
    window.addEventListener('unhandledrejection',
      (e) => window.__rej.push(String((e.reason && e.reason.message) || e.reason)));
  });

  let delay = 0, status = 200, payload = FOOD;
  await p.route('https://api.anthropic.com/**', async (r) => {
    if (delay) await new Promise((x) => setTimeout(x, delay));
    if (status !== 200) {
      return r.fulfill({ status, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'boom' } }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        usage: { input_tokens: 900, output_tokens: 100 } }) });
  });
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.addInitScript(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);

  const closeAll = async () => { await p.evaluate(() => closeAllSheets()); await p.waitForTimeout(350); };
  const askAi = async (text) => {
    await closeAll();
    await p.click('[data-nav="today"]'); await p.waitForTimeout(420);
    await p.click('.fab'); await p.waitForTimeout(400);
    await p.click('[data-tab="text"]'); await p.waitForTimeout(400);
    await p.fill('#i-text', text);
    p.click('#f-text button[type="submit"]').catch(() => {});
  };
  const rej = () => p.evaluate(() => window.__rej);
  const hidden = () => p.evaluate(() => document.getElementById('sheet-layer').hidden);
  /* 這幾段測的就是「畫面卡住／被蓋住」，壞掉的時候 click 會 timeout。
     一段爆掉就把它記成未過、繼續跑下一段，不然壞版本只看得到第一個錯誤。 */
  const step = async (title, fn) => {
    console.log('\n' + title);
    try { await fn(); } catch (e) {
      console.log('  FAIL 這一段中途爆掉：' + String(e.message).split('\n')[0]);
      fail.push(title + '（中途爆掉）');
      await closeAll().catch(() => {});
    }
  };

  await step('[A] AI 失敗要回得到輸入頁（不是卡在轉圈圈）', async () => {
  status = 401;
  await askAi('滷肉飯');
  await p.waitForTimeout(1800);
  check('有跳錯誤提示', /API key/.test(await p.textContent('#toast').catch(() => '')),
    await p.textContent('#toast').catch(() => ''));
  check('回到輸入頁 ← 原本卡在「AI 估算中」回不去', !!(await p.$('#i-text')));
  /* 卡住的時候 #i-text 根本不存在，直接 inputValue 會整個 timeout 掛掉、
     後面 B/C/D 就都跑不到了 —— 測試自己要撐得住第一項壞掉 */
  const typed = await p.$eval('#i-text', (e) => e.value).catch(() => null);
  check('打的字還在，不用重打', typed === '滷肉飯', typed);
  check('沒有 unhandled rejection ← 原本 ReferenceError 是被這個吃掉的', (await rej()).length === 0, await rej());
  });
  status = 200;

  await step('[B] 估算中按關閉，AI 回來不可以自己彈回來', async () => {
  delay = 1600;
  await askAi('滷肉飯');
  await p.waitForTimeout(500);
  check('等待中的標題是「AI 估算中」', (await p.textContent('.sheet-head h2')) === 'AI 估算中');
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(300);
  check('關掉了', await hidden());
  await p.waitForTimeout(2200);            // 等 AI 真的回來
  check('AI 回來之後還是關著 ← 原本會自己彈回來蓋住整個 app', await hidden());
  check('導覽列點得動', await (async () => {
    try { await p.click('[data-nav="macros"]', { timeout: 3000 }); return true; } catch (e) { return false; }
  })());
  check('沒有 unhandled rejection', (await rej()).length === 0, await rej());
  });

  await step('[C] 關掉之後改開別張，AI 回來不可以換掉別人的內容', async () => {
  await p.click('[data-nav="today"]'); await p.waitForTimeout(420);
  await askAi('滷肉飯');
  await p.waitForTimeout(400);
  await p.click('[data-sheet="close"]'); await p.waitForTimeout(250);
  await p.click('[data-act="edit-weight"]'); await p.waitForTimeout(500);
  check('現在開的是體重', (await p.textContent('.sheet-head h2')) === '體重');
  await p.waitForTimeout(2200);
  check('AI 回來之後還是體重 ← 不可以被換成 AI 結果',
    (await p.textContent('.sheet-head h2')) === '體重', await p.textContent('.sheet-head h2'));
  check('也沒有把體重的輸入框弄掉', !!(await p.$('#w-val')));
  await closeAll();
  });

  await step('[D] 講評也一樣：等待中關掉，回來不可以彈出來', async () => {
  payload = COACH;
  await p.click('[data-nav="today"]'); await p.waitForTimeout(420);
  p.click('[data-act="coach"]').catch(() => {});
  await p.waitForTimeout(500);
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(300);
  await p.waitForTimeout(2200);
  check('講評回來之後畫面還是關著', await hidden());
  check('但講評有存起來（錢已經花了，別浪費）',
    await p.evaluate(() => !!(dayOf(curDate).coach && dayOf(curDate).coach.verdict)));
  check('今天頁的按鈕換成「營養師講評」',
    /營養師講評/.test(await p.textContent('[data-act="coach"]').catch(() => '')),
    await p.textContent('[data-act="coach"]').catch(() => ''));
  check('沒有 unhandled rejection', (await rej()).length === 0, await rej());
  });
  delay = 0; payload = FOOD;

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
