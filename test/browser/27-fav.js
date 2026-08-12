'use strict';
/* 常吃清單的分組與折疊（v5.8）。
 *
 * 起因是他說「清單太長，想分成早餐常吃／晚餐常吃，還要能折疊」。
 * 但看了真實資料才發現長度不是主因：114 筆裡有 94 筆只吃過一次，
 * 都是 AI 把一餐拆成十幾項之後自動存進來的碎片（甜椒配料 3 大卡、
 * 蒔蘿與檸檬調味 5 大卡…）。只做分組等於把垃圾摺起來，所以三件事一起做：
 *
 *   A. 分組是「算」出來的，不是讓他手動標的（大冰奶算早餐還是點心？手動分類一定會爛）
 *   B. 預設全部收起來（v5.9 改的：原本會自動展開「現在要記的那一餐」，
 *      但那是照時間猜的，猜錯反而要多做一次收合）
 *   C. 換餐別不會把他自己點開的那幾組關掉
 *   D. 預設只列「吃過 2 次以上」，一次性的碎片收在「全部」裡
 *   E. 搜尋一律搜全部 —— 要找的東西剛好只吃過一次是很常見的情況
 *   F. 記一筆之後次數會累加，新東西第一次記就分好組
 *   G. 清單短的時候不分組也不過濾（三筆東西擺三個標題只是找麻煩）
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
const foodsOf = (u) => fetch(BASE + '/api/core?u=' + u).then((r) => r.json()).then((j) => j.foods || []);

/* 造一份「長得像真的」的清單：早餐固定那幾樣、午晚餐各有常客，
   再加一堆只吃過一次的碎片（就是他清單裡那 94 筆的樣子）。 */
const FOODS = [
  { id: 'b1', name: '無糖豆漿', kcal: 30, n: 5, mc: { breakfast: 5 } },
  { id: 'b2', name: '水煮蛋', kcal: 78, n: 4, mc: { breakfast: 4 } },
  { id: 'b3', name: '全麥吐司', kcal: 80, n: 4, mc: { breakfast: 4 } },
  { id: 'l1', name: '糙米飯', kcal: 130, n: 3, mc: { lunch: 3 } },
  { id: 'l2', name: '炒空心菜', kcal: 60, n: 3, mc: { lunch: 2, dinner: 1 } },
  { id: 'd1', name: '意麵', kcal: 300, n: 2, mc: { dinner: 2 } },
  { id: 'd2', name: '滷豆乾', kcal: 140, n: 2, mc: { dinner: 2 } },
  { id: 's1', name: '芒果', kcal: 180, n: 2, mc: { snack: 2 } },
  { id: 'x1', name: '沒分組的老資料', kcal: 100, n: 3 },
];
for (let i = 0; i < 20; i++) {
  FOODS.push({ id: 'j' + i, name: '碎片' + i, kcal: 5 + i, n: 1, mc: { lunch: 1 } });
}

(async () => {
  const u = await seedUser();
  await fetch(BASE + '/api/foods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, foods: FOODS }),
  });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.addInitScript(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);

  const openFav = async (meal) => {
    await p.evaluate(() => closeAllSheets());
    await p.waitForTimeout(300);
    await p.click('[data-nav="today"]'); await p.waitForTimeout(400);
    await p.click('.fab'); await p.waitForTimeout(400);
    if (meal) { await p.click('[data-meal-pick="' + meal + '"]'); await p.waitForTimeout(400); }
    await p.click('[data-tab="fav"]'); await p.waitForTimeout(500);
  };
  const groups = () => p.$$eval('[data-fav-fold]', (e) => e.map((x) => ({
    key: x.getAttribute('data-fav-fold'),
    label: x.querySelector('b').textContent.trim(),
    n: Number(x.querySelector('span').textContent),
    open: x.classList.contains('on'),
  })));
  const rows = () => p.$$eval('.food-row b', (e) => e.map((x) => x.childNodes[0].textContent.trim()));

  console.log('\n[A] 分組是算出來的，不用手動標');
  await openFav('breakfast');
  const g = await groups();
  check('有分組標題', g.length >= 3, g);
  check('早餐那組是 3 筆（豆漿/水煮蛋/吐司）',
    (g.filter((x) => x.key === 'breakfast')[0] || {}).n === 3, g);
  check('炒空心菜歸到午餐（午餐 2 次 > 晚餐 1 次）',
    (g.filter((x) => x.key === 'lunch')[0] || {}).n === 2, g);
  check('沒有 mc 的老資料歸到「其他」，不會消失',
    (g.filter((x) => x.key === 'other')[0] || {}).n === 1, g);
  check('分組用的是餐別名稱', g.some((x) => x.label === '早餐') && g.some((x) => x.label === '午餐'), g);

  console.log('\n[B] 預設全部收起來');
  check('沒有任何一組是開的', g.every((x) => !x.open), g);
  let r = await rows();
  check('一開始看不到任何項目，只有標題', r.length === 0, r);
  await p.screenshot({ path: '/tmp/fav-grouped.png', clip: { x: 0, y: 300, width: 390, height: 544 } });

  console.log('\n[C] 自己點開、點收，換餐別不會把它關掉');
  await p.click('[data-fav-fold="breakfast"]');
  await p.waitForTimeout(400);
  r = await rows();
  check('點開早餐看到那三樣', r.length === 3 && r.indexOf('無糖豆漿') >= 0, r);
  await p.click('[data-meal-pick="dinner"]');
  await p.waitForTimeout(500);
  check('換到晚餐之後，早餐那組還是開著 ← 他自己點開的不要被收掉',
    (await groups()).filter((x) => x.key === 'breakfast')[0].open === true);
  check('也沒有自作主張把晚餐打開',
    (await groups()).filter((x) => x.key === 'dinner')[0].open === false);
  await p.click('[data-fav-fold="dinner"]');
  await p.waitForTimeout(400);
  r = await rows();
  check('兩組都開就兩組都看得到', r.length === 5, r);
  await p.click('[data-fav-fold="breakfast"]');
  await p.waitForTimeout(400);
  r = await rows();
  check('收掉早餐只剩晚餐', r.length === 2, r);

  console.log('\n[C2] 重開「記一筆」會回到全部收起來');
  await openFav('breakfast');
  check('重開之後沒有任何一組是開的', (await groups()).every((x) => !x.open));

  console.log('\n[D] 預設只列「吃過 2 次以上」，碎片收在「全部」');
  const seg = await p.$$eval('[data-fav-scope]', (e) => e.map((x) => x.textContent.trim()));
  check('有「常吃 / 全部」切換', seg.length === 2, seg);
  check('常吃是 9 筆、全部是 29 筆', /常吃 9/.test(seg[0]) && /全部 29/.test(seg[1]), seg);
  check('預設停在「常吃」', await p.$eval('[data-fav-scope="0"]', (e) => e.classList.contains('on')));
  const lunchBefore = (await groups()).filter((x) => x.key === 'lunch')[0].n;
  check('午餐那組現在只有 2 筆（碎片沒算進來）', lunchBefore === 2, lunchBefore);
  await p.click('[data-fav-scope="1"]');
  await p.waitForTimeout(600);
  const lunchAfter = (await groups()).filter((x) => x.key === 'lunch')[0].n;
  check('切到「全部」之後午餐變 22 筆 ← 碎片沒有不見，只是不擋路', lunchAfter === 22, lunchAfter);
  await p.click('[data-fav-scope="0"]');
  await p.waitForTimeout(600);

  console.log('\n[E] 搜尋一律搜全部（要找的東西剛好只吃過一次是常態）');
  await p.fill('#i-fav-q', '碎片7');
  await p.waitForTimeout(500);
  r = await rows();
  check('在「常吃」模式下也搜得到只吃過一次的', r.length === 1 && r[0] === '碎片7', r);
  check('搜尋結果不分組（直接列出來）', (await groups()).length === 0);
  await p.fill('#i-fav-q', '');
  await p.waitForTimeout(500);
  check('清空搜尋會回到分組', (await groups()).length >= 3);

  console.log('\n[F] 記一筆之後次數會累加，新東西第一次記就分好組');
  await p.evaluate(() => closeAllSheets());
  await p.waitForTimeout(300);
  await p.click('[data-nav="today"]'); await p.waitForTimeout(400);
  await p.click('.fab'); await p.waitForTimeout(400);
  await p.click('[data-meal-pick="dinner"]'); await p.waitForTimeout(300);
  await p.click('[data-tab="manual"]'); await p.waitForTimeout(400);
  await p.fill('#m-name', '滷雞腿');
  await p.fill('#m-kcal', '320');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1800);
  let fs2 = await foodsOf(u);
  const nf = fs2.filter((x) => x.name === '滷雞腿')[0];
  check('新項目記了是晚餐吃的', nf && nf.mc && nf.mc.dinner === 1, nf);
  /* 已經有的項目要累加，不是覆蓋 */
  await p.evaluate(() => closeAllSheets());
  await p.waitForTimeout(300);
  await p.click('.fab'); await p.waitForTimeout(400);
  await p.click('[data-meal-pick="breakfast"]'); await p.waitForTimeout(300);
  await p.click('[data-tab="manual"]'); await p.waitForTimeout(400);
  await p.fill('#m-name', '無糖豆漿');
  await p.fill('#m-kcal', '30');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1800);
  fs2 = await foodsOf(u);
  const soy = fs2.filter((x) => x.name === '無糖豆漿')[0];
  check('原本 5 次的早餐變成 6 次（累加不是覆蓋）', soy && soy.mc && soy.mc.breakfast === 6, soy && soy.mc);

  console.log('\n[G] 清單短的時候不分組也不過濾');
  await fetch(BASE + '/api/foods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, foods: [
      { id: 'a', name: '滷肉飯', kcal: 500, n: 1 },
      { id: 'b', name: '燙青菜', kcal: 60, n: 1 },
      { id: 'c', name: '味噌湯', kcal: 50, n: 1 },
    ] }),
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await openFav('lunch');
  check('三筆東西不要擺三個標題', (await groups()).length === 0);
  check('也不要出現「常吃 / 全部」切換', !(await p.$('[data-fav-scope]')));
  r = await rows();
  check('三筆全部看得到 ← 全都只吃過一次，濾掉就整片空白了', r.length === 3, r);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
