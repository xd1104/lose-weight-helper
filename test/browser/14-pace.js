'use strict';
/* 「一週約 −0.19 kg」：把抽象的大卡翻成看得懂的進度。
 * Benson 的原話：這種具體數字比較有動力。
 *   A. 晚上才顯示（中午只吃 300 大卡時算出來是「一週 −1.6 kg」，那是假的）
 *   B. 用的是「跟 TDEE 比」的真實缺口，不是設定裡那個理論值
 *   C. 吃超過 TDEE 時要變成 +（會胖），而且是紅的
 *   D. 歷史頁用最近 7 天的實際平均（沒有「今天還沒過完」的問題）
 *   E. 歷史長條也是三段：超過上限但沒超 TDEE = 黃，不能全部畫紅的，
 *      不然會跟上面「你一週在瘦」自打嘴巴
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
const D = (o) => {
  const d = new Date(); d.setDate(d.getDate() + (o || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const post = (u, dt, kcal) => fetch(BASE + '/api/days', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ u, date: dt, entries: [{ id: 'e' + dt, name: '一天', kcal, p: 100, c: 180, f: 55, meal: 'lunch' }], moves: [] }),
});

/* 把瀏覽器的時鐘固定在某個小時，才測得到「白天不顯示、晚上才顯示」 */
const freezeAt = (hour) => `(() => {
  const R = Date; const F = new R(); F.setHours(${hour}, 30, 0, 0);
  window.Date = class extends R {
    constructor(...a) { if (!a.length) return new R(F.getTime()); return new R(...a); }
    static now() { return F.getTime(); }
  };
})()`;

(async () => {
  // Benson 的設定：BMR 1,720 / TDEE 2,064 / 每日上限 1,764
  const u = await seedUser({ age: 27, height: 168, weight: 80, activity: 1.2, goal: -300 });
  for (let i = 1; i <= 6; i++) await post(u, D(-i), 1800 + i * 20);
  await post(u, D(0), 1853);          // 他問的那個數字

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);

  console.log('\n[A] 中午不顯示（一天還沒過完，算出來是假的）');
  await p.addInitScript(freezeAt(12));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);
  check('白天首頁沒有「一週約 X kg」', !(await p.$('.pace')), await p.textContent('.pace').catch(() => ''));

  console.log('\n[B] 晚上 8 點後才出現，而且是跟 TDEE 比出來的真實缺口');
  const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errs.push(e.message));
  await p2.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p2.addInitScript(freezeAt(21));
  await p2.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p2.waitForTimeout(1400);

  const pace = (await p2.textContent('.pace').catch(() => '')) || '';
  check('晚上會顯示', !!pace, pace);
  // 吃 1,853、TDEE 2,064 -> 缺口 211；211×7/7700 = 0.19 kg
  check('缺口是跟 TDEE 比（211），不是跟上限 1,764 比（89）', /少 211 大卡/.test(pace), pace);
  check('換算成一週 −0.19 kg', /一週約 −0.19 kg/.test(pace), pace);
  check('是綠的（有進度）', !/over/.test(await p2.getAttribute('.pace', 'class')));
  await p2.screenshot({ path: '/tmp/pace-today.png', clip: { x: 0, y: 0, width: 390, height: 620 } });

  console.log('\n[B2] 黃色提示不再說「幾乎沒有減脂進度」（下面就寫著一週 −0.19 kg，會打架）');
  const tag = (await p2.textContent('.over-tag').catch(() => '')) || '';
  check('黃色提示還在', /超過上限 89/.test(tag), tag);
  check('改口成「缺口比計畫小」', /缺口比計畫小/.test(tag) && !/沒有減脂進度/.test(tag), tag);

  console.log('\n[C] 吃超過 TDEE -> 變成 + 而且是紅的');
  await post(u, D(0), 2564);          // 比 TDEE 多 500
  await p2.reload({ waitUntil: 'networkidle' });
  await p2.waitForTimeout(1400);
  const pace2 = (await p2.textContent('.pace').catch(() => '')) || '';
  check('說「比 TDEE 多 500 大卡」', /多 500 大卡/.test(pace2), pace2);
  check('一週變成 +0.45 kg', /一週約 \+0.45 kg/.test(pace2), pace2);
  check('紅的', /over/.test(await p2.getAttribute('.pace', 'class')));

  await post(u, D(0), 1853);          // 復原
  await p2.reload({ waitUntil: 'networkidle' });
  await p2.waitForTimeout(1400);

  console.log('\n[D] 歷史頁：用最近 7 天的實際平均');
  await p2.click('[data-nav="history"]');
  await p2.waitForTimeout(2500);
  const big = (await p2.textContent('.pace.big').catch(() => '')) || '';
  check('歷史頁有 7 天的步調', /最近 7 天平均/.test(big), big);
  check('講得出平均缺口與一週幾公斤', /少 \d+ 大卡/.test(big) && /一週約 −0\.\d+ kg/.test(big), big);
  check('有註明是理論值', /理論值/.test(big), big);

  console.log('\n[E] 歷史長條也分三段（不能全部畫紅的）');
  const bars = await p2.$$eval('.hrow .hbar i', (e) => e.map((x) => x.className));
  check('每天 1,8xx：超過上限 1,764 但沒超過 TDEE 2,064 -> 全是黃的',
    bars.length > 0 && bars.every((c) => c === 'mid'), bars);
  const vals = await p2.$$eval('.hrow .v', (e) => e.map((x) => x.className));
  check('數字也是黃的，不是紅的', vals.every((c) => /mid/.test(c)), vals);
  await p2.screenshot({ path: '/tmp/pace-hist.png', clip: { x: 0, y: 0, width: 390, height: 560 } });

  console.log('\n[E2] 真的超過 TDEE 的那天才是紅的');
  await post(u, D(-1), 2400);
  await p2.reload({ waitUntil: 'networkidle' });
  await p2.waitForTimeout(1500);
  await p2.click('[data-nav="history"]');
  await p2.waitForTimeout(2500);
  const bars2 = await p2.$$eval('.hrow .hbar i', (e) => e.map((x) => x.className));
  check('出現一根紅的', bars2.filter((c) => c === 'over').length === 1, bars2);
  check('其他還是黃的', bars2.filter((c) => c === 'mid').length >= 5, bars2);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
