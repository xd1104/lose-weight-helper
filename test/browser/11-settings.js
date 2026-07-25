'use strict';
/* 設定頁改成索引式（一列一個主題，點進去才是完整控制項）之後的行為測試。
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, seedUser, openSet, closeSet } = require('./_setup');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}

(async () => {
  const u = await seedUser({ age: 32, height: 175, weight: 78, activity: 1.375, goal: -400 });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => {
    localStorage.setItem('lwh_user', id);
    localStorage.setItem('lwh_anthropic_key', 'sk-ant-test');
  }, u);
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.click('[data-nav="settings"]');
  await p.waitForTimeout(700);

  console.log('\n[1] 索引：一頁看得完，每一列右邊直接寫目前值');
  const rows = await p.$$eval('.set-row', (els) => els.map((e) => ({
    label: e.querySelector('b').childNodes[0].textContent.trim(),
    sum: (e.querySelector('b span') || {}).textContent || '',
    h: e.getBoundingClientRect().height,
    sec: e.getAttribute('data-sec'),
  })));
  check('列出所有主題', rows.length >= 7, rows.map((r) => r.label));
  check('每一列都有摘要', rows.every((r) => r.sum.trim().length > 0), rows.map((r) => r.label + '=' + r.sum));
  check('每一列都 ≥ 44px（iOS 觸控目標）', rows.every((r) => r.h >= 44), rows.map((r) => r.h));

  const body = rows.filter((r) => r.sec === 'body')[0];
  check('身體資料摘要含性別年齡身高體重', /男/.test(body.sum) && /32 歲/.test(body.sum) && /175/.test(body.sum) && /78/.test(body.sum), body.sum);
  const act = rows.filter((r) => r.sec === 'activity')[0];
  check('活動量摘要含等級與 TDEE', /輕度/.test(act.sum) && /2,365|TDEE/.test(act.sum), act.sum);
  const goal = rows.filter((r) => r.sec === 'goal')[0];
  check('自訂目標顯示實際缺口而不是「自訂」兩個字', /缺口 400/.test(goal.sum), goal.sum);

  const h = await p.evaluate(() => document.body.scrollHeight);
  check('整頁高度接近一個螢幕（原本要滑很久）', h < 1100, h);
  check('最上面直接看得到 TDEE 與每日上限', /TDEE/.test(await p.textContent('.set-me-t span')));
  await p.screenshot({ path: '/tmp/set-index.png', fullPage: true });

  console.log('\n[2] 點進去才是完整控制項');
  check('索引上沒有控制項（chip 都收在 sheet 裡）', (await p.$$('#app [data-set]')).length === 0);
  await p.click('[data-sec="body"]');
  await p.waitForTimeout(600);
  check('sheet 標題是「身體資料」', (await p.textContent('.sheet-head h2')).trim() === '身體資料');
  check('性別 chip 在 sheet 裡', !!(await p.$('#sheet-layer [data-set="sex"]')));
  check('年齡欄在 sheet 裡', !!(await p.$('#sheet-layer [data-num="age"]')));

  console.log('\n[3] 改數字：只換計算結果，不重建 input（重建會讓手機鍵盤跳掉）');
  await p.focus('[data-num="age"]');
  const before = await p.textContent('#set-live');
  await p.fill('[data-num="age"]', '45');
  await p.dispatchEvent('[data-num="age"]', 'change');
  await p.waitForTimeout(900);
  const after = await p.textContent('#set-live');
  check('BMR/TDEE 跟著變', before !== after, { before: before.replace(/\s+/g, ' '), after: after.replace(/\s+/g, ' ') });
  check('input 還在、值沒被吃掉', (await p.inputValue('[data-num="age"]')) === '45');
  const same = await p.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-num') === 'age');
  check('焦點還在同一個 input 上（元素沒被換掉）', same);

  console.log('\n[4] 改 chip：sheet 重畫，底下的索引摘要也跟著更新');
  await p.click('[data-set="sex"][data-val="female"]');
  await p.waitForTimeout(900);
  check('chip 選中狀態換過去', await p.$eval('[data-set="sex"][data-val="female"]', (e) => /on/.test(e.className)));
  await closeSet(p);
  const sum2 = await p.textContent('.set-row[data-sec="body"] b span');
  check('索引摘要變成「女 · 45 歲」', /女/.test(sum2) && /45 歲/.test(sum2), sum2);

  console.log('\n[5] 警示留在索引上（不用點進去才看得到），點了直接開對應分頁');
  await openSet(p, 'goal');
  await p.click('[data-set="goal"][data-val="-500"]');
  await p.waitForTimeout(900);
  await openSet(p, 'activity');           /* 久坐 + -500 -> 上限會低於 BMR */
  await p.click('[data-set="activity"][data-val="1.2"]');
  await p.waitForTimeout(900);
  await closeSet(p);
  const alert = await p.$('.set-alert');
  check('缺口太大時索引亮警示', !!alert, await p.textContent('.set-row[data-sec="goal"] b span'));
  check('每日目標那列有警示點', !!(await p.$('.set-row[data-sec="goal"] .wdot')));
  await alert.click();
  await p.waitForTimeout(700);
  check('點警示直接開「每日目標」', (await p.textContent('.sheet-head h2')).trim() === '每日目標');
  check('裡面有完整說明', /缺口|基礎代謝/.test(await p.textContent('.warn-box').catch(() => '')));

  console.log('\n[6] 索引摘要反映 AI 與常吃清單的狀態');
  await closeSet(p);
  const aiSum = await p.textContent('.set-row[data-sec="ai"] b span');
  check('AI 那列顯示模型', /Sonnet 5/.test(aiSum), aiSum);
  await openSet(p, 'ai');
  check('有移除 key 的按鈕（已設定時才出現）', !!(await p.$('[data-act="clear-key"]')));
  await p.click('[data-act="clear-key"]');
  await p.waitForTimeout(800);
  check('移除後 sheet 自己重畫，按鈕消失', !(await p.$('[data-act="clear-key"]')));
  await closeSet(p);
  check('索引摘要跟著變成「未設定」', /未設定/.test(await p.textContent('.set-row[data-sec="ai"] b span')));

  console.log('\n[7] 從設定分頁按「切換使用者」要真的回到選人畫面（不能被 sheet 蓋住）');
  await openSet(p, 'users');
  check('使用者清單在 sheet 裡', !!(await p.$('#sheet-layer [data-edit-user]')));
  await p.click('#sheet-layer [data-act="switch-user"]');
  await p.waitForTimeout(900);
  check('sheet 關掉了', await p.$eval('#sheet-layer', (e) => e.hidden));
  check('到了選人畫面', !!(await p.$('.picker')));
  await p.screenshot({ path: '/tmp/set-switch.png', fullPage: true });

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
