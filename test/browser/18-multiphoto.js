'use strict';
/* 一餐可以一次給好幾張照片（不同的盤子、飲料另外拍）。
 *   A. 兩張 -> 請求裡真的有兩個 image block
 *   B. 多張時一定要叮嚀「同一樣東西只能算一次」——同一盤換角度拍兩張被算兩份，熱量會直接翻倍
 *   C. 單張時不要出現那句話（沒有重複的問題，講了只是雜訊）
 *   D. 補充說明還是照樣帶進去
 *   E. 「重估其中一項」會把所有照片一起帶著
 *   F. 上限 4 張，超過不收
 *
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, seedUser } = require('./_setup');
const path = require('path');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const imgBlocks = (b) => (b.messages[0].content || []).filter((x) => x.type === 'image');
const textOf = (b) => ((b.messages[0].content || []).filter((x) => x.type === 'text')[0] || {}).text || '';

(async () => {
  const u = await seedUser();
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  const sent = [];
  await p.route('https://api.anthropic.com/**', (r) => {
    sent.push(JSON.parse(r.request().postData()));
    return r.fulfill({
      status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({
          items: [
            { name: '滷肉飯', portion: '一碗', kcal: 500, protein: 15, carbs: 70, fat: 16, confidence: 'medium' },
            { name: '燙青菜', portion: '一份', kcal: 50, protein: 3, carbs: 6, fat: 2, confidence: 'medium' },
          ], note: '估的' }) }],
        usage: { input_tokens: 2000, output_tokens: 150 },
      }),
    });
  });

  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.evaluate((id) => localStorage.setItem('lwh_user', id), u);
  await p.evaluate(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  const img = path.join(__dirname, 'meal.png');
  const openPhotoTab = async () => {
    await p.evaluate(() => closeAllSheets());
    await p.waitForTimeout(300);
    await p.click('.fab');
    await p.waitForTimeout(400);
    await p.click('[data-tab="photo"]');
    await p.waitForTimeout(400);
  };

  console.log('\n[C] 先看單張：不要講「不要算兩次」（沒有重複的問題）');
  await openPhotoTab();
  await p.setInputFiles('#i-lib', img);
  await p.waitForTimeout(1200);
  await p.click('#b-photo');
  await p.waitForTimeout(1500);
  check('單張送出 1 個 image block', imgBlocks(sent[0]).length === 1, imgBlocks(sent[0]).length);
  check('沒有多張才需要的叮嚀', !/只能算一次/.test(textOf(sent[0])), textOf(sent[0]));

  console.log('\n[A][B][D] 兩張＋補充說明');
  await p.evaluate(() => { pendingPhotos = []; aiResult = null; });
  await openPhotoTab();
  await p.setInputFiles('#i-lib', [img, img]);   // 相簿一次選兩張
  await p.waitForTimeout(1800);
  check('縮圖列出現兩格', (await p.$$('.photo-cell')).length === 2, (await p.$$('.photo-cell')).length);
  await p.fill('#i-hint', '飯是大碗的');
  await p.click('#b-photo');
  await p.waitForTimeout(1500);
  const two = sent[1] || {};
  check('請求帶了 2 個 image block', imgBlocks(two).length === 2, imgBlocks(two).length);
  check('圖片排在文字前面（照片題型準度較好）',
    (two.messages[0].content || [])[0].type === 'image');
  const t2 = textOf(two);
  check('說明是同一餐的照片', /這 2 張是我同一餐的照片/.test(t2), t2);
  check('叮嚀同一樣東西只能算一次 ← 這一句沒有的話熱量會翻倍', /只能算一次/.test(t2), t2);
  check('補充說明照樣帶進去', /補充資訊：飯是大碗的/.test(t2), t2);
  await p.screenshot({ path: '/tmp/multiphoto.png', clip: { x: 0, y: 300, width: 390, height: 544 } });

  console.log('\n[D2] system prompt 要逼它寫出「一顆幾公克」');
  /* 真實案例：同一鍋的麻糬燒，一邊 60 大卡一顆、另一邊 120 大卡一顆。
     熱量密度只差 12%，2 倍的差距全部來自「一顆 28g」還是「一顆 50g」。
     份量欄只寫「3 顆」的話，估錯了使用者也看不出來。 */
  const sys = two.system || '';
  check('要求寫出「幾顆 × 每顆幾公克 ＝ 共幾公克」', /每顆幾公克/.test(sys), sys.slice(0, 80));
  check('講明只寫顆數不夠', /只寫「3 顆」是不夠的/.test(sys));
  check('提醒小顆加工食品容易被高估成 50g', /容易被高估成 50g/.test(sys));
  check('有火鍋料的單顆重量基準', /麻糬燒／爆漿丸類 一顆約 25-30g/.test(sys));

  console.log('\n[E] 重估其中一項時，所有照片一起帶著');
  await p.click('.ai-name');
  await p.waitForTimeout(600);
  check('提示講出照片張數', /那 2 張照片/.test(await p.textContent('#f-aifix')),
    await p.textContent('#f-aifix'));
  await p.fill('#fix-name', '雞肉飯');
  await p.click('#fix-go');
  await p.waitForTimeout(1500);
  const fix = sent[2] || {};
  check('單筆重估也帶了 2 張', imgBlocks(fix).length === 2, imgBlocks(fix).length);
  check('講明是那幾張照片', /這 2 張照片你剛才/.test(textOf(fix)), textOf(fix));

  console.log('\n[F] 上限 4 張');
  await p.evaluate(() => { pendingPhotos = []; aiResult = null; });
  await openPhotoTab();
  await p.setInputFiles('#i-lib', [img, img, img, img, img, img]);
  await p.waitForTimeout(2600);
  check('只收 4 張', (await p.$$('.photo-cell')).length === 4, (await p.$$('.photo-cell')).length);
  check('滿了就不再給「再加一張」', !(await p.$('label[for="i-cam"]')));
  check('講清楚是上限', /上限/.test(await p.textContent('#photo-slot')));
  await p.click('.photo-cell [data-rm="1"]');
  await p.waitForTimeout(500);
  check('移除一張後剩 3 張', (await p.$$('.photo-cell')).length === 3, (await p.$$('.photo-cell')).length);
  check('又可以再加了', !!(await p.$('label[for="i-cam"]')));

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
