/* AI 全流程測試：攔截 api.anthropic.com 回一份真實形狀的回應，
 * 驗證 request body 正確 + 結果預覽 + 編輯 + 寫入當天 + 常吃清單 + 用量統計 */
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  let seenRequest = null;
  await p.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    seenRequest = { headers: req.headers(), body: JSON.parse(req.postData()) };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({
          items: [
            { name: '排骨便當的排骨', portion: '一塊約 120g，炸過', kcal: 380, protein: 26, carbs: 12, fat: 25, confidence: 'medium' },
            { name: '白飯（加飯）', portion: '約 1.5 碗、340g', kcal: 480, protein: 9, carbs: 106, fat: 1, confidence: 'high' },
            { name: '便當配菜', portion: '滷蛋＋高麗菜＋酸菜', kcal: 160, protein: 8, carbs: 10, fat: 10, confidence: 'low' },
          ],
          note: '炸排骨的吸油量抓中間值，實際可能再高 80 大卡。',
        }) }],
        usage: { input_tokens: 1420, output_tokens: 260, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    });
  });

  await p.goto('http://localhost:3619/', { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('cal_anthropic_key', 'sk-ant-test-key'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  await p.click('.fab');
  await p.waitForTimeout(300);
  await p.click('[data-tab="text"]');
  await p.fill('#i-text', '排骨便當加飯');
  await p.click('[data-meal-pick="lunch"]');
  await p.click('[data-tab="text"]');            // 切回文字 tab（換餐段會重畫）
  await p.fill('#i-text', '排骨便當加飯');
  await p.click('#f-text button[type="submit"]');
  await p.waitForTimeout(800);
  await p.screenshot({ path: '/tmp/shot-ai-result.png', fullPage: true });

  // 檢查 request 形狀
  console.log('--- request 檢查 ---');
  console.log('CORS header:', seenRequest.headers['anthropic-dangerous-direct-browser-access']);
  console.log('api key header 有帶:', !!seenRequest.headers['x-api-key']);
  console.log('anthropic-version:', seenRequest.headers['anthropic-version']);
  console.log('model:', seenRequest.body.model);
  console.log('output_config:', JSON.stringify(seenRequest.body.output_config).slice(0, 90) + '...');
  console.log('user 訊息:', JSON.stringify(seenRequest.body.messages[0].content));

  // 改一個數字（模擬使用者修正 AI 的估算）
  await p.fill('[data-f="kcal"][data-i="0"]', '300');
  await p.waitForTimeout(150);
  const btnText = await p.textContent('[data-ai="save"]');
  console.log('--- 編輯後總計即時更新 ---');
  console.log('按鈕文字:', btnText.trim());

  // 移除第三筆
  await p.click('[data-drop="2"]');
  await p.waitForTimeout(250);
  console.log('移除一筆後:', (await p.textContent('[data-ai="save"]')).trim());

  await p.click('[data-ai="save"]');
  await p.waitForTimeout(900);
  await p.screenshot({ path: '/tmp/shot-ai-added.png', fullPage: true });

  const usage = await p.evaluate(() => localStorage.getItem('cal_ai_usage'));
  console.log('--- 寫入結果 ---');
  console.log('AI 用量統計:', usage);
  console.log('console errors:', errs.length ? JSON.stringify(errs, null, 2) : 'none');
  await b.close();
})();
