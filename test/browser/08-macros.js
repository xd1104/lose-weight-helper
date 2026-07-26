/* 營養分頁測試 */
const { chromium } = require('playwright');
const { seedUser, openSet } = require('./_setup');
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

  await p.goto('http://localhost:3619/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const t = await p.$('.picker-tile[data-pick]');
  if (t) { await t.click(); await p.waitForTimeout(1700); }

  console.log('\n[1] 導覽列有「營養」，首頁三大方塊可點進去');
  check('nav 有營養', !!(await p.$('[data-nav="macros"]')));
  check('首頁三大方塊可點進營養頁', !!(await p.$('[data-nav2="macros"]')));
  check('首頁不用展開就看得到三大營養素', (await p.$$('.macros .macro')).length === 3);
  const boxTxt = await p.textContent('.macro b');
  check('顯示 目前/目標 公克數', /\//.test(boxTxt || ''), boxTxt);

  console.log('\n[2] 沒紀錄時的空狀態');
  await p.click('[data-nav="macros"]');
  await p.waitForTimeout(700);
  const empty = await p.textContent('.card .desc').catch(() => '');
  check('顯示「還沒有紀錄」', /還沒有紀錄/.test(empty || ''), empty);
  await p.screenshot({ path: '/tmp/mac-0.png', fullPage: true });

  console.log('\n[3] 記幾筆之後看分析');
  // 78kg × 1.6 = 125g 蛋白目標；先記一筆蛋白偏低的
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(500);
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(300);
  await p.fill('#m-name', '白飯兩碗');
  await p.fill('#m-kcal', '560');
  await p.fill('#m-p', '10');
  await p.fill('#m-c', '124');
  await p.fill('#m-f', '1');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1500);

  await p.click('[data-nav="macros"]');
  await p.waitForTimeout(800);
  await p.screenshot({ path: '/tmp/mac-1.png', fullPage: true });

  const rows = await p.$$eval('.mrow', (els) => els.map((e) => ({
    label: e.querySelector('.mrow-top b').textContent.trim(),
    num: e.querySelector('.mrow-num').textContent.trim(),
    tag: e.querySelector('.tag').textContent.trim(),
    state: e.className.replace('mrow', '').trim(),
  })));
  check('三大營養素各一列', rows.length === 3, rows.map((r) => r.label));
  const prot = rows.find((r) => r.label === '蛋白質');
  check('蛋白質吃太少 → under', prot && prot.state === 'under', prot);
  check('蛋白質顯示還差多少', prot && /差 \d+ g/.test(prot.tag), prot && prot.tag);
  const carb = rows.find((r) => r.label === '碳水');
  check('碳水有算出剩餘或超標', carb && /還有|超過|接近/.test(carb.tag), carb && carb.tag);

  console.log('\n[4] 蛋白質不足 → 建議直接接在那一列後面（不另開一張卡）');
  check('沒有另一張重複的「蛋白質還差」卡', !(await p.$('.tip')));
  const tip = (await p.textContent('.mrow:first-child .mrow-foot')) || '';
  check('蛋白質那列講得出缺口', /差 \d+ g/.test(tip), tip);
  // 缺口大到超過目標 60% 時刻意「不」給零食換算——那不是補一下的量，
  // 講「等於 5 份高蛋白飲」只會讓人放棄，改成提醒正餐要配蛋白質
  check('缺口很大時改講正餐，不給零食清單', /正餐/.test(tip) && !/補一份/.test(tip), tip);

  console.log('\n[5] 版面：三大營養素同一張卡，公式收起來');
  check('三列在同一張卡裡', (await p.$$('.mcard')).length === 1 && (await p.$$('.mcard .mrow')).length === 3);
  check('拿掉看不懂的「熱量來源」比例條', !(await p.$('.split')));
  check('預設不顯示「目標＝…」的公式', !(await p.$('.mnotes')));
  check('有「目標是怎麼算的」可以展開', !!(await p.$('[data-act="toggle-mnote"]')));
  const pageH = await p.evaluate(() => document.body.scrollHeight);
  check('整頁一屏看得完（原本 1,030px 要滑）', pageH <= 900, pageH);
  await p.click('[data-act="toggle-mnote"]');
  await p.waitForTimeout(500);
  const notes = (await p.textContent('.mnotes')) || '';
  check('展開後才有三條公式', /體重 \d+kg × [\d.]+ g\/kg/.test(notes) && /每日熱量的/.test(notes) && /剩下的額度/.test(notes), notes.slice(0, 80));
  await p.click('[data-act="toggle-mnote"]');
  await p.waitForTimeout(400);

  console.log('\n[5b] 缺口變小 → 這時才給具體食物換算');
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(500);
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(300);
  await p.fill('#m-name', '雞胸肉 400g');
  await p.fill('#m-kcal', '480');
  await p.fill('#m-p', '92');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1500);
  await p.click('[data-nav="macros"]');
  await p.waitForTimeout(800);
  const tipSmall = (await p.textContent('.mrow:first-child .mrow-foot')) || '';
  check('缺口小時給食物換算', /補一份/.test(tipSmall), tipSmall);
  check('同一種食物不重複列出', !/(高蛋白飲).*\1/.test(tipSmall), tipSmall);

  console.log('\n[6] 補一筆高蛋白 → 應該轉成達標');
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(500);
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(300);
  await p.fill('#m-name', '高蛋白飲');
  await p.fill('#m-kcal', '120');
  await p.fill('#m-p', '30');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1500);
  await p.click('[data-nav="macros"]');
  await p.waitForTimeout(800);
  const rows2 = await p.$$eval('.mrow', (els) => els.map((e) => e.className));
  check('蛋白質變成達標（ok）', /ok/.test(rows2[0]), rows2);
  const tip2 = (await p.textContent('.mrow:first-child .mrow-foot')) || '';
  check('改顯示達標訊息', /達標/.test(tip2), tip2);
  await p.screenshot({ path: '/tmp/mac-2.png', fullPage: true });

  console.log('\n[6b] 超標的營養素要在首頁標出來（以前 bar 卡在 100%，看不出超了）');
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(500);
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(300);
  await p.fill('#m-name', '大碗麵加飯');
  await p.fill('#m-kcal', '900');
  await p.fill('#m-c', '400');            // 遠超過碳水目標
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1500);
  const carbBox = await p.$eval('.macros .macro:nth-child(2)', (e) => ({ cls: e.className, t: e.textContent.replace(/\s+/g, ' ') }));
  check('碳水那格標成超標', /over/.test(carbBox.cls) && /超標/.test(carbBox.t), carbBox);
  const protBox = await p.$eval('.macros .macro:nth-child(1)', (e) => e.className);
  check('沒超的不會被誤標', !/over/.test(protBox), protBox);
  await p.screenshot({ path: '/tmp/mac-over.png' });

  console.log('\n[7] 設定頁可調目標，且會反映到營養頁');
  await openSet(p, 'macros');
  check('有蛋白質係數選項', !!(await p.$('[data-set="proteinPerKg"]')));
  check('有脂肪百分比選項', !!(await p.$('[data-set="fatPct"]')));
  await p.click('[data-set="proteinPerKg"][data-val="2.2"]');
  await p.waitForTimeout(1000);
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(400);
  await p.click('[data-nav="macros"]');
  await p.waitForTimeout(800);
  const protNum = await p.textContent('.mrow-num');
  check('目標跟著變成 78×2.2=172', /\/172 g/.test(protNum || ''), protNum);

  console.log('\n[8] 7 天蛋白質趨勢');
  check('有出現週趨勢', !!(await p.$('.spark')));
  const weekHead = (await p.textContent('.sec-head .n')) || '';
  check('主標是「平均 vs 目標」，不是打擊人的 0/7', /平均 \d+ g／目標/.test(weekHead), weekHead);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過' : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
