/* 多使用者流程測試：建兩個人 -> 各自記錄 -> 確認資料互不干擾 */
const { chromium } = require('playwright');
const { clearAll } = require('./_setup');

const MOCK = (items, note) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ items, note }) }],
  usage: { input_tokens: 1400, output_tokens: 250 },
});

(async () => {
  await clearAll();   // 測試之間必須隔離，不然資料會累加
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  let mockItems = [];
  await p.route('https://api.anthropic.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(MOCK(mockItems, '測試假設')),
  }));

  await p.goto('http://localhost:3619/', { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.screenshot({ path: '/tmp/m1-first.png', fullPage: true });
  console.log('1. 首次開啟標題:', (await p.textContent('.picker-head h1')).trim());

  // 建立 Benson
  await p.click('[data-act="new-user"]');
  await p.waitForTimeout(300);
  await p.fill('#u-name', 'Benson');
  await p.click('[data-uemoji="🐻"]');
  await p.waitForTimeout(200);
  await p.fill('#u-name', 'Benson');
  await p.click('#f-user button[type="submit"]');
  await p.waitForTimeout(1500);
  // v2.1 起建完使用者會自動跳身體資料設定，先關掉才點得到後面的東西
  await p.click('[data-sheet="close"]').catch(() => {});
  await p.waitForTimeout(400);
  console.log('2. 建完 Benson，頁首:', (await p.textContent('.head h1')).trim());

  // Benson 記一筆
  mockItems = [{ name: '排骨便當', portion: '一個便當盒', kcal: 900, protein: 30, carbs: 110, fat: 32, confidence: 'medium' }];
  await p.click('.fab');
  await p.waitForTimeout(300);
  await p.click('[data-tab="text"]');
  await p.fill('#i-text', '排骨便當');
  await p.click('#f-text button[type="submit"]');
  await p.waitForTimeout(900);
  await p.click('[data-ai="save"]');
  await p.waitForTimeout(900);
  const bensonTotal = (await p.textContent('.kv.eat b')).trim();
  console.log('3. Benson 已攝取:', bensonTotal);

  // 切換 -> 建立小美
  await p.click('.me-btn');
  await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/m2-picker.png', fullPage: true });
  await p.click('[data-act="new-user"]');
  await p.waitForTimeout(300);
  await p.fill('#u-name', '小美');
  await p.click('[data-ucolor="#e0447f"]');
  await p.waitForTimeout(200);
  await p.fill('#u-name', '小美');
  await p.click('[data-uemoji="🌸"]');
  await p.waitForTimeout(200);
  await p.fill('#u-name', '小美');
  await p.click('#f-user button[type="submit"]');
  await p.waitForTimeout(1600);
  await p.click('[data-sheet="close"]').catch(() => {});
  await p.waitForTimeout(400);
  console.log('4. 切到小美，頁首:', (await p.textContent('.head h1')).trim());
  console.log('   小美已攝取（應為 0）:', (await p.textContent('.kv.eat b')).trim());

  // 小美設定：女性、不同體重 -> 目標應不同
  await p.click('[data-nav="settings"]');
  await p.waitForTimeout(400);
  await p.click('[data-set="sex"][data-val="female"]');
  await p.waitForTimeout(500);
  await p.fill('[data-num="weight"]', '52');
  await p.dispatchEvent('[data-num="weight"]', 'change');
  await p.waitForTimeout(600);
  await p.fill('[data-num="height"]', '160');
  await p.dispatchEvent('[data-num="height"]', 'change');
  await p.waitForTimeout(600);
  await p.click('[data-set="goal"][data-val="-300"]');
  await p.waitForTimeout(600);
  await p.screenshot({ path: '/tmp/m3-settings.png', fullPage: true });
  const boxes = await p.$$eval('.tdee-box .r b', (els) => els.map((e) => e.textContent.trim()));
  console.log('5. 小美 BMR/TDEE/目標:', boxes.join(' / '));

  // 切回 Benson 確認資料還在、且沒被小美的設定污染
  await p.click('.me-btn');
  await p.waitForTimeout(400);
  const tiles = await p.$$eval('.picker-tile b', (els) => els.map((e) => e.textContent.trim()));
  console.log('6. 選人畫面上的人:', JSON.stringify(tiles));
  await p.screenshot({ path: '/tmp/m4-picker2.png', fullPage: true });
  const bensonId = await p.$eval('.picker-tile[data-pick]', (el) => el.getAttribute('data-pick'));
  await p.click(`[data-pick="${bensonId}"]`);
  await p.waitForTimeout(1300);
  console.log('7. 切回', (await p.textContent('.head h1')).trim(), '已攝取:', (await p.textContent('.kv.eat b')).trim());
  await p.click('[data-nav="settings"]');
  await p.waitForTimeout(500);
  const b2 = await p.$$eval('.tdee-box .r b', (els) => els.map((e) => e.textContent.trim()));
  console.log('   Benson BMR/TDEE/目標（應與小美不同）:', b2.join(' / '));
  await p.screenshot({ path: '/tmp/m5-benson-settings.png', fullPage: true });

  console.log('console errors:', errs.length ? JSON.stringify(errs, null, 2) : 'none');
  await b.close();
})();
