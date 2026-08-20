'use strict';
/* 「開始很懶得記錄」的兩個對策（v6.3）。
 *
 * 背景（真實資料）：兩個人認真記了三週，體重反而各自 +0.54 / +0.25 kg／週。
 * 從體重反推，黏的真實 TDEE 是 1106——低於他的 BMR 1722，生理上不可能，
 * 代表平均每天至少漏記 617 大卡。而這個結論本來就算得出來，只是藏在
 * 歷史頁最下面，他們用了三週從來沒看過。
 *
 *   A. 校準摘要要出現在「今天」頁，而且要講得出漏記多少
 *   B. 沒話要說的時候不要佔版面（公式估得準就閉嘴）
 *   C. 算不出來（資料不夠）時也不要出現
 *   D. 點下去到歷史頁看完整校準
 *   E. AI 一次回太多項 -> 預設先合併成一筆（火鍋被拆成 11 項是放棄記錄的直接原因）
 *   F. 「分開列出」回得去，資料沒有不見
 *   G. 項目不多時維持原本的逐項畫面
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
const shift = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const today = () => shift(0);
const dayOf = (u) => fetch(BASE + '/api/days?u=' + u + '&dates=' + today())
  .then((r) => r.json()).then((j) => (j.days[0] || {}).entries || []);

/* 種一段「認真記卻在變胖」的歷史 —— 就是黏的真實情況 */
async function seedHistory(u, kcalPerDay, w0, dW) {
  for (let i = 20; i >= 1; i--) {
    const entries = [{ id: 'e' + i, time: '12:00', meal: 'lunch', name: '午餐', kcal: kcalPerDay,
      p: 40, c: 200, f: 50, portion: '一份', src: 'manual' }];
    await fetch(BASE + '/api/days', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ u, date: shift(-i), moves: [],
        weight: Math.round((w0 + dW * (20 - i)) * 100) / 100, entries }),
    });
  }
}

(async () => {
  const u = await seedUser({ sex: 'male', age: 27, height: 168, weight: 80, activity: 1.375, goal: -300 });
  /* 平均吃 1705、體重每天 +0.077kg（≈ +0.54kg/週）＝ 反推 TDEE 會低於 BMR */
  await seedHistory(u, 1705, 79.1, 0.077);

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.addInitScript(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));

  let AI = null;
  await p.route('https://api.anthropic.com/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(AI) }],
      usage: { input_tokens: 900, output_tokens: 150 } }),
  }));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);

  console.log('\n[A] 校準摘要出現在「今天」頁，講得出漏記多少');
  await p.click('[data-nav="today"]'); await p.waitForTimeout(700);
  const brief = await p.textContent('.calib-brief').catch(() => '');
  check('今天頁看得到校準摘要 ← 原本只在歷史頁最下面，他們三週沒看過', !!brief, brief);
  check('直接點出「紀錄對不上體重」', /紀錄對不上體重/.test(brief), brief);
  check('講得出至少漏記多少大卡', /至少漏記\s*[\d,]+\s*大卡/.test(brief), brief);
  check('也講得出體重趨勢', /\+0\.\d\d\s*kg／週/.test(brief), brief);
  check('用警告色（不是綠的）', await p.$eval('.calib-brief', (e) => e.classList.contains('bad')));
  await p.screenshot({ path: '/tmp/calib-brief.png', clip: { x: 0, y: 200, width: 390, height: 500 } });

  console.log('\n[D] 點下去看完整校準');
  await p.click('.calib-brief');
  await p.waitForTimeout(2500);   // 歷史頁要先 ensureHistory()
  check('切到歷史頁', await p.$eval('[data-nav="history"]', (e) => e.classList.contains('on')));
  check('看得到完整校準區塊', !!(await p.$('.calib')));

  console.log('\n[B] 公式估得準的時候不要佔版面');
  /* 把體重改成「照計畫在掉」＝ 反推 TDEE 會貼近公式值。
     公式 TDEE 2365、平均吃 1705 -> 斜率要 (1705-2365)/7700 = -0.0857 kg/天。
     ⚠️ 一定要照日期排序去改：Object.keys 的順序不是時序，
     照那個順序指派體重會產生一條亂七八糟的趨勢線（我第一版就踩到）。 */
  await p.evaluate(() => {
    const ks = Object.keys(db.days).sort();
    ks.forEach((k, i) => {
      const d = db.days[k];
      if (d && d.weight) d.weight = Math.round((82 - 0.0857 * i) * 100) / 100;
    });
    db.profile.tdee = 0;
    render();
  });
  await p.waitForTimeout(500);
  await p.click('[data-nav="today"]'); await p.waitForTimeout(700);
  const q = await p.textContent('.calib-brief').catch(() => '');
  check('沒話說的時候就不要出現 ← 每天掛一張沒新資訊的卡片等於背景雜訊',
    !q || !/紀錄對不上/.test(q), q);

  console.log('\n[C] 資料不夠時也不要出現');
  await p.evaluate(() => { db.days = {}; render(); });
  await p.waitForTimeout(500);
  await p.click('[data-nav="today"]'); await p.waitForTimeout(600);
  check('沒有體重資料就完全不顯示', !(await p.$('.calib-brief')));

  console.log('\n[E] AI 一次回太多項 -> 預設先合併成一筆');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1800);
  const HOTPOT = ['牛肉片', '豬肉片', '貢丸', '魚餃', '蛋餃', '鴨血', '高麗菜', '金針菇', '豆腐', '冬粉', '沙茶醬'];
  AI = { items: HOTPOT.map((n, i) => ({ name: n, portion: '一份', kcal: 60 + i * 10,
    protein: 5, carbs: 6, fat: 4, confidence: 'medium' })), note: '火鍋' };
  await p.click('[data-nav="today"]'); await p.waitForTimeout(500);
  await p.click('.fab'); await p.waitForTimeout(500);
  await p.click('[data-tab="text"]'); await p.waitForTimeout(400);
  await p.fill('#i-text', '火鍋');
  await p.click('#f-text button[type="submit"]');
  await p.waitForTimeout(2000);
  check('沒有攤出 11 張卡片', (await p.$$('.ai-name')).length === 0);
  check('只要填一個名字', !!(await p.$('#mg1-name')));
  check('名字有從描述猜好', (await p.inputValue('#mg1-name')) === '火鍋', await p.inputValue('#mg1-name'));
  const total = 11 * 60 + 10 * (0 + 10) * 0 + HOTPOT.reduce((a, _, i) => a + i * 10, 0);
  check('加入鈕寫「1 筆」', /加入 1 筆/.test(await p.textContent('[data-ai="expand"]').catch(() => '') + await p.textContent('#f-mg1 button[type="submit"]')),
    await p.textContent('#f-mg1 button[type="submit"]'));
  check('總熱量算對了 (' + total + ')',
    new RegExp('共 ' + total.toLocaleString('en-US') + ' 大卡').test(await p.textContent('#f-mg1 button[type="submit"]')),
    await p.textContent('#f-mg1 button[type="submit"]'));
  check('看得到裡面有哪些東西', /牛肉片、豬肉片/.test(await p.textContent('.sheet')));

  console.log('\n[F] 「分開列出」回得去，資料沒有不見');
  await p.click('[data-ai="expand"]');
  await p.waitForTimeout(700);
  check('11 項都還在 ← 合併只是預設畫面，不是把資料丟掉',
    (await p.$$('.ai-name')).length === 11, (await p.$$('.ai-name')).length);

  console.log('\n[E2] 存進去真的只有一筆');
  await p.evaluate(() => { aiExpanded = false; drawAiResult(); });
  await p.waitForTimeout(600);
  await p.fill('#mg1-name', '涮涮鍋');
  await p.click('#f-mg1 button[type="submit"]');
  await p.waitForTimeout(2200);
  const ents = await dayOf(u);
  check('今天只多一筆', ents.length === 1, ents.map((e) => e.name));
  check('名字是他填的', ents[0] && ents[0].name === '涮涮鍋', ents[0]);
  check('熱量是全部加總', ents[0] && ents[0].kcal === total, ents[0]);
  check('份量欄留著明細 ← 之後想知道裡面有什麼還查得到',
    /共 11 樣：牛肉片、豬肉片/.test((ents[0] || {}).portion || ''), (ents[0] || {}).portion);

  console.log('\n[G] 項目不多時維持原本的逐項畫面');
  AI = { items: [
    { name: '滷肉飯', portion: '一碗', kcal: 500, protein: 12, carbs: 70, fat: 18, confidence: 'medium' },
    { name: '燙青菜', portion: '一份', kcal: 60, protein: 2, carbs: 6, fat: 3, confidence: 'medium' },
  ], note: 'x' };
  await p.evaluate(() => closeAllSheets());
  await p.waitForTimeout(300);
  await p.click('.fab'); await p.waitForTimeout(400);
  await p.click('[data-tab="text"]'); await p.waitForTimeout(300);
  await p.fill('#i-text', '滷肉飯');
  await p.click('#f-text button[type="submit"]');
  await p.waitForTimeout(2000);
  check('兩項照樣逐項列出', (await p.$$('.ai-name')).length === 2);
  check('沒有跳出合併畫面', !(await p.$('#mg1-name')));

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
