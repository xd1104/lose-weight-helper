/* 運動 AI 估算測試 */
const { chromium } = require('playwright');
const { seedUser } = require('./_setup');
const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}

(async () => {
  await seedUser();   // 測試之間必須隔離，不然資料會累加
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  let seen = null;
  await p.route('https://api.anthropic.com/**', (r) => {
    seen = JSON.parse(r.request().postData());
    return r.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({
          name: '飛輪 45 分', detail: '以 78kg、中等強度（MET 7.0）、45 分鐘估算，已扣除靜息代謝',
          kcal: 351, met: 7.0, confidence: 'medium',
        }) }],
        usage: { input_tokens: 400, output_tokens: 90 },
      }) });
  });

  await p.goto('http://localhost:3619/', { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const tile = await p.$('.picker-tile[data-pick]');
  if (tile) { await tile.click(); await p.waitForTimeout(1600); }

  console.log('\n[1] 運動 sheet 有 AI 入口');
  await p.click('[data-act="add-move"]');
  await p.waitForTimeout(500);
  check('有「讓 AI 估消耗」按鈕', !!(await p.$('[data-ai-move]')));
  await p.screenshot({ path: '/tmp/move-1.png' });

  console.log('\n[2] 空白時按下去要擋，不能送出空請求');
  await p.click('[data-ai-move]');
  await p.waitForTimeout(600);
  check('沒有送出請求', seen === null, seen && '有送出');

  console.log('\n[3] 打一個清單裡沒有的運動 → AI 估算');
  await p.fill('#mv-name', '飛輪 45 分鐘，教練課很操');
  await p.click('[data-ai-move]');
  await p.waitForTimeout(1200);
  check('有送出請求', !!seen);
  const userMsg = seen && seen.messages[0].content[0].text;
  check('請求裡帶了體重（運動消耗跟體重高度相關）', /78 公斤/.test(userMsg || ''), userMsg);
  check('請求裡帶了年齡與性別', /歲/.test(userMsg || '') && /男性|女性/.test(userMsg || ''), userMsg);
  check('system 有要求「淨消耗」', /淨消耗/.test(seen.system || ''));
  check('用 structured outputs', !!(seen.output_config && seen.output_config.format));

  const kcalVal = await p.inputValue('#mv-kcal');
  check('熱量自動填入 351', kcalVal === '351', kcalVal);
  const nameVal = await p.inputValue('#mv-name');
  check('名稱被整理成「飛輪 45 分」', nameVal === '飛輪 45 分', nameVal);
  const detail = await p.textContent('#mv-detail');
  check('顯示 AI 的假設（MET／體重／時長）', /MET/.test(detail || '') && /78kg/.test(detail || ''), detail);
  check('標示把握度', !!(await p.$('#mv-detail .conf')));
  await p.screenshot({ path: '/tmp/move-2.png' });

  console.log('\n[4] 數字可以先改再存');
  await p.fill('#mv-kcal', '300');
  await p.click('#f-move button[type="submit"]');
  await p.waitForTimeout(1400);
  /* v6.4：運動也是「一列一項」的其中一列，預設收起來——摘要那一列就寫得出總消耗 */
  const burn = await p.textContent('.meal-row.burn .k').catch(() => '');
  check('存進今天，且是改過的 300', /300/.test(burn || ''), burn);
  check('寫成負的（是消耗不是攝取）', /−/.test(burn || ''), burn);

  console.log('\n[5] 做過的運動下次會出現在快速選擇');
  await p.click('.meal-row.burn'); await p.waitForTimeout(400);   /* v6.4：先展開才有「＋ 再記一筆」 */
  await p.click('[data-act="add-move"]');
  await p.waitForTimeout(500);
  const chips = await p.$$eval('[data-mp]', (e) => e.map((x) => x.textContent.trim()));
  check('「飛輪 45 分」出現在清單', chips.includes('飛輪 45 分'), chips);
  const mineCls = await p.$eval('[data-mp="0"]', (e) => e.className);
  check('自己做過的有不同樣式（.mine）', /mine/.test(mineCls), mineCls);
  await p.click('[data-mp="0"]');
  await p.waitForTimeout(300);
  check('點下去帶入熱量 300', (await p.inputValue('#mv-kcal')) === '300');
  await p.screenshot({ path: '/tmp/move-3.png' });

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過' : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
