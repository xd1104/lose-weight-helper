/* 照片來源測試：相機 / 相簿 兩個入口都要能走完整流程 */
const { chromium } = require('playwright');
const { seedUser } = require('./_setup');
const path = require('path');
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

  let sent = 0;
  await p.route('https://api.anthropic.com/**', (r) => {
    sent++;
    return r.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({
          items: [{ name: '雞腿便當', portion: '一個便當盒', kcal: 850, protein: 32, carbs: 105, fat: 30, confidence: 'medium' }],
          note: '照片測試',
        }) }],
        usage: { input_tokens: 1500, output_tokens: 200 },
      }) });
  });

  await p.goto('http://localhost:3619/', { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const tile = await p.$('.picker-tile[data-pick]');
  if (tile) { await tile.click(); await p.waitForTimeout(1500); }

  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="photo"]');
  await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/photo-1.png' });

  console.log('\n[1] 兩個入口都在');
  check('有「拍照」按鈕', !!(await p.$('label[for="i-cam"]')));
  check('有「從相簿選」按鈕', !!(await p.$('label[for="i-lib"]')));

  console.log('\n[2] input 的 capture 屬性正確');
  const camCap = await p.getAttribute('#i-cam', 'capture');
  const libCap = await p.getAttribute('#i-lib', 'capture');
  check('相機 input 有 capture="environment"', camCap === 'environment', camCap);
  check('相簿 input 沒有 capture（有的話手機會強制開相機）', libCap === null, libCap);
  const libAccept = await p.getAttribute('#i-lib', 'accept');
  check('相簿 input accept=image/*', libAccept === 'image/*', libAccept);

  console.log('\n[3] 從相簿選一張 → 預覽 → 送出');
  const img = path.join(__dirname, 'meal.png');
  await p.setInputFiles('#i-lib', img);
  await p.waitForTimeout(1200);
  check('出現預覽圖', !!(await p.$('.photo-prev')));
  check('預覽後還能再加一張（相機）', !!(await p.$('label[for="i-cam"]')));
  check('預覽後還能再加一張（相簿）', !!(await p.$('label[for="i-lib"]')));
  check('只有一張時不排成兩欄', !(await p.$('.photo-strip.multi')));
  const disabled = await p.getAttribute('#b-photo', 'disabled');
  check('送出鈕解鎖', disabled === null, disabled);
  await p.screenshot({ path: '/tmp/photo-2.png' });

  await p.click('#b-photo');
  await p.waitForTimeout(1200);
  check('有真的送出請求', sent === 1, sent);
  check('顯示 AI 結果', !!(await p.$('[data-ai="save"]')));
  await p.click('[data-ai="save"]');
  await p.waitForTimeout(1200);
  const eaten = (await p.textContent('.eatcard .eatnow')).trim();
  check('850 大卡寫進今天', eaten === '850', eaten);

  console.log('\n[4] 同一張照片再選一次也要能觸發（value 有清掉）');
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="photo"]');
  await p.waitForTimeout(300);
  await p.setInputFiles('#i-lib', img);
  await p.waitForTimeout(1000);
  await p.setInputFiles('#i-lib', img);   // 第二次選同一張
  await p.waitForTimeout(1000);
  check('重選同一張仍有預覽', !!(await p.$('.photo-prev')));
  /* 一餐分好幾盤：第二張是「再加一張」，不是取代掉第一張 */
  check('變成兩張（不是取代）', (await p.$$('.photo-cell')).length === 2,
    (await p.$$('.photo-cell')).length);
  check('兩張以上排成兩欄', !!(await p.$('.photo-strip.multi')));
  check('說明會一起送給 AI',
    /這 2 張會一起送給 AI/.test(await p.textContent('#photo-slot')));
  await p.click('.photo-cell [data-rm="0"]');
  await p.waitForTimeout(400);
  check('移除一張後剩一張', (await p.$$('.photo-cell')).length === 1,
    (await p.$$('.photo-cell')).length);

  console.log('\n[5] 選到非圖片檔要有明確錯誤，不能默默沒反應');
  await p.setInputFiles('#i-lib', path.join(__dirname, 'notimage.txt'));
  await p.waitForTimeout(1200);
  const toastTxt = await p.textContent('#toast').catch(() => '');
  check('跳出錯誤提示', /圖片|失敗/.test(toastTxt || ''), toastTxt);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過' : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
