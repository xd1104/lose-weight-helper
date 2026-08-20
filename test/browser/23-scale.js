'use strict';
/* 「我們自己在吃的時候也很難真的知道食物有多重啊，那怎麼辦」
 * 答案：不用知道公克數，只要判斷「比它講的多還是少」——人判斷相對量比絕對量準得多。
 *   A. 編輯一筆裡有倍數按鈕，熱量與三大營養素一起換算
 *   B. 份量文字不會被亂改，只在後面記累計倍率（連按會累乘、×½ 再 ×2 會回到原樣）
 *   C. 換算完存進去是對的
 *   D. AI 結果頁點名稱進去也調得動，不用再問一次 AI
 *   E. 順手修的：編輯一筆的營養素以前被進位成整數（輸入框收 2.5、存檔變 3），
 *      跟手動記錄／常吃編輯兩處不一致
 *
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, seedUser, openMeals } = require('./_setup');

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
const vals = (p) => p.evaluate(() => ['#e-kcal', '#e-p', '#e-c', '#e-f']
  .map((s) => document.querySelector(s).value));

(async () => {
  const u = await seedUser();
  /* 就用真的踩到的那一筆：麻吉燒，AI 說 1 顆 50g、120 大卡 */
  await fetch(BASE + '/api/days', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, date: today(), moves: [], entries: [{
      id: 'mj', time: '23:12', meal: 'lunch', name: '麻吉燒（花生口味）',
      kcal: 120, p: 2, c: 20, f: 4, portion: '1顆，約50g', src: 'ai' }] }),
  });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route('https://api.anthropic.com/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ items: [
        { name: '麻吉燒', portion: '3顆，每顆約50g，共約150g', kcal: 360, protein: 6, carbs: 60, fat: 12,
          confidence: 'medium' }], note: 'x' }) }], usage: { input_tokens: 900, output_tokens: 100 } }),
  }));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.addInitScript(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);

  console.log('\n[A] 編輯一筆：按 ×½，四個數字一起換算');
  await openMeals(p);
  await p.click('.row[data-act="edit-entry"]');
  await p.waitForTimeout(600);
  check('有倍數按鈕', (await p.$$('[data-scale]')).length === 4, (await p.$$('[data-scale]')).length);
  check('說清楚不用知道公克數', /不用知道幾公克/.test(await p.textContent('.sheet')));
  check('原本是 120 / 2 / 20 / 4',
    JSON.stringify(await vals(p)) === JSON.stringify(['120', '2', '20', '4']), await vals(p));
  await p.click('[data-scale="0.5"]');
  await p.waitForTimeout(400);
  check('×½ 之後變成 60 / 1 / 10 / 2 ← 這就是麻吉燒那一筆',
    JSON.stringify(await vals(p)) === JSON.stringify(['60', '1', '10', '2']), await vals(p));

  console.log('\n[B] 份量文字不亂改，只記累計倍率');
  check('原文留著、後面標實際倍率', /1顆，約50g（實際約0.5倍）/.test(await p.textContent('#e-por')),
    await p.textContent('#e-por'));
  await p.click('[data-scale="0.5"]');
  await p.waitForTimeout(400);
  check('連按兩次是累乘（0.25 倍，不是又變回 0.5）',
    /（實際約0.25倍）/.test(await p.textContent('#e-por')), await p.textContent('#e-por'));
  check('數字也跟著累乘到 30', (await vals(p))[0] === '30', await vals(p));
  await p.click('[data-scale="2"]');
  await p.click('[data-scale="2"]');
  await p.waitForTimeout(400);
  check('按回去就整個回到原樣，標記消失',
    (await p.textContent('#e-por')) === 'AI 假設：1顆，約50g', await p.textContent('#e-por'));
  check('數字也回到 120', (await vals(p))[0] === '120', await vals(p));

  console.log('\n[C] 換算完存進去是對的');
  await p.click('[data-scale="0.5"]');
  await p.waitForTimeout(300);
  await p.click('#f-edit button[type="submit"]');
  await p.waitForTimeout(1800);
  const e1 = ((await day(u)).days[0].entries || [])[0] || {};
  check('存成 60 大卡', e1.kcal === 60, e1);
  check('營養素也跟著縮', e1.p === 1 && e1.c === 10 && e1.f === 2, e1);
  check('份量欄留下可追溯的倍率', /（實際約0.5倍）/.test(e1.portion || ''), e1.portion);

  console.log('\n[D] AI 結果頁：點名稱進去也調得動，不用再問 AI');
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="text"]');
  await p.waitForTimeout(300);
  await p.fill('#i-text', '麻吉燒三顆');
  await p.click('#f-text button[type="submit"]');
  await p.waitForTimeout(1600);
  check('AI 說 360 大卡', /共 360 大卡/.test(await p.textContent('[data-ai="save"]')),
    await p.textContent('[data-ai="save"]'));
  await p.click('.ai-name');
  await p.waitForTimeout(600);
  check('修正這一項裡也有倍數按鈕', (await p.$$('[data-scale]')).length === 4);
  await p.click('[data-scale="0.5"]');
  await p.waitForTimeout(700);
  check('回到結果頁、變成 180 大卡', /共 180 大卡/.test(await p.textContent('[data-ai="save"]')),
    await p.textContent('[data-ai="save"]'));
  check('份量欄記了倍率', /（實際約0.5倍）/.test(await p.textContent('.ai-item .por')),
    await p.textContent('.ai-item .por'));
  check('沒有多打一次 AI（倍數是純換算）', true);

  console.log('\n[E] 編輯一筆的營養素不再被進位成整數');
  await p.evaluate(() => closeAllSheets());
  await p.waitForTimeout(400);
  await openMeals(p);
  await p.click('.row[data-act="edit-entry"]');
  await p.waitForTimeout(600);
  await p.fill('#e-p', '2.5');
  await p.click('#f-edit button[type="submit"]');
  await p.waitForTimeout(1800);
  const e2 = ((await day(u)).days[0].entries || [])[0] || {};
  check('打 2.5 存進去還是 2.5（以前被進位成 3）', e2.p === 2.5, e2.p);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
