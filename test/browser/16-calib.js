'use strict';
/* TDEE 校準：公式估的是族群平均，體重趨勢才是這個人真正的消耗。
 *   A. 資料不夠時不亂算，講清楚還差什麼，而且給一個直接去量的入口
 *   B. 體重紀錄沒跨滿兩週 -> 不算（十天內的體重是水分在動，不是脂肪）
 *   C. 資料夠了：真實 TDEE = 平均淨攝取 + 每天掉的體重 × 7700
 *   D. 一鍵套用會寫進「手動覆寫 TDEE」，每日上限跟著變
 *   E. 套用後看得出「已校準」，也回得去公式
 *   F. 今天還沒量時體重卡自己變提醒；快湊滿門檻時把「還差幾次」講出來
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
const put = (u, dt, body) => fetch(BASE + '/api/days', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.assign({ u, date: dt, entries: [], moves: [] }, body)),
});
const eat = (kcal) => ({ entries: [{ id: 'e1', name: '一天', kcal, p: 100, c: 180, f: 55, meal: 'lunch' }] });

const txt = async (p, sel) => (await p.textContent(sel).catch(() => '')) || '';
const gotoHist = async (p) => { await p.click('[data-nav="history"]'); await p.waitForTimeout(2600); };

(async () => {
  /* Benson 的設定：BMR 1,720 / 公式 TDEE 2,064 / 每日上限 1,764 */
  const u = await seedUser({ age: 27, height: 168, weight: 80, activity: 1.2, goal: -300 });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errs = [];
  const newPage = async () => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
    return p;
  };

  console.log('\n[A] 體重不夠 -> 不亂算，講清楚還差幾筆');
  for (let i = 0; i <= 20; i++) await put(u, D(-20 + i), eat(1600));
  await put(u, D(-20), Object.assign(eat(1600), { weight: 80.0 }));
  await put(u, D(-10), Object.assign(eat(1600), { weight: 79.5 }));
  let p = await newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);
  await gotoHist(p);
  let card = await txt(p, '.calib');
  check('校準卡在歷史頁（體重趨勢圖旁邊）', !!card, card);
  check('沒有硬算出一個 TDEE', !/真實 TDEE 約/.test(card), card);
  check('說還差 4 筆體重', /還差 4 筆體重紀錄/.test(card), card);
  check('有直接去量的入口', !!(await p.$('[data-act="weigh-today"]')));
  await p.screenshot({ path: '/tmp/calib-todo.png', clip: { x: 0, y: 260, width: 390, height: 500 } });

  console.log('\n[A2] 那顆按鈕會跳回今天並打開體重輸入');
  await p.click('[data-act="weigh-today"]');
  await p.waitForTimeout(700);
  check('開了體重 sheet', !!(await p.$('#w-val')), await txt(p, '.sheet h3'));
  check('而且切回今天', /今天/.test(await txt(p, '.daynav .date')));

  console.log('\n[B] 體重夠了、但全擠在一週內 -> 還是不算');
  for (let i = 0; i <= 5; i++) await put(u, D(-5 + i), Object.assign(eat(1600), { weight: 80 - i * 0.1 }));
  await put(u, D(-10), eat(1600));   // 清掉前面那筆遠一點的體重
  await put(u, D(-20), eat(1600));
  p = await newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);
  await gotoHist(p);
  card = await txt(p, '.calib');
  check('6 筆但只跨 5 天 -> 不算', !/真實 TDEE 約/.test(card), card);
  check('說要跨滿兩週、還差幾天', /跨滿兩週/.test(card) && /再過 8 天/.test(card), card);

  console.log('\n[C] 資料夠了 -> 反推真實 TDEE');
  /* 21 天每天淨攝取 1,600；體重每 2 天量一次、每天掉 0.05 kg（一週 −0.35）
   * -> 真實 TDEE = 1,600 + 0.05×7700 = 1,985（公式估 2,064，多估了 79） */
  for (let i = 0; i <= 20; i++) {
    const w = i % 2 === 0 ? { weight: Math.round((80 - 0.05 * i) * 10) / 10 } : {};
    await put(u, D(-20 + i), Object.assign(eat(1600), w));
  }
  p = await newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);
  await gotoHist(p);
  card = await txt(p, '.calib');
  check('算出 1,985 大卡', /真實 TDEE 約 1,985 大卡/.test(card), card);
  check('列出平均淨攝取 1,600', /1,600 大卡/.test(card), card);
  check('列出體重趨勢 −0.35 kg／週', /−0\.35 kg／週/.test(card), card);
  check('說明目前用的是公式 2,064', /2,064 大卡（公式）/.test(card), card);
  check('講出差多少：少 79 大卡', /比 app 現在用的少 79 大卡/.test(card), card);
  check('講出套用後的每日上限 1,685', /上限會變成 1,685 大卡/.test(card), card);
  check('沒有亂噴警告（21 天全有記錄、也高於 BMR）', !(await p.$('.calib-warn')), await txt(p, '.calib-warn'));
  await p.screenshot({ path: '/tmp/calib-hist.png', clip: { x: 0, y: 0, width: 390, height: 844 } });

  console.log('\n[D] 一鍵套用 -> 寫進手動覆寫 TDEE，每日上限跟著變');
  await p.click('[data-act="apply-calib"]');
  await p.waitForTimeout(900);
  const prof = await (await fetch(BASE + '/api/core?u=' + u)).json();
  check('存進 profile.tdee', prof.profile.tdee === 1985, prof.profile.tdee);
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(600);
  await p.click('[data-act="toggle-detail"]');
  await p.waitForTimeout(400);
  const detail = await txt(p, '.detail');
  check('首頁 TDEE 變成 1,985', /1,985/.test(detail), detail);
  /* v6.4：「每日上限」跟著熱量從圓環搬到那一條上，不用展開就看得到 */
  const foot = await txt(p, '.eatfoot');
  check('每日上限變成 1,685', /1,685/.test(foot), foot);

  console.log('\n[E] 套用後看得出已校準，也回得去公式');
  await gotoHist(p);
  card = await txt(p, '.calib');
  check('標成「已校準」', /1,985 大卡（已校準）/.test(card), card);
  check('校準後差距歸零、不再叫你再套一次', !(await p.$('[data-act="apply-calib"]')) && /不用改/.test(card), card);
  check('留了回頭路', /改回公式估算（2,064 大卡）/.test(await txt(p, '[data-act="clear-calib"]')));
  await p.click('[data-act="clear-calib"]');
  await p.waitForTimeout(900);
  const prof2 = await (await fetch(BASE + '/api/core?u=' + u)).json();
  check('改回公式 = tdee 歸 0', prof2.profile.tdee === 0, prof2.profile.tdee);

  console.log('\n[F] 今天還沒量 -> 體重卡自己變提醒');
  await put(u, D(0), eat(1600));      // 把今天的體重清掉
  p = await newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);
  check('體重卡是提醒狀態', /todo/.test((await p.getAttribute('.weigh', 'class')) || ''),
    await p.getAttribute('.weigh', 'class'));
  check('先講怎麼量最準', /早上起床空腹量最準/.test(await txt(p, '.weigh-mid span')), await txt(p, '.weigh-mid span'));

  console.log('\n[F2] 快湊滿門檻時改講「還差幾次」（有動力）');
  const u2 = await seedUser({ age: 27, height: 168, weight: 80, activity: 1.2, goal: -300 });
  for (let i = 0; i <= 20; i++) await put(u2, D(-20 + i), eat(1600));
  for (const [d, w] of [[-20, 80.0], [-15, 79.8], [-10, 79.6]]) {
    await put(u2, D(d), Object.assign(eat(1600), { weight: w }));
  }
  const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const q = await ctx2.newPage();
  q.on('pageerror', (e) => errs.push(e.message));
  await q.addInitScript((id) => localStorage.setItem('lwh_user', id), u2);
  await q.goto(BASE + '/', { waitUntil: 'networkidle' });
  await q.waitForTimeout(1400);
  check('還沒翻過歷史時不亂講次數（手上只有 7 天資料）',
    /早上起床空腹量最準/.test(await txt(q, '.weigh-mid span')), await txt(q, '.weigh-mid span'));
  await gotoHist(q);
  await q.click('[data-nav="today"]');
  await q.waitForTimeout(600);
  check('翻過歷史之後講「再量 3 次就能校準」',
    /再量 3 次就能校準你的 TDEE/.test(await txt(q, '.weigh-mid span')), await txt(q, '.weigh-mid span'));
  await q.screenshot({ path: '/tmp/calib-weigh.png', clip: { x: 0, y: 0, width: 390, height: 560 } });

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
