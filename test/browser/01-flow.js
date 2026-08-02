/* QC：新使用者引導 → 體重 → 多日 → 歷史趨勢 → 邊界情況 */
const { chromium } = require('playwright');
const { clearAll, openSet, closeSet } = require('./_setup');
const fail = [];
function check(name, cond, got) {
  if (cond) console.log('  ok  ' + name);
  else { console.log('  FAIL ' + name + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); fail.push(name); }
}

(async () => {
  await clearAll();   // 測試之間必須隔離，不然資料會累加
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  await p.goto('http://localhost:3619/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);

  console.log('\n[A] 新使用者 → 自動跳身體資料設定');
  await p.click('[data-act="new-user"]');
  await p.waitForTimeout(300);
  await p.fill('#u-name', 'Benson');
  await p.click('#f-user button[type="submit"]');
  await p.waitForTimeout(1500);
  const setupTitle = await p.textContent('.sheet-head h2').catch(() => '');
  check('建完使用者自動開設定 sheet', /身體資料/.test(setupTitle), setupTitle);

  // 填資料，確認 TDEE 即時更新
  await p.fill('#s-age', '32');
  await p.dispatchEvent('#s-age', 'change');
  await p.waitForTimeout(250);
  await p.fill('#s-height', '175');
  await p.dispatchEvent('#s-height', 'change');
  await p.waitForTimeout(250);
  await p.fill('#s-weight', '78');
  await p.dispatchEvent('#s-weight', 'change');
  await p.waitForTimeout(250);
  const live = await p.$$eval('.tdee-box .r b', (e) => e.map((x) => x.textContent.trim()));
  check('設定中即時顯示 BMR/TDEE/目標', live.length === 3 && live[0] === '1,719', live);
  await p.click('[data-s="goal"][data-v="-300"]');
  await p.waitForTimeout(300);
  const live2 = await p.$$eval('.tdee-box .r b', (e) => e.map((x) => x.textContent.trim()));
  check('切目標後數字跟著變，且已填的身高體重沒被吃掉', live2[0] === '1,719' && live2[2] === "2,064", live2);
  await p.click('#f-setup button[type="submit"]');
  await p.waitForTimeout(1000);

  const nudge = await p.$('.nudge');
  check('設定完成後「未設定」提醒消失', !nudge);

  console.log('\n[B] 體重記錄');
  check('首頁有體重入口', !!(await p.$('.weigh')));
  await p.click('.weigh');
  await p.waitForTimeout(400);
  await p.fill('#w-val', '78.4');
  await p.click('#f-weigh button[type="submit"]');
  await p.waitForTimeout(900);
  const wTxt = (await p.textContent('.weigh-mid b')).trim();
  check('體重顯示在首頁', wTxt.startsWith('78.4'), wTxt);

  // 前一天記一個較重的體重 -> 今天應顯示「↓」
  await p.click('[data-act="prev-day"]');
  await p.waitForTimeout(700);
  await p.click('.weigh');
  await p.waitForTimeout(400);
  await p.fill('#w-val', '79.2');
  await p.click('#f-weigh button[type="submit"]');
  await p.waitForTimeout(900);
  await p.click('[data-act="next-day"]');
  await p.waitForTimeout(700);
  const sub = (await p.textContent('.weigh-mid span')).trim();
  check('與上次比較顯示下降 0.8kg', /↓/.test(sub) && /0\.8/.test(sub), sub);

  console.log('\n[C] 體重同步進身體資料（TDEE 才不會失準）');
  await openSet(p, 'body');
  const pw = await p.inputValue('[data-num="weight"]');
  /* 78.4 要原樣進去。以前 cleanProfile 走 round() 會進位成 78，
     這條斷言當初就是照著那個 bug 寫的（v4.3 修掉） */
  check('今天量的體重已同步到 profile，小數沒被吃掉', Number(pw) === 78.4, pw);
  await closeSet(p);

  console.log('\n[D] 歷史頁體重趨勢');
  await p.click('[data-nav="history"]');
  await p.waitForTimeout(1500);
  check('出現體重趨勢卡', !!(await p.$('.wcard')));
  const wdiff = await p.textContent('.wdiff b').catch(() => '');
  check('顯示區間變化（-0.8）', /-0\.8/.test(wdiff || ''), wdiff);
  check('有畫折線', !!(await p.$('.wchart polyline')));
  const rowSmall = await p.$$eval('.hrow .d small', (e) => e.map((x) => x.textContent.trim()));
  check('有體重的日子在列表顯示公斤數', rowSmall.some((t) => /kg/.test(t)), rowSmall);
  await p.screenshot({ path: '/tmp/qc-history.png', fullPage: true });

  console.log('\n[E] 邊界：離譜體重、清除、未來日期');
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(600);
  await p.click('.weigh');
  await p.waitForTimeout(400);
  await p.fill('#w-val', '999');
  await p.click('#f-weigh button[type="submit"]');
  await p.waitForTimeout(500);
  const stillOpen = await p.$('#f-weigh');
  check('999kg 被擋下（sheet 不關）', !!stillOpen);
  await p.fill('#w-val', '78.4');
  await p.click('#f-weigh button[type="submit"]');
  await p.waitForTimeout(700);
  const nextDisabled = await p.getAttribute('[data-act="next-day"]', 'disabled');
  check('今天不能往後翻到未來', nextDisabled !== null);

  console.log('\n[F] 邊界：切到第二人 → 體重不該互相污染');
  await p.click('.me-btn');
  await p.waitForTimeout(400);
  await p.click('[data-act="new-user"]');
  await p.waitForTimeout(300);
  await p.fill('#u-name', '小美');
  await p.click('#f-user button[type="submit"]');
  await p.waitForTimeout(1600);
  await p.click('[data-sheet="close"]');   // 關掉自動跳出的設定
  await p.waitForTimeout(500);
  const w2 = await p.$('.weigh-mid b.none');
  check('小美的體重是空的', !!w2);
  const nudge2 = await p.$('.nudge');
  check('小美看得到「未設定身體資料」提醒', !!nudge2);
  await p.screenshot({ path: '/tmp/qc-newuser.png', fullPage: true });

  console.log('\n[G0] 空的餐段不各佔一張卡，收成「還沒記」一列');
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(700);
  const chips = await p.$$eval('.addchips .chip', (e) => e.map((x) => x.textContent.trim()));
  check('四餐＋運動都還沒記時，五個都在「還沒記」裡', chips.length === 5, chips);
  check('沒有任何一張「＋ 記一筆◯◯」的空卡',
    !(await p.$$eval('.row', (e) => e.filter((x) => /記一筆/.test(x.textContent)).length)));
  const chipH = await p.$$eval('.addchips .chip', (e) => e.map((x) => x.getBoundingClientRect().height));
  check('每個都 ≥ 44px', chipH.every((x) => x >= 44), chipH);

  await p.click('.addchips [data-meal="lunch"]');
  await p.waitForTimeout(500);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(300);
  await p.fill('#m-name', '滷肉飯');
  await p.fill('#m-kcal', '480');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1500);
  const chips2 = await p.$$eval('.addchips .chip', (e) => e.map((x) => x.textContent.trim()));
  check('記了午餐之後，午餐從「還沒記」消失', chips2.length === 4 && !chips2.some((t) => /午餐/.test(t)), chips2);
  check('出現午餐的區塊', /午餐/.test(await p.textContent('.sec-head h2')));
  /* v4.5 起列上不再印時間（那是「按下記錄」的時間、不是吃的時間，中午補記早餐會顯示 12:30
     在早餐底下，看起來像錯的），所以沒有份量的那一筆就只有一行。 */
  check('沒有份量的那一筆只有一行，不再印記錄時間', (await p.$$('.row-mid span')).length === 0,
    await p.$$eval('.row-mid span', (e) => e.map((x) => x.textContent)));
  /* 有份量的那一筆仍然固定一行（太長就截斷，列高才會一致） */
  await p.evaluate(() => {
    var d = dayOf(curDate);
    d.entries[d.entries.length - 1].portion = '便當盒、白飯約 1.5 碗、另外加了一份燙青菜與滷蛋';
    render();
  });
  await p.waitForTimeout(400);
  const rowSub = await p.$eval('.row-mid span', (e) => getComputedStyle(e).whiteSpace);
  check('有份量時固定一行（太長就截斷，列高才會一致）', rowSub === 'nowrap', rowSub);

  console.log('\n[G] 觸控目標尺寸（iOS 44px 規範）與輸入字級（防自動放大）');
  const small = await p.$$eval('button, .row, .weigh, a', (els) => els
    .filter((e) => e.offsetParent !== null)
    .map((e) => ({ t: (e.textContent || '').trim().slice(0, 14), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
    .filter((x) => x.h > 0 && (x.h < 44 || x.w < 44)));
  check('沒有小於 44px 的觸控目標', small.length === 0, small);
  const tiny = await p.$$eval('input, textarea, select', (els) => els
    .map((e) => ({ id: e.id, fs: parseFloat(getComputedStyle(e).fontSize) }))
    .filter((x) => x.fs < 16));
  check('沒有小於 16px 的輸入框', tiny.length === 0, tiny);

  console.log('\nconsole errors:', errs.length ? JSON.stringify(errs, null, 2) : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：' + fail.join(' / ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
