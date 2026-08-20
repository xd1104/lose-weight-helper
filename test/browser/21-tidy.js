'use strict';
/* 兩件事（Benson 的火鍋那張截圖）：
 * 1. 一鍋火鍋 AI 拆成十幾樣，午餐那一段變成一整頁
 *    A. 超過 4 項就先收起來，標題右邊的總熱量照樣是對的
 *    B. 點一下展開／收合
 *    C. AI 結果頁可以先合併成一筆再存（治本，也讓常吃清單只多一筆「火鍋」）
 * 2. 補充說明只有一行，打超過就看不到前面打的
 *    D. 會寫成一句話的欄位都改成會自己長高的 textarea
 *    E. 名稱那類欄位 Enter 還是直接送出（原本 <input> 的行為）
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

/* 火鍋：照 Benson 那張截圖的樣子，11 樣 */
const POT = [
  ['奶白湯底（湯汁本身熱量，未含火鍋料）', 150], ['白飯拌滷肉燥', 220], ['羊肉片（中份）', 420],
  ['生高麗菜(涮煮用)', 40], ['花枝漿／麻吉魚漿糰', 280], ['蟹肉棒', 50], ['秀珍菇', 10],
  ['香菇貢丸', 75], ['玉米段', 40], ['紅蘿蔔片', 20], ['蛤蜊', 60],
];
const TOTAL = POT.reduce((a, x) => a + x[1], 0);   // 1,365

(async () => {
  const u = await seedUser();
  await fetch(BASE + '/api/days', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      u, date: today(), moves: [],
      entries: POT.map((x, i) => ({
        id: 'e' + i, time: '20:04', meal: 'lunch', name: x[0], kcal: x[1],
        p: 5, c: 8, f: 3, portion: '一份', src: 'ai',
      })),
    }),
  });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  await p.route('https://api.anthropic.com/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({
        items: POT.map((x) => ({
          name: x[0], portion: '一份', kcal: x[1], protein: 5, carbs: 8, fat: 3, confidence: 'medium',
        })), note: '火鍋' }) }],
      usage: { input_tokens: 900, output_tokens: 300 },
    }),
  }));

  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.addInitScript(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);

  console.log('\n[A] 11 樣不要整頁攤開');
  /* v6.4 起不是「只列前 3 項」，而是整餐一律收成一列——首頁的主角是體重趨勢，
     食物細項本來就不該預設佔版面。摘要那一列要自己講得出吃了什麼、幾樣、多少大卡。 */
  check('預設一項都不攤開', (await p.$$('.list .row[data-act="edit-entry"]')).length === 0);
  const mealRow = await txt(p, '.meal-row[data-meal="lunch"]');
  check('那一列講得出共幾樣', /共 11 樣/.test(mealRow), mealRow);
  check('也講得出前幾樣是什麼', new RegExp(POT[0][0]).test(mealRow), mealRow);
  check('那一列的總熱量是全部 11 樣的總和',
    new RegExp(TOTAL.toLocaleString('zh-TW')).test(mealRow), mealRow);
  await p.screenshot({ path: '/tmp/tidy-fold.png', clip: { x: 0, y: 330, width: 390, height: 514 } });

  console.log('\n[B] 展開／收合');
  await p.click('.meal-row[data-meal="lunch"]');
  await p.waitForTimeout(500);
  check('展開後 11 項都在', (await p.$$('.list .row[data-act="edit-entry"]')).length === 11,
    (await p.$$('.list .row[data-act="edit-entry"]')).length);
  check('展開後底下有「＋ 再記一筆」', !!(await p.$('.row.sub.add')));
  await p.click('.meal-row[data-meal="lunch"]');
  await p.waitForTimeout(500);
  check('再點一次收回去', (await p.$$('.list .row[data-act="edit-entry"]')).length === 0);
  await p.click('[data-act="prev-day"]');
  await p.waitForTimeout(700);
  await p.click('[data-act="next-day"]');
  await p.waitForTimeout(900);
  check('換過日期再回來是收合的（展開狀態不該黏著）',
    (await p.$$('.list .row[data-act="edit-entry"]')).length === 0);

  console.log('\n[C] AI 結果頁可以先合併成一筆');
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="text"]');
  await p.waitForTimeout(300);
  await p.fill('#i-text', '火鍋 吃了很多料');
  await p.click('#f-text button[type="submit"]');
  await p.waitForTimeout(1600);
  /* v6.3 起 6 項以上「預設」就是合併的樣子——原本要自己找那顆合併鈕，
     但會被 11 項嚇到的人多半不會去按。拆開的資料沒有不見，按「分開列出」回得去。 */
  check('11 樣直接給合併好的樣子，不是攤出 11 張卡', (await p.$$('.ai-name')).length === 0);
  check('只要填一個名字', !!(await p.$('#mg1-name')));
  check('看得到裡面有什麼', /奶白湯底/.test(await txt(p, '.sheet')));
  check('熱量是加總', new RegExp('共 ' + TOTAL.toLocaleString('zh-TW') + ' 大卡')
    .test(await txt(p, '#f-mg1 button[type="submit"]')), await txt(p, '#f-mg1 button[type="submit"]'));
  await p.click('[data-ai="expand"]');
  await p.waitForTimeout(600);
  check('「分開列出」回得去，11 項都還在', (await p.$$('.ai-name')).length === 11,
    (await p.$$('.ai-name')).length);
  check('攤開後還是有手動合併鈕', !!(await p.$('[data-ai="merge"]')));
  await p.click('[data-ai="merge"]');
  await p.waitForTimeout(600);
  check('要先給名字', !!(await p.$('#mg-name')));
  await p.fill('#mg-name', '涮涮鍋');
  await p.click('#f-merge button[type="submit"]');
  await p.waitForTimeout(900);
  check('只剩一項', (await p.$$('.ai-item')).length === 1, (await p.$$('.ai-item')).length);
  check('名字是他打的', /涮涮鍋/.test(await txt(p, '.ai-name')), await txt(p, '.ai-name'));
  check('份量欄留下裡面有什麼', /共 11 樣：奶白湯底/.test(await txt(p, '.ai-item .por')), await txt(p, '.ai-item .por'));
  check('併完就不再給合併鈕', !(await p.$('[data-ai="merge"]')));
  await p.click('[data-ai="save"]');
  await p.waitForTimeout(1800);
  const core = await (await fetch(BASE + '/api/core?u=' + u)).json();
  check('常吃清單只多一筆「涮涮鍋」',
    core.foods.filter((f) => f.name === '涮涮鍋').length === 1, core.foods.map((f) => f.name));

  console.log('\n[D] 補充說明不再是一行（打長了看得到全部）');
  await p.evaluate(() => closeAllSheets());
  await p.waitForTimeout(400);
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="photo"]');
  await p.waitForTimeout(400);
  const hint = await p.$('#i-hint');
  check('補充說明是 textarea，不是單行 input',
    (await hint.evaluate((el) => el.tagName)) === 'TEXTAREA', await hint.evaluate((el) => el.tagName));
  const h1 = await hint.evaluate((el) => el.clientHeight);
  await hint.fill('這碗是大碗的，白飯只吃一半，湯底是麻辣的而且我有喝掉大概三分之一，'
    + '肉是加點的兩份，另外還有一份烏龍麵最後煮的');
  await p.waitForTimeout(500);
  const h2 = await hint.evaluate((el) => el.clientHeight);
  check('打長了會自己長高（看得到全部）', h2 > h1 + 20, { h1, h2 });
  check('沒有出現捲軸（內容沒被切掉）',
    await hint.evaluate((el) => el.scrollHeight <= el.clientHeight + 2));

  console.log('\n[E] 名稱那類欄位 Enter 還是直接送出');
  await p.evaluate(() => closeAllSheets());
  await p.waitForTimeout(400);
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(400);
  const mn = await p.$('#m-name');
  check('手動的名稱也是會長高的 textarea',
    (await mn.evaluate((el) => el.tagName)) === 'TEXTAREA');
  await p.fill('#m-name', '滷肉飯');
  await p.fill('#m-kcal', '500');
  await p.focus('#m-name');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1800);
  const d2 = await (await fetch(BASE + '/api/days?u=' + u + '&dates=' + today())).json();
  const got = (d2.days[0].entries || []).filter((e) => e.name === '滷肉飯')[0];
  check('Enter 直接送出（沒有變成換行）', !!got, (d2.days[0].entries || []).map((e) => e.name));
  check('名稱裡沒有被塞進換行', got && got.name === '滷肉飯', got && got.name);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
