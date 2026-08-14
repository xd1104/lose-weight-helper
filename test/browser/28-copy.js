'use strict';
/* 從另一位使用者複製一餐（v6.1）。
 *
 * 他們常常一起吃，一個人記完另一個人不用再記一次。實測 17 天的紀錄：
 * 早餐 14 次同時記、其中 12 次有重疊；午餐 14 次同時記卻只有 1 次重疊
 * （午餐各自在外面吃）。所以入口**只在對方那一餐真的有你還沒記的東西時才出現**，
 * 不然午餐會天天跳出來擋路。
 *
 *   A. 對方那一餐有記 -> 出現橫幅，寫得出幾樣、多少大卡
 *   B. 對方沒記那一餐 -> 完全不出現（不要變成永遠在那裡的雜訊）
 *   C. 複製：預設全選，可以挑掉沒吃的
 *   D. 整批調倍數（她吃得比較少），份量欄留下可追溯的倍率
 *   E. 複製過來的東西會進她自己的常吃清單，數字是她的（不是對方的）
 *   F. ⚠️ 已經記過的不再出現在可複製清單裡，複製完橫幅就消失（不會重複加）
 *   G. ⚠️ 只有「拉」沒有「推」：複製不可以動到對方的紀錄
 *   H. 換餐別會重算
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
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const dayOf = (u) => fetch(BASE + '/api/days?u=' + u + '&dates=' + today())
  .then((r) => r.json()).then((j) => (j.days[0] || {}).entries || []);
const foodsOf = (u) => fetch(BASE + '/api/core?u=' + u).then((r) => r.json()).then((j) => j.foods || []);

const HIM = 't-him', HER = 't-her';
/* 就照 08-11 那天的真實早餐 */
const HIS_BREAKFAST = [
  { id: 'h1', time: '08:00', meal: 'breakfast', name: '無糖豆漿', kcal: 30, p: 3, c: 1, f: 1, portion: '半杯，約120ml', src: 'ai' },
  { id: 'h2', time: '08:00', meal: 'breakfast', name: '水煮蛋', kcal: 78, p: 6, c: 1, f: 5, portion: '1顆（約50g）', src: 'ai' },
  { id: 'h3', time: '08:00', meal: 'breakfast', name: '全麥吐司', kcal: 80, p: 3, c: 14, f: 1, portion: '1片，約30克', src: 'ai' },
  { id: 'h4', time: '08:00', meal: 'breakfast', name: '低脂起司片', kcal: 50, p: 4, c: 1, f: 3, portion: '1片，約20克', src: 'ai' },
];
const HIS_LUNCH = [
  { id: 'h9', time: '12:30', meal: 'lunch', name: '排骨便當', kcal: 900, p: 34, c: 120, f: 30, portion: '便當盒', src: 'ai' },
];

(async () => {
  await clearAll();
  await fetch(BASE + '/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: [
      { id: HIM, name: '黏', emoji: '🐻', color: '#2fa86a' },
      { id: HER, name: '肚', emoji: '🐱', color: '#e0447f' }] }),
  });
  for (const u of [HIM, HER]) {
    await fetch(BASE + '/api/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ u, profile: { sex: 'male', age: 30, height: 170, weight: 70, activity: 1.375, goal: -400 } }),
    });
  }
  await fetch(BASE + '/api/days', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u: HIM, date: today(), moves: [], entries: HIS_BREAKFAST.concat(HIS_LUNCH) }),
  });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), HER);
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1600);

  const openAdd = async (meal) => {
    await p.evaluate(() => closeAllSheets());
    await p.waitForTimeout(300);
    await p.click('[data-nav="today"]'); await p.waitForTimeout(400);
    await p.click('.fab'); await p.waitForTimeout(500);
    if (meal) { await p.click('[data-meal-pick="' + meal + '"]'); await p.waitForTimeout(500); }
    await p.waitForTimeout(900);      // 對方那一餐是背景載入的
  };
  const bar = () => p.textContent('.copy-bar').catch(() => '');

  console.log('\n[A] 對方那一餐有記 -> 出現橫幅');
  await openAdd('breakfast');
  const t = await bar();
  check('橫幅出現了', !!t, t);
  check('寫得出是誰、哪一餐、幾樣', /黏 的早餐記了 4 樣/.test(t), t);
  check('也寫得出總熱量', /238 大卡/.test(t), t);
  await p.screenshot({ path: '/tmp/copy-bar.png', clip: { x: 0, y: 300, width: 390, height: 400 } });

  console.log('\n[B] 對方沒記那一餐 -> 完全不出現');
  await p.click('[data-meal-pick="dinner"]');
  await p.waitForTimeout(1400);
  check('晚餐沒有橫幅 ← 不然午晚餐會天天跳出來擋路', !(await p.$('.copy-bar')));

  console.log('\n[C] 複製：預設全選，可以挑掉沒吃的');
  await p.click('[data-meal-pick="breakfast"]');
  await p.waitForTimeout(1400);
  await p.click('.copy-bar');
  await p.waitForTimeout(700);
  check('四樣都預設勾選', (await p.$$('.food-row.on')).length === 4);
  check('加入鈕寫出筆數與總熱量',
    /加入 4 筆 · 共 238 大卡/.test(await p.textContent('[data-cp-go]')),
    await p.textContent('[data-cp-go]'));
  await p.click('[data-cp="h4"]');          // 起司片她沒吃
  await p.waitForTimeout(500);
  check('挑掉一樣之後剩三筆 188 大卡',
    /加入 3 筆 · 共 188 大卡/.test(await p.textContent('[data-cp-go]')),
    await p.textContent('[data-cp-go]'));

  console.log('\n[D] 整批調倍數');
  await p.click('[data-cpscale="0.75"]');
  await p.waitForTimeout(500);
  check('×¾ 之後變成 141 大卡',
    /加入 3 筆 · 共 141 大卡/.test(await p.textContent('[data-cp-go]')),
    await p.textContent('[data-cp-go]'));
  await p.click('[data-cp-go]');
  await p.waitForTimeout(2000);

  const hers = await dayOf(HER);
  check('她今天多了三筆', hers.length === 3, hers.map((e) => e.name));
  const soy = hers.filter((e) => e.name === '無糖豆漿')[0] || {};
  check('熱量是縮放過的（30 × 0.75 ≈ 23）', soy.kcal === 23, soy);
  check('份量欄留下可追溯的倍率', /（實際約0.75倍）/.test(soy.portion || ''), soy.portion);
  check('原本的份量文字還在', /半杯，約120ml/.test(soy.portion || ''), soy.portion);
  check('沒有把起司片複製過來', !hers.filter((e) => e.name === '低脂起司片').length, hers.map((e) => e.name));
  check('記在早餐', hers.every((e) => e.meal === 'breakfast'), hers.map((e) => e.meal));

  console.log('\n[E] 複製過來的會進她自己的常吃清單，數字是她的');
  const herFoods = await foodsOf(HER);
  const herSoy = herFoods.filter((f) => f.name === '無糖豆漿')[0] || {};
  check('進了她的常吃清單', !!herSoy.id, herFoods.map((f) => f.name));
  check('存的是縮放後的 23，不是對方的 30 ← 不然又會互相蓋數字', herSoy.kcal === 23, herSoy);
  check('也記了是早餐吃的', herSoy.mc && herSoy.mc.breakfast === 1, herSoy.mc);

  console.log('\n[F] 已經記過的不再出現，複製完橫幅就消失');
  await openAdd('breakfast');
  const t2 = await bar();
  check('只剩沒複製的那一樣（起司片）', /記了 1 樣/.test(t2), t2);
  await p.click('.copy-bar');
  await p.waitForTimeout(700);
  check('清單裡只有起司片', (await p.$$('[data-cp]')).length === 1);
  await p.click('[data-cp-go]');
  await p.waitForTimeout(2000);
  await openAdd('breakfast');
  check('四樣都複製完之後橫幅消失 ← 不會重複加', !(await p.$('.copy-bar')));
  check('她今天總共四筆', (await dayOf(HER)).length === 4);

  console.log('\n[G] 只有拉沒有推：不可以動到對方的紀錄');
  const his = await dayOf(HIM);
  check('他的紀錄還是原本那五筆', his.length === 5, his.length);
  check('他的無糖豆漿還是 30，沒被她的 0.75 倍影響',
    (his.filter((e) => e.name === '無糖豆漿')[0] || {}).kcal === 30, his);
  const hisFoods = await foodsOf(HIM);
  check('也沒有動到他的常吃清單', hisFoods.length === 0, hisFoods.map((f) => f.name));

  console.log('\n[H] 換餐別會重算');
  await p.click('[data-meal-pick="lunch"]');
  await p.waitForTimeout(1400);
  const t3 = await bar();
  check('午餐看得到他的排骨便當', /黏 的午餐記了 1 樣/.test(t3), t3);
  check('午餐的熱量是 900', /900 大卡/.test(t3), t3);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
