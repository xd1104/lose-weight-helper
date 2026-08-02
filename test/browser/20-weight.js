'use strict';
/* 體重要能輸入小數點後第二位（有些體重計是 0.05 kg 一格，會顯示 59.45）。
 * 以前兩個地方擋住：
 *   input 的 step="0.1"（step 不是提示，是驗證——不符合就被瀏覽器擋下來不給送出），
 *   以及 cleanProfile 把 profile.weight 用 round() 進位成整數。
 *   A. 今天的體重打 59.45 存得進去、也顯示得出來
 *   B. 真的落到檔案裡（不是只留在畫面上）
 *   C. 身體資料的體重也留得住小數（以前打 62.35 會變成 62）
 *   D. 整數與一位小數不要變成 59.00 / 59.40
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
const txt = async (p, sel) => (await p.textContent(sel).catch(() => '')) || '';
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const core = (u) => fetch(BASE + '/api/core?u=' + u).then((r) => r.json());
const day = (u) => fetch(BASE + '/api/days?u=' + u + '&dates=' + today()).then((r) => r.json());

(async () => {
  const u = await seedUser({ weight: 80 });
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);

  console.log('\n[A] 今天的體重打 59.45');
  await p.click('[data-act="edit-weight"]');
  await p.waitForTimeout(600);
  check('輸入框允許到 0.01', (await p.getAttribute('#w-val', 'step')) === '0.01',
    await p.getAttribute('#w-val', 'step'));
  await p.fill('#w-val', '59.45');
  /* step 不符時瀏覽器會擋下 submit，valid 會是 false —— 這就是他遇到的那個「不能輸入」 */
  check('瀏覽器認為這個值合法（不合法就送不出去）',
    await p.$eval('#w-val', (el) => el.checkValidity()));
  await p.click('#f-weigh button[type="submit"]');
  await p.waitForTimeout(1800);
  check('體重卡顯示 59.45（沒有被砍成 59.5）',
    /59\.45/.test(await txt(p, '.weigh-mid')), await txt(p, '.weigh-mid'));

  console.log('\n[B] 真的存進檔案');
  const d1 = await day(u);
  check('當天的紀錄是 59.45', (d1.days[0] || {}).weight === 59.45, (d1.days[0] || {}).weight);
  const c1 = await core(u);
  check('順便同步進身體資料，也是 59.45', c1.profile.weight === 59.45, c1.profile.weight);

  console.log('\n[C] 身體資料自己改也留得住');
  await openSet(p, 'body');
  const wIn = await p.$('[data-num="weight"]');
  check('身體資料的體重也允許到 0.01',
    (await wIn.getAttribute('step')) === '0.01', await wIn.getAttribute('step'));
  await wIn.fill('62.35');
  await wIn.dispatchEvent('change');
  await p.waitForTimeout(1500);
  const c2 = await core(u);
  check('62.35 不會被進位成 62 ← 這就是原本的 bug', c2.profile.weight === 62.35, c2.profile.weight);

  console.log('\n[D] 整數與一位小數不要多印零');
  await p.evaluate(() => closeAllSheets());
  await p.waitForTimeout(400);
  check('顯示 62.35', /62\.35/.test(await txt(p, '[data-sec="body"]')), await txt(p, '[data-sec="body"]'));
  const shown = await p.evaluate(() => [kgTxt(59), kgTxt(59.4), kgTxt(59.45), kgTxt(59.456)]);
  check('59 -> 59.0、59.4 -> 59.4、59.45 -> 59.45、59.456 -> 59.46',
    JSON.stringify(shown) === JSON.stringify(['59.0', '59.4', '59.45', '59.46']), shown);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
