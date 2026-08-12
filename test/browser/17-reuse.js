'use strict';
/* 「同一張照片估兩次差很多」的正解：吃過的東西沿用上次記的數字，根本不重估。
 *   A. 第一次記 -> 沒有東西可沿用（清單是空的）
 *   B. 第二次記同一份 -> 提示「有 N 樣你記過」，講得出上次多少、這次差多少
 *   C. 「全部沿用」一鍵套用，總熱量回到跟第一次一模一樣
 *   D. 差很少（5% 以內）不提示 —— 差幾大卡還跳出來問只是版面雜訊
 *   E. 名稱寫法不同也要認得（「白飯」vs「白飯（便當盒）」），不然常吃清單會長出近似重複
 *   F. 加了星的常吃項目，AI 不准用新的估算蓋掉他手動改過的數字
 *   G. 沿用只借「數字」，份量文字要留今天這一次的（v6.0 的真 bug）
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
const txt = async (p, sel) => (await p.textContent(sel).catch(() => '')) || '';
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

/* 這一批就是「AI 每次估出來的數字」——測試裡由我們決定它這次回什麼 */
let NEXT = [];

(async () => {
  const u = await seedUser();
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  await p.route('https://api.anthropic.com/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ items: NEXT, note: '估的' }) }],
      usage: { input_tokens: 900, output_tokens: 150 },
    }),
  }));

  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.evaluate((id) => localStorage.setItem('lwh_user', id), u);
  await p.evaluate(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  /* 文字估算一次，停在結果頁 */
  async function estimate(text) {
    await p.click('.fab');
    await p.waitForTimeout(400);
    await p.click('[data-tab="text"]');
    await p.waitForTimeout(300);
    await p.fill('#i-text', text);
    await p.click('#f-text button[type="submit"]');
    await p.waitForTimeout(1500);
  }
  const totalBtn = () => txt(p, '[data-ai="save"]');

  console.log('\n[A] 第一次記：沒有東西可以沿用');
  NEXT = [
    { name: '白飯', portion: '便當盒約 1.5 碗', kcal: 420, protein: 8, carbs: 92, fat: 1, confidence: 'medium' },
    { name: '炸排骨', portion: '一片', kcal: 350, protein: 22, carbs: 12, fat: 24, confidence: 'medium' },
  ];
  await estimate('排骨便當');
  check('沒有「你記過」的提示', !(await p.$('.ai-reuse')), await txt(p, '.ai-reuse'));
  check('也沒有單項的沿用鈕', !(await p.$('.ai-last')));
  const first = await totalBtn();
  check('第一次總熱量 770', /共 770 大卡/.test(first), first);
  await p.click('[data-ai="save"]');
  await p.waitForTimeout(1600);

  console.log('\n[B] 第二次記同一份：AI 估出不一樣的數字 -> 認得出來，講得出差多少');
  NEXT = [
    { name: '白飯', portion: '便當盒約 2 碗', kcal: 560, protein: 10, carbs: 124, fat: 1, confidence: 'medium' },
    { name: '炸排骨', portion: '一片（大）', kcal: 430, protein: 26, carbs: 15, fat: 30, confidence: 'medium' },
  ];
  await estimate('排骨便當');
  const banner = await txt(p, '.ai-reuse');
  check('提示有 2 樣記過', /有 2 樣你記過/.test(banner), banner);
  check('說清楚沿用的好處', /每次記都會一樣/.test(banner), banner);
  const lasts = await p.$$eval('.ai-last', (e) => e.map((x) => x.textContent.trim()));
  check('白飯講得出上次 420、這次多 140', /上次記 420 大卡（這次多 140）/.test(lasts[0] || ''), lasts);
  check('排骨講得出上次 350、這次多 80', /上次記 350 大卡（這次多 80）/.test(lasts[1] || ''), lasts);
  const second = await totalBtn();
  check('沒按之前總熱量還是 AI 這次估的 990', /共 990 大卡/.test(second), second);

  console.log('\n[C] 一鍵全部沿用 -> 數字回到跟第一次一模一樣');
  await p.click('[data-use="all"]');
  await p.waitForTimeout(600);
  const after = await totalBtn();
  check('總熱量回到 770（＝第一次）', /共 770 大卡/.test(after), after);
  check('提示消失（沒東西要沿用了）', !(await p.$('.ai-reuse')));
  const done = await p.$$eval('.ai-last.done', (e) => e.map((x) => x.textContent.trim()));
  check('兩項都標「已沿用」', done.length === 2 && /已沿用上次記的數字/.test(done[0]), done);
  const kc = await p.$$eval('[data-f="kcal"]', (e) => e.map((x) => x.value));
  check('輸入框也換成上次的值', kc[0] === '420' && kc[1] === '350', kc);
  await p.click('[data-ai="save"]');
  await p.waitForTimeout(1600);

  console.log('\n[D] 差很少就不要吵：5% 以內不提示');
  NEXT = [
    { name: '白飯', portion: '便當盒約 1.5 碗', kcal: 428, protein: 8, carbs: 93, fat: 1, confidence: 'medium' },
    { name: '炸排骨', portion: '一片', kcal: 500, protein: 30, carbs: 15, fat: 35, confidence: 'medium' },
  ];
  await estimate('排骨便當');
  const lasts2 = await p.$$eval('.ai-last', (e) => e.map((x) => x.textContent.trim()));
  check('白飯只差 8 大卡 -> 不提示', !lasts2.some((t) => /白飯/.test(t)) && lasts2.length === 1, lasts2);
  check('排骨差 150 -> 還是提示', /上次記 350 大卡/.test(lasts2[0] || ''), lasts2);
  check('提示只算 1 樣', /有 1 樣你記過/.test(await txt(p, '.ai-reuse')), await txt(p, '.ai-reuse'));
  await p.click('[data-ai="cancel"], [data-sheet="close"]').catch(() => {});
  await p.evaluate(() => closeAllSheets());
  await p.waitForTimeout(500);

  console.log('\n[E] 名稱寫法不同也要認得（不然常吃清單會長出近似重複）');
  NEXT = [{ name: '白飯（便當盒）', portion: '約 1.5 碗', kcal: 600, protein: 12, carbs: 130, fat: 2, confidence: 'medium' }];
  await estimate('白飯');
  check('括號寫法也對得上「白飯」', /上次記 420 大卡/.test(await txt(p, '.ai-last')), await txt(p, '.ai-last'));
  await p.click('[data-use="0"]');
  await p.waitForTimeout(500);
  const nm = await txt(p, '.ai-name');
  check('沿用之後名稱也對齊成清單裡的寫法', /^白飯/.test(nm.replace('✎', '').trim()), nm);
  await p.click('[data-ai="save"]');
  await p.waitForTimeout(1600);
  const foods1 = await (await fetch(BASE + '/api/core?u=' + u)).json();
  check('常吃清單沒長出第二筆白飯',
    foods1.foods.filter((f) => /白飯/.test(f.name)).length === 1,
    foods1.foods.map((f) => f.name));

  console.log('\n[F] 加了星的常吃項目，AI 不准蓋掉手動改過的數字');
  /* 直接把「白飯」設成常吃並改成他自己量過的 400 */
  await p.evaluate(() => {
    var f = findFood('白飯');
    f.star = true; f.kcal = 400; f.p = 8; f.c = 88; f.f = 1;
    persistFoods();
  });
  await p.waitForTimeout(900);
  NEXT = [{ name: '白飯', portion: '約 2 碗', kcal: 700, protein: 14, carbs: 150, fat: 2, confidence: 'medium' }];
  await estimate('白飯');
  check('沿用鈕拿的是他改過的 400', /上次記 400 大卡/.test(await txt(p, '.ai-last')), await txt(p, '.ai-last'));
  await p.click('[data-ai="save"]');           // 刻意不沿用，存 AI 的 700
  await p.waitForTimeout(1800);
  const foods2 = await (await fetch(BASE + '/api/core?u=' + u)).json();
  const rice = foods2.foods.filter((f) => /^白飯/.test(f.name))[0] || {};
  check('常吃的白飯還是 400，沒被 AI 的 700 蓋掉', rice.kcal === 400, rice);
  check('星號還在', rice.star === true, rice);
  check('次數有累加', rice.n >= 2, rice.n);

  console.log('\n[G] 沿用只借數字，不要把上一餐的情境搬過來');
  /* 真的踩到：常吃清單裡的「荷包蛋」份量寫著「1顆，煎於蔥油餅上」（好幾天前配蔥油餅
     那次留下的），今天吃自助餐按了沿用，紀錄就變成今天也有蔥油餅。
     沿用的用意是「熱量跟上次一致」，不是「連那一餐的畫面一起複製」。 */
  await p.evaluate(() => {
    db.foods.push({ id: 'egg', name: '荷包蛋', kcal: 90, p: 6, c: 1, f: 7,
      portion: '1顆，煎於蔥油餅上', n: 2 });
    persistFoods();
  });
  await p.waitForTimeout(900);
  NEXT = [{ name: '荷包蛋', portion: '1顆（約50g）', kcal: 130, protein: 7, carbs: 1, fat: 11,
    confidence: 'medium' }];
  await estimate('荷包蛋');
  check('有沿用鈕（130 vs 90 差很多）', !!(await p.$('.ai-last')));
  await p.click('.ai-last');
  await p.waitForTimeout(700);
  const por = await txt(p, '.ai-item .por');
  check('份量用今天這一次的', /1顆（約50g）/.test(por), por);
  check('沒有把「煎於蔥油餅上」搬過來 ← 今天根本沒吃蔥油餅', !/蔥油餅/.test(por), por);
  check('數字還是沿用上次的 90', /90/.test(await txt(p, '[data-ai="save"]')),
    await txt(p, '[data-ai="save"]'));
  await p.click('[data-ai="save"]');
  await p.waitForTimeout(1800);
  const day = await (await fetch(BASE + '/api/days?u=' + u + '&dates=' + today())).json();
  const eggRow = ((day.days[0] || {}).entries || []).filter((e) => e.name === '荷包蛋').pop() || {};
  check('存進去的份量也沒有蔥油餅', !/蔥油餅/.test(eggRow.portion || ''), eggRow);
  check('存進去的熱量是沿用的 90', eggRow.kcal === 90, eggRow);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
