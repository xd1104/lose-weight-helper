'use strict';
/* 第二輪使用者視角稽核（v4.9）。都是「同一件事在不同畫面不一樣」的問題：
 *   A. 常吃清單的熱量沒有單位（只寫 900，其他每個地方都寫「大卡」）
 *   B. 手動記錄少了「份量」欄位——常吃編輯有、AI 有，只有它沒有
 *   C. 編輯一筆的「時間」欄位：列表已經不顯示時間了（v4.5），這個欄位變成孤兒，
 *      而且 <input type="time"> 跟著系統跑成 12 小時制，跟 app 一律 24 小時制對不起來
 *   D. 中文句子裡的括號一律全形（原本熱量／身高／體重是半形）
 *   E. 常吃少於 8 筆時不要顯示搜尋框
 *
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, seedUser, openSet } = require('./_setup');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const day = (u) => fetch(BASE + '/api/days?u=' + u + '&dates=' + today()).then((r) => r.json());
const FOODS = ['排骨便當', '鮪魚蛋吐司', '大冰奶', '茶葉蛋'];

(async () => {
  const u = await seedUser();
  await fetch(BASE + '/api/days', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, date: today(), moves: [], entries: [{
      id: 'e1', time: '12:30', meal: 'lunch', name: '鮪魚蛋吐司', kcal: 350, p: 18, c: 34, f: 16,
      portion: '一份（約一個手掌大）', src: 'ai' }] }),
  });
  await fetch(BASE + '/api/foods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, foods: FOODS.map((n, i) => ({
      id: 'f' + i, name: n, kcal: 900 - i * 100, p: 20, c: 30, f: 10, portion: '一份', n: 3 })) }),
  });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.addInitScript(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);

  const closeAll = async () => { await p.evaluate(() => closeAllSheets()); await p.waitForTimeout(350); };
  const openAdd = async (tab) => {
    await closeAll();
    await p.click('[data-nav="today"]'); await p.waitForTimeout(420);
    await p.click('.fab'); await p.waitForTimeout(400);
    await p.click('[data-tab="' + tab + '"]'); await p.waitForTimeout(450);
  };

  console.log('\n[A] 常吃清單的熱量要有單位');
  await openAdd('fav');
  const ks = await p.$$eval('.food-row .k', (e) => e.map((x) => x.textContent.trim()));
  check('每一列都寫「大卡」，不是光禿禿一個數字', ks.length === 4 && ks.every((t) => /大卡$/.test(t)), ks);

  console.log('\n[E] 常吃少於 8 筆時不要放搜尋框');
  check('4 筆時沒有搜尋框', !(await p.$('#i-fav-q')));
  await p.evaluate(() => {
    for (var i = 0; i < 6; i++) db.foods.push({ id: 'z' + i, name: '湊數' + i, kcal: 100, p: 1, c: 1, f: 1, n: 1 });
    drawAddSheet(false);
  });
  await p.waitForTimeout(500);
  check('10 筆時搜尋框才出現', !!(await p.$('#i-fav-q')));

  console.log('\n[B] 手動記錄要有「份量」');
  await openAdd('manual');
  check('有份量欄位 ← 常吃編輯有、AI 有，只有它沒有', !!(await p.$('#m-por')));
  await p.fill('#m-name', '自製沙拉');
  await p.fill('#m-por', '一大碗（約兩個拳頭）');
  await p.fill('#m-kcal', '320');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1800);
  const saved = ((await day(u)).days[0].entries || []).filter((e) => e.name === '自製沙拉')[0] || {};
  check('份量有存進去', saved.portion === '一大碗（約兩個拳頭）', saved.portion);
  check('今天頁那一列就看得到份量',
    /一大碗（約兩個拳頭）/.test(await p.textContent('#app')));

  console.log('\n[C] 編輯一筆不再有「時間」欄位');
  await closeAll();
  await p.click('[data-nav="today"]'); await p.waitForTimeout(420);
  await p.click('.row[data-act="edit-entry"]'); await p.waitForTimeout(600);
  check('沒有時間欄位（列表早就不顯示了，留著只是孤兒）', !(await p.$('#e-time')));
  check('畫面上沒有 12 小時制的殘留', !/AM|PM/.test(await p.textContent('.sheet')));
  await p.fill('#e-kcal', '360');
  await p.click('#f-edit button[type="submit"]');
  await p.waitForTimeout(1800);
  const e2 = ((await day(u)).days[0].entries || []).filter((e) => e.id === 'e1')[0] || {};
  check('存檔正常', e2.kcal === 360, e2.kcal);
  check('原本的時間沒有被清掉（資料保留，只是不給編輯）', e2.time === '12:30', e2.time);

  console.log('\n[D] 中文句子裡的括號一律全形');
  const halfWidth = [];
  const scan = async (label) => {
    const t = await p.textContent('body');
    /* 中文字緊鄰半形括號 ＝ 沒統一到 */
    const m = t.match(/[一-龥]\s?\([^)]{1,8}\)/g);
    if (m) halfWidth.push(label + ': ' + m.join(' / '));
  };
  await closeAll();
  await openAdd('manual'); await scan('手動記錄');
  await closeAll();
  await p.click('[data-nav="today"]'); await p.waitForTimeout(400);
  await p.click('[data-act="edit-weight"]'); await p.waitForTimeout(500); await scan('體重');
  await closeAll();
  for (const sec of ['body', 'goal']) { await openSet(p, sec); await scan('設定/' + sec); }
  await closeAll();
  await p.click('[data-nav="today"]'); await p.waitForTimeout(400);
  await p.click('.fab'); await p.waitForTimeout(400);
  await p.click('[data-act="add-move"]').catch(() => {});
  await p.waitForTimeout(600); await scan('運動');
  check('沒有中文配半形括號的欄位標籤', halfWidth.length === 0, halfWidth);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
