'use strict';
/* 首頁改版：主角從「今天吃了幾大卡」換成「這兩週體重怎麼走」（v6.4）。
 *
 * 為什麼改：他們兩個認真記了三週，體重反而各自 +0.54 / +0.25 kg／週。
 * 每天盯著的那個大圓環（今天還可以吃幾大卡），跟他們真正要的結果沒有對上；
 * 而真正對得上的那條線，本來藏在歷史頁。所以把它拉到最上面，
 * 熱量降級成一條，食物細項收起來。
 *
 * ⚠️ 這是「換順序與呈現」，不是砍功能——每一項都還在，只是位置變了。
 *
 *   A. 最上面是體重趨勢，講得出 kg／週 跟照這個速度一個月會怎樣
 *   B. 在瘦＝綠、在胖＝黃（顏色不能只是裝飾）
 *   C. 點趨勢圖 -> 歷史頁（而且不會卡在「讀取紀錄中…」）
 *   D. 熱量還在，只是降級成一條，而且排在體重後面
 *   E. 三大營養素搬去「營養」頁，首頁在明細留一個寫得出蛋白質差多少的入口
 *   F. 每一餐一列、一律預設收起來、點開才有細項（＋「再記一筆」）
 *   G. 運動也是同一張卡的一列，不再自己一張卡
 *   H. 體重不夠 3 筆時不畫趨勢圖（畫不出趨勢就不要留一張空卡）
 *   I. 舊功能都還在：講評、備註、日期切換、FAB
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

/* 種一段體重：dW 是每天的變化量（正的＝在胖） */
async function seedWeights(u, n, w0, dW, kcalPerDay) {
  for (let i = n; i >= 0; i--) {
    const entries = kcalPerDay ? [{ id: 'e' + i, time: '12:00', meal: 'lunch', name: '午餐',
      kcal: kcalPerDay, p: 40, c: 200, f: 50, portion: '一份', src: 'manual' }] : [];
    await fetch(BASE + '/api/days', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ u, date: shift(-i), moves: [],
        weight: Math.round((w0 + dW * (n - i)) * 100) / 100, entries }),
    });
  }
}

(async () => {
  /* 27歲 168cm 80kg 久坐 -300 -> BMR 1720 / TDEE 2064 / 每日上限 1764 */
  const u = await seedUser({ sex: 'male', age: 27, height: 168, weight: 80, activity: 1.2, goal: -300 });
  await seedWeights(u, 20, 79.0, 0.077, 1600);   /* 每天 +0.077kg ≈ +0.54 kg／週 */

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);

  const txt = (sel) => p.textContent(sel).then((t) => (t || '').replace(/\s+/g, ' ').trim()).catch(() => '');
  const topOf = (sel) => p.$eval(sel, (e) => e.getBoundingClientRect().top).catch(() => -1);

  console.log('\n[A] 最上面是體重趨勢');
  const trend = await txt('.trend');
  check('首頁有趨勢卡', !!trend, trend);
  check('講得出每週幾公斤', /\+0\.5\s*kg／週/.test(trend), trend);
  check('也講得出照這個速度一個月會怎樣 ← 「每週 0.5」很難有感，「一個月 2.3 公斤」才有',
    /一個月\s*\+2\.3 kg/.test(trend), trend);
  check('寫得出從哪天以來', /以來/.test(trend), trend);
  check('趨勢卡排在熱量卡前面 ← 這就是這次改版的重點',
    (await topOf('.trend')) < (await topOf('.eatcard')),
    { trend: await topOf('.trend'), eat: await topOf('.eatcard') });
  await p.screenshot({ path: '/tmp/home-v64.png', fullPage: true });

  console.log('\n[B] 在胖是黃的、在瘦是綠的');
  check('在胖 -> 黃', await p.$eval('.trend .rate', (e) => e.classList.contains('up')));
  const upStroke = await p.$eval('.tchart polyline', (e) => e.getAttribute('stroke'));
  check('線也是黃的（顏色不是裝飾）', /--warn/.test(upStroke), upStroke);
  /* 換成在瘦的曲線 */
  await p.evaluate(() => {
    Object.keys(db.days).sort().forEach((k, i) => {
      if (db.days[k] && db.days[k].weight) db.days[k].weight = Math.round((82 - 0.09 * i) * 100) / 100;
    });
    render();
  });
  await p.waitForTimeout(500);
  check('在瘦 -> 綠', await p.$eval('.trend .rate', (e) => e.classList.contains('dn')));
  check('線也是綠的', /--acc/.test(await p.$eval('.tchart polyline', (e) => e.getAttribute('stroke'))));
  check('數字用「−」不是「-」', /−0\.\d/.test(await txt('.trend .rate')), await txt('.trend .rate'));

  console.log('\n[C] 點趨勢圖 -> 歷史頁');
  await p.click('.trend');
  await p.waitForTimeout(2500);          /* 歷史頁要先 ensureHistory() */
  check('切到歷史頁', await p.$eval('[data-nav="history"]', (e) => e.classList.contains('on')));
  check('不會卡在「讀取紀錄中…」 ← 程式自己切 view 不會觸發導覽列的 ensureHistory()',
    !/讀取紀錄中/.test(await txt('#app')));
  check('看得到每天的長條', (await p.$$('.hrow')).length > 5, (await p.$$('.hrow')).length);
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(900);

  console.log('\n[D] 熱量還在，只是降級成一條');
  const eat = await txt('.eatcard');
  check('看得到今天吃了多少', /1,600/.test(eat), eat);
  check('看得到上限', /1,764/.test(eat), eat);
  check('看得到還可以吃多少', /164/.test(eat) && /可以吃/.test(eat), eat);
  check('是一條，不是圓環', !!(await p.$('.eatbar i')) && !(await p.$('.ring')));

  console.log('\n[E] 三大營養素搬去「營養」頁，首頁留一個入口');
  check('首頁沒有三大方塊', (await p.$$('.macro')).length === 0);
  check('收合時也不顯示 TDEE（版面留給每天真的要看的）',
    !(await p.$$eval('.kv', (e) => e.filter((x) => /TDEE/.test(x.textContent)).length)));
  await p.click('[data-act="toggle-detail"]');
  await p.waitForTimeout(500);
  const link = await txt('.detail [data-nav2="macros"]');
  check('明細裡有入口', !!link, link);
  check('入口就寫出蛋白質差多少 ← 不用點進去才知道', /蛋白\s*\d+／\d+\s*g/.test(link), link);
  check('明細裡看得到 TDEE', /2,064/.test(await txt('.detail')), await txt('.detail'));
  await p.click('.detail [data-nav2="macros"]');
  await p.waitForTimeout(800);
  check('點下去真的到營養頁', (await p.$$('.mcard .mrow')).length === 3);
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(800);

  console.log('\n[F] 每一餐一列，預設收起來');
  const rows = await p.$$eval('.meal-row', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  check('四餐＋運動五列', rows.length === 5, rows);
  check('午餐那列直接寫出吃了什麼、多少大卡', /午餐/.test(rows[1]) && /1,600/.test(rows[1]), rows[1]);
  check('沒記的那幾餐寫「還沒記」', (await p.$$('.meal-row.none')).length === 4);
  check('預設一項細項都不列 ← 首頁不該被十幾筆食物佔滿',
    (await p.$$('.row.sub[data-act="edit-entry"]')).length === 0);
  await p.click('.meal-row[data-meal="lunch"]');
  await p.waitForTimeout(500);
  check('點一下展開', (await p.$$('.row.sub[data-act="edit-entry"]')).length === 1);
  check('展開後底下有「＋ 再記一筆」', !!(await p.$('.row.sub.add')));
  await p.click('.meal-row[data-meal="lunch"]');
  await p.waitForTimeout(500);
  check('再點一次收回去', (await p.$$('.row.sub[data-act="edit-entry"]')).length === 0);
  check('空的那幾列點下去是直接開「記一筆」', !!(await p.$('.meal-row.none[data-act="add"]')));

  console.log('\n[G] 運動也是同一張卡的一列');
  await fetch(BASE + '/api/days', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, date: today(), weight: 80.5,
      entries: [{ id: 'x1', time: '12:00', meal: 'lunch', name: '午餐', kcal: 1600, p: 40, c: 200, f: 50, src: 'manual' }],
      moves: [{ id: 'm1', time: '19:00', name: '跑步', kcal: 300 }] }),
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2200);
  const mv = await txt('.meal-row.burn');
  check('運動在同一張卡上', !!mv, mv);
  check('寫成負的（是消耗不是攝取）', /−300/.test(mv), mv);
  check('不再有孤零零的「還沒記」chip 區', !(await p.$('.addchips')));
  await p.click('.meal-row.burn');
  await p.waitForTimeout(500);
  check('點開看得到那一筆運動', !!(await p.$('.row.sub[data-act="edit-move"]')));

  console.log('\n[H] 體重不夠時不要留一張空卡');
  const u2 = await seedUser({ sex: 'male', age: 27, height: 168, weight: 80, activity: 1.2, goal: -300 });
  await seedWeights(u2, 1, 80, -0.1, 1600);      /* 只有兩筆 */
  const q = await b.newPage({ viewport: { width: 390, height: 844 } });
  q.on('pageerror', (e) => errs.push(e.message));
  await q.addInitScript((id) => localStorage.setItem('lwh_user', id), u2);
  await q.goto(BASE + '/', { waitUntil: 'networkidle' });
  await q.waitForTimeout(2500);
  check('兩筆體重畫不出趨勢，就完全不出現', !(await q.$('.trend')));
  check('但體重那一列還在（記錄的入口不能跟著消失）', !!(await q.$('.weigh')));
  check('熱量那條也還在', !!(await q.$('.eatcard')));

  console.log('\n[I] 舊功能都還在');
  const app = await q.textContent('#app');
  check('備註還在', /備註/.test(app));
  check('營養師講評還在', /今天吃得怎樣/.test(app) || !!(await q.$('.coach-btn')));
  check('日期左右切換還在', !!(await q.$('[data-act="prev-day"]')) && !!(await q.$('[data-act="next-day"]')));
  check('FAB 還在', !!(await q.$('.fab')));
  check('四個分頁都還在', (await q.$$('.nav button')).length === 4);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
