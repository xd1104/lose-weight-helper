'use strict';
/* 兩個新功能
 *   A. 常吃清單：可以多選一次加、可以自己新增、可以編輯與刪除
 *   B. 「今天吃得怎樣」：把今天三餐整包丟給 AI，回一段營養師講評
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
const D = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const getFoods = (u) => fetch(BASE + '/api/core?u=' + encodeURIComponent(u)).then((r) => r.json()).then((j) => j.foods || []);

(async () => {
  const u = await seedUser({ age: 27, height: 168, weight: 80, activity: 1.2, goal: -300 });
  // 先塞三筆常吃（模擬「以前記過」）
  await fetch(BASE + '/api/foods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, foods: [
      { id: 'f1', name: '燒餅', kcal: 280, p: 6, c: 40, f: 10, portion: '一個', n: 5 },
      { id: 'f2', name: '無糖豆漿', kcal: 45, p: 4, c: 2, f: 2, portion: '半杯', n: 4 },
      { id: 'f3', name: '滷雞腿', kcal: 220, p: 26, c: 1, f: 12, portion: '一支', n: 3 },
    ] }),
  });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  const coachReqs = [];
  await p.route('https://api.anthropic.com/**', (r) => {
    const body = JSON.parse(r.request().postData());
    coachReqs.push(body);
    // 「估一項食物」的請求（常吃清單的「讓 AI 幫我填」）跟講評不是同一組 schema
    if (!/營養師/.test(body.system || '')) {
      return r.fulfill({
        status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({
            items: [{ name: '滷排骨便當', portion: '一個便當盒', kcal: 700, protein: 20, carbs: 95, fat: 22, confidence: 'medium' }],
          }) }],
          usage: { input_tokens: 200, output_tokens: 80 },
        }),
      });
    }
    return r.fulfill({
      status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({
          verdict: '熱量守得不錯，但油脂偏高',
          good: ['三餐都有蔬菜', '早餐的豆漿選無糖的很好'],
          issues: ['午餐的燒鴨油脂高，可以換成滷雞腿', '蛋白質還差 18 g'],
          next: '晚餐吃清蒸魚配一碗糙米飯',
        }) }],
        usage: { input_tokens: 800, output_tokens: 200 },
      }),
    });
  });

  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const tile = await p.$('.picker-tile[data-pick]');
  if (tile) { await tile.click(); await p.waitForTimeout(1500); }

  /* ═══════ A. 常吃清單 ═══════ */
  console.log('\n[A1] 一次勾好幾樣，按一次加入（以前一次只能加一筆）');
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="fav"]');
  await p.waitForTimeout(400);
  check('三筆都在', (await p.$$('[data-fav]')).length === 3);
  check('還沒勾的時候沒有加入鈕', !(await p.$('[data-fav-go]')));

  await p.click('[data-fav="f1"]');
  await p.waitForTimeout(400);
  check('勾了一筆就出現加入鈕', !!(await p.$('[data-fav-go]')));
  await p.click('[data-fav="f2"]');
  await p.waitForTimeout(400);
  const goTxt = (await p.textContent('[data-fav-go]')) || '';
  check('算出勾了幾筆與總熱量（280+45=325）', /加入 2 筆/.test(goTxt) && /325/.test(goTxt), goTxt);
  check('勾起來的有打勾樣式', (await p.$$('.food-row.on')).length === 2);
  await p.screenshot({ path: '/tmp/fav-pick.png' });

  await p.click('[data-fav="f2"]');
  await p.waitForTimeout(400);
  check('再點一次可以取消勾選', /加入 1 筆/.test((await p.textContent('[data-fav-go]')) || ''));
  await p.click('[data-fav="f2"]');
  await p.waitForTimeout(400);

  await p.click('[data-fav-go]');
  await p.waitForTimeout(1800);
  const rows = await p.$$eval('.row-mid b', (e) => e.map((x) => x.textContent.trim()));
  check('兩筆一起寫進今天', rows.some((r) => /燒餅/.test(r)) && rows.some((r) => /無糖豆漿/.test(r)), rows);
  check('熱量是 325', (await p.textContent('.kv.eat b')).trim() === '325');

  console.log('\n[A2] 自己新增一筆（不用先讓 AI 估過）');
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="fav"]');
  await p.waitForTimeout(400);
  await p.click('[data-fav-new]');
  await p.waitForTimeout(600);
  check('開出「新增常吃項目」', (await p.textContent('.sheet-head h2')).trim() === '新增常吃項目');
  await p.fill('#fd-name', '雞胸肉便當');
  await p.fill('#fd-por', '一個');
  await p.fill('#fd-kcal', '620');
  await p.fill('#fd-p', '48');
  await p.fill('#fd-c', '70');
  await p.fill('#fd-f', '14');
  await p.click('#f-food button[type="submit"]');
  await p.waitForTimeout(1800);
  check('清單變成四筆', (await p.$$('[data-fav]')).length === 4);
  const foods = await getFoods(u);
  const nf = foods.filter((x) => x.name === '雞胸肉便當')[0];
  check('真的存進 foods.md', !!nf, foods.map((x) => x.name));
  check('數字都存對', nf && nf.kcal === 620 && nf.p === 48 && nf.c === 70 && nf.f === 14, nf);

  console.log('\n[A3] 編輯既有的一筆（AI 估歪的可以自己改）');
  await p.click('[data-fav-edit="f3"]');
  await p.waitForTimeout(600);
  check('開出「編輯常吃項目」', (await p.textContent('.sheet-head h2')).trim() === '編輯常吃項目');
  check('帶入原本的值', (await p.inputValue('#fd-name')) === '滷雞腿' && (await p.inputValue('#fd-kcal')) === '220');
  await p.fill('#fd-kcal', '260');
  await p.click('#f-food button[type="submit"]');
  await p.waitForTimeout(1800);
  const foods2 = await getFoods(u);
  check('改過的熱量存回去了', foods2.filter((x) => x.id === 'f3')[0].kcal === 260,
    foods2.filter((x) => x.id === 'f3')[0]);

  console.log('\n[A4] 刪除收在編輯裡（一列不塞兩顆破壞性按鈕）');
  await p.click('[data-fav-edit="f3"]');
  await p.waitForTimeout(600);
  check('編輯裡有刪除', !!(await p.$('[data-fd-del]')));
  p.once('dialog', (d) => d.accept());
  await p.click('[data-fd-del]');
  await p.waitForTimeout(1800);
  const foods3 = await getFoods(u);
  check('真的刪掉了', !foods3.some((x) => x.id === 'f3'), foods3.map((x) => x.name));
  check('清單剩三筆', (await p.$$('[data-fav]')).length === 3);

  console.log('\n[A4b] 從今天記過的一筆，一鍵加入常吃（不用自己記碳水蛋白質）');
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(500);
  await p.click('.row[data-act="edit-entry"]');
  await p.waitForTimeout(600);
  check('編輯那一筆時有「加入常吃清單」', !!(await p.$('#e-star')));
  check('還沒釘選時是空心星', /☆/.test((await p.textContent('#e-star')) || ''), await p.textContent('#e-star'));
  await p.click('#e-star');
  await p.waitForTimeout(1500);
  check('按了變成實心星', /★ 已在常吃清單/.test((await p.textContent('#e-star')) || ''));
  const fs = await getFoods(u);
  const star1 = fs.filter((x) => x.star);
  check('那一筆被標成釘選', star1.length === 1 && /燒餅/.test(star1[0].name), star1);
  check('營養素直接沿用那一筆，不用自己填', star1[0].c === 40 && star1[0].p === 6, star1[0]);
  check('沒有長出重複的一筆（同名的就更新）',
    fs.filter((x) => x.name === '燒餅').length === 1, fs.map((x) => x.name));
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(500);

  console.log('\n[A4c] 釘選的排在該組最上面');
  /* v5.8 起清單是照「都在哪一餐吃」分組的（不再有「★ 常吃／吃過的」兩區），
     釘選改成在自己那一組裡排第一。分組本身由 27-fav.js 專門守著。 */
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="fav"]');
  await p.waitForTimeout(500);
  await p.evaluate(() => { favAll = true; MEALS.concat(['other']).forEach((k) => { favOpen[k] = true; }); drawAddSheet(false); });
  await p.waitForTimeout(400);
  const order = await p.$$eval('.food-row b', (e) => e.map((x) => x.childNodes[0].textContent.trim()));
  check('釘選的排第一個', order[0] === '燒餅', order);
  await p.screenshot({ path: '/tmp/fav-star.png' });

  console.log('\n[A4d] 新增時可以讓 AI 幫忙填數字（不用自己記碳水蛋白質）');
  const n0ai = coachReqs.length;
  await p.click('[data-fav-new]');
  await p.waitForTimeout(600);
  check('有「讓 AI 幫我填數字」', !!(await p.$('#fd-ai')));
  await p.click('#fd-ai');
  await p.waitForTimeout(700);
  check('沒填名稱時不會白打 AI', coachReqs.length === n0ai, coachReqs.length - n0ai);
  await p.fill('#fd-name', '滷排骨便當');
  await p.click('#fd-ai');
  await p.waitForTimeout(2000);
  check('打了一次 AI', coachReqs.length === n0ai + 1, coachReqs.length - n0ai);
  check('四個數字都被填上', (await p.inputValue('#fd-kcal')) === '700' &&
    (await p.inputValue('#fd-p')) === '20' && (await p.inputValue('#fd-c')) === '95' &&
    (await p.inputValue('#fd-f')) === '22',
    [await p.inputValue('#fd-kcal'), await p.inputValue('#fd-p'), await p.inputValue('#fd-c'), await p.inputValue('#fd-f')]);
  check('新增時也可以直接釘選', !!(await p.$('#fd-star')));
  await p.click('#fd-star');
  await p.waitForTimeout(300);
  await p.click('#f-food button[type="submit"]');
  await p.waitForTimeout(1800);
  const fs2 = await getFoods(u);
  const nb = fs2.filter((x) => x.name === '滷排骨便當')[0];
  check('存進去了，而且是釘選的', nb && nb.star === true && nb.kcal === 700, nb);

  console.log('\n[A4e] 營養素可以輸入小數（食品標示常常是 2.5 g）');
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(500);
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(400);
  const modes = await p.$$eval('#m-p, #m-c, #m-f',
    (e) => e.map((x) => ({ im: x.getAttribute('inputmode'), st: x.getAttribute('step') })));
  check('三個營養素欄位都是小數鍵盤 ← iOS 的 numeric 鍵盤沒有小數點',
    modes.every((m) => m.im === 'decimal' && m.st === '0.1'), modes);
  await p.fill('#m-name', '低脂起司片');
  await p.fill('#m-kcal', '50');
  await p.fill('#m-p', '4.5');
  await p.fill('#m-c', '1.2');
  await p.fill('#m-f', '2.8');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1800);
  const dayNow = await fetch(BASE + '/api/days?u=' + u + '&dates=' + D()).then((r) => r.json());
  const che = (dayNow.days[0].entries || []).filter((x) => x.name === '低脂起司片')[0];
  check('小數真的存進去了，沒有被進位', che && che.p === 4.5 && che.c === 1.2 && che.f === 2.8, che);

  await p.click('.row[data-act="edit-entry"] >> nth=-1');
  await p.waitForTimeout(700);
  check('編輯時帶回來還是 4.5', (await p.inputValue('#e-p')) === '4.5', await p.inputValue('#e-p'));
  const emodes = await p.$$eval('#e-p, #e-c, #e-f', (e) => e.map((x) => x.getAttribute('inputmode')));
  check('編輯欄位也是小數鍵盤', emodes.every((m) => m === 'decimal'), emodes);
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(500);
  check('整數不會多印成 4.0', !/\d+\.0(?!\d)/.test((await p.textContent('.macros')) || ''),
    await p.textContent('.macros'));

  console.log('\n[A5] 搜尋時不會把已勾選的狀態弄丟');
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="fav"]');
  await p.waitForTimeout(400);
  /* v4.9 起清單少於 8 筆時不放搜尋框（短清單放搜尋只是多一個要滑過去的東西），
     所以要先把清單湊長，才測得到搜尋 */
  await p.evaluate(() => {
    for (var i = 0; i < 8; i++) {
      db.foods.push({ id: 'pad' + i, name: '湊數' + i, kcal: 100, p: 1, c: 1, f: 1, n: 1 });
    }
    /* 湊到 12 筆以上就會進入分組模式，而分組預設全部收起來（v5.9）。
       這一段測的是搜尋與勾選，不是折疊，所以先全部攤開。 */
    favAll = true;
    MEALS.concat(['other']).forEach((k) => { favOpen[k] = true; });
    drawAddSheet(false);
  });
  await p.waitForTimeout(500);
  await p.click('[data-fav="f1"]');
  await p.waitForTimeout(400);
  await p.fill('#i-fav-q', '燒');
  await p.waitForTimeout(600);
  check('搜尋有過濾', (await p.$$('[data-fav]')).length === 1);
  check('勾選還在', (await p.$$('.food-row.on')).length === 1);
  check('加入鈕還在', !!(await p.$('[data-fav-go]')));
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(500);

  /* ═══════ B. 今天吃得怎樣 ═══════ */
  console.log('\n[B1] 今天頁有入口，而且要有記東西才出現');
  check('有「今天吃得怎樣」的按鈕', !!(await p.$('[data-act="coach"]')));

  console.log('\n[B2] 點下去 → 把今天的三餐整包送給 AI');
  const n0 = coachReqs.length;
  await p.click('[data-act="coach"]');
  await p.waitForTimeout(2200);
  check('打了一次 AI', coachReqs.length === n0 + 1, coachReqs.length - n0);
  const req = coachReqs[coachReqs.length - 1];
  const txt = req.messages[0].content[0].text;
  check('system 是營養師的角色', /營養師/.test(req.system || ''), (req.system || '').slice(0, 30));
  check('要求具體到哪一餐哪一樣', /哪一餐的哪一樣/.test(req.system || ''));
  check('帶了今天實際吃的品項', /燒餅/.test(txt) && /無糖豆漿/.test(txt), txt.slice(0, 300));
  check('帶了熱量目標與 TDEE', /TDEE 2064/.test(txt) && /1764/.test(txt), txt.slice(0, 200));
  check('帶了三大營養素目標', /蛋白質 128 g/.test(txt), txt.slice(0, 250));
  check('告訴 AI 現在幾點（才知道要建議下一餐還是明天）', /現在 \d\d:\d\d/.test(txt), txt.slice(0, 80));
  check('用 structured outputs', !!(req.output_config && req.output_config.format));

  console.log('\n[B3] 講評顯示成好讀的區塊');
  check('一句話總評', /熱量守得不錯/.test((await p.textContent('.coach-top')) || ''));
  check('做得好（綠）', (await p.$$('.coach-sec.good li')).length === 2);
  check('可以更好（黃）', (await p.$$('.coach-sec.warn li')).length === 2);
  check('接下來的建議', /清蒸魚/.test((await p.textContent('.coach-sec.next p')) || ''));
  check('有免責提醒', /僅供參考/.test((await p.textContent('.sheet-body')) || ''));
  await p.screenshot({ path: '/tmp/coach.png' });

  console.log('\n[B4] 同一天再點開不會重複收費（要重看得自己按「重新評估」）');
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(1200);
  const n1 = coachReqs.length;
  await p.click('[data-act="coach"]');
  await p.waitForTimeout(1200);
  check('沒有再打 AI', coachReqs.length === n1, coachReqs.length - n1);
  check('內容還在', /熱量守得不錯/.test((await p.textContent('.coach-top')) || ''));
  check('標出什麼時候評的', /\d+\/\d+ \d\d:\d\d 評的/.test((await p.textContent('.coach-top')) || ''),
    await p.textContent('.coach-top'));
  check('有「重新評估」', !!(await p.$('[data-coach="again"]')));
  await p.click('[data-coach="again"]');
  await p.waitForTimeout(2200);
  check('按了才會再打一次', coachReqs.length === n1 + 1, coachReqs.length - n1);
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(1200);

  console.log('\n[B5] 講評存進那一天的檔案，重開 app 還在（不用再花錢）');
  const saved = await fetch(BASE + '/api/days?u=' + u + '&dates=' + D()).then((r) => r.json());
  check('day 檔裡有講評', !!(saved.days[0] && saved.days[0].coach), saved.days[0] && saved.days[0].coach);
  check('四個欄位都存了',
    saved.days[0].coach.verdict && saved.days[0].coach.good.length === 2 &&
    saved.days[0].coach.issues.length === 2 && saved.days[0].coach.next, saved.days[0].coach);
  check('有存評估時間', !!saved.days[0].coach.at, saved.days[0].coach.at);

  const n2 = coachReqs.length;
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1800);
  const btn = (await p.textContent('[data-act="coach"]')) || '';
  check('重開之後按鈕直接顯示總評', /熱量守得不錯/.test(btn), btn);
  await p.click('[data-act="coach"]');
  await p.waitForTimeout(1200);
  check('點開看的是存下來的那份，沒有再打 AI', coachReqs.length === n2, coachReqs.length - n2);
  check('內容一樣', /清蒸魚/.test((await p.textContent('.coach-sec.next p')) || ''));
  await p.click('[data-sheet="close"]');
  await p.waitForTimeout(600);

  console.log('\n[B6] 歷史頁標出哪幾天有講評（不用另開分頁就找得到）');
  await p.click('[data-nav="history"]');
  await p.waitForTimeout(2000);
  const marked = await p.$$('.hrow .has-coach');
  check('今天那一列有 🥗 記號', marked.length === 1, marked.length);
  await p.screenshot({ path: '/tmp/coach-hist.png' });
  await p.click('.hrow[data-date="' + D() + '"]');
  await p.waitForTimeout(1500);
  check('點進去那天就看得到講評入口', /熱量守得不錯/.test((await p.textContent('[data-act="coach"]')) || ''));

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
