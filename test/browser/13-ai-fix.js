'use strict';
/* 拍一張照片 AI 拆成好幾項時，「其中一項認錯了」要怎麼修。
 * Benson 的原話：只有一項有問題，卻只能重新拍一次再加敘述，很麻煩。
 *   A. 照片選過就一直留著（以前退回輸入頁時畫面把它藏起來，看起來像要重拍）
 *   B. 點某一項可以進去改名字
 *   C. 「重新估這一項」會帶著原本那張照片，而且只換掉那一項
 *   D. 「只改名稱」不打 AI
 *   E. 「＋ 補一項」可以補 AI 漏掉的東西
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

const SIX = ['白飯', '叉燒肉', '油雞腿肉', '燒鴨肉', '燙青菜', '蔥薑醬料'];

(async () => {
  const u = await seedUser();
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  const reqs = [];
  await p.route('https://api.anthropic.com/**', (r) => {
    const body = JSON.parse(r.request().postData());
    reqs.push(body);
    const blocks = body.messages[0].content;
    const txt = (blocks.filter((x) => x.type === 'text')[0] || {}).text || '';
    // 「只重估一項」的請求 -> 只回一項；第一次的照片請求 -> 回六項
    const one = /只要重新估那一項|只回這一項/.test(txt);
    const items = one
      ? [{ name: '叉燒（3 片）', portion: '約 90 克', kcal: 260, protein: 18, carbs: 4, fat: 19, confidence: 'medium' }]
      : SIX.map((n, i) => ({ name: n, portion: '一份', kcal: 100 + i * 10, protein: 5, carbs: 10, fat: 3, confidence: 'medium' }));
    return r.fulfill({
      status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ items: items }) }],
        usage: { input_tokens: 900, output_tokens: 150 },
      }),
    });
  });

  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('lwh_anthropic_key', 'sk-ant-test'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const tile = await p.$('.picker-tile[data-pick]');
  if (tile) { await tile.click(); await p.waitForTimeout(1500); }

  const img = path.join(__dirname, 'meal.png');
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="photo"]');
  await p.waitForTimeout(400);
  await p.setInputFiles('#i-lib', img);
  await p.waitForTimeout(1200);
  await p.fill('#i-hint', '燒臘三寶飯');
  await p.click('#b-photo');
  await p.waitForTimeout(1500);

  console.log('\n[0] 照片估出六項');
  const names0 = await p.$$eval('.ai-name', (e) => e.map((x) => x.textContent.replace('✎', '').trim()));
  check('列出六項', names0.length === 6, names0);
  check('每一項的名稱都可以點（要能單獨修）', (await p.$$('[data-fix]')).length === 7, // 六項 + 補一項
    (await p.$$('[data-fix]')).length);

  console.log('\n[A] 退回輸入頁時照片還在（以前這裡看起來像不見了，只好重拍）');
  await p.click('[data-ai="retry"]');
  await p.waitForTimeout(700);
  check('回到照片那一頁', !!(await p.$('#f-photo')));
  check('照片預覽還在 ← 這就是「以為要重拍」的原因', !!(await p.$('.photo-prev')));
  check('送出鈕沒有被鎖住', (await p.getAttribute('#b-photo', 'disabled')) === null);
  check('上次的補充說明也留著', (await p.inputValue('#i-hint')) === '燒臘三寶飯');
  await p.screenshot({ path: '/tmp/aifix-photo.png' });

  // 回到結果頁
  await p.click('#b-photo');
  await p.waitForTimeout(1500);

  console.log('\n[B] 點某一項 → 可以改名字');
  const before = await p.$$eval('.ai-name', (e) => e.map((x) => x.textContent.replace('✎', '').trim()));
  await p.click('[data-fix="3"]');           // 燒鴨肉
  await p.waitForTimeout(600);
  check('開出「修正這一項」', (await p.textContent('.sheet-head h2')).trim() === '修正這一項');
  check('帶入原本的名稱', (await p.inputValue('#fix-name')) === '燒鴨肉', await p.inputValue('#fix-name'));
  check('有提到會帶原照片', /照片/.test((await p.textContent('#f-aifix .hint')) || ''));

  console.log('\n[C] 重新估這一項：帶原照片、只換那一項');
  const n0 = reqs.length;
  await p.fill('#fix-name', '叉燒');
  await p.fill('#fix-por', '3 片');
  await p.click('#fix-go');
  await p.waitForTimeout(2000);

  const one = reqs[reqs.length - 1];
  const blocks = one.messages[0].content;
  check('只多打了一次 AI', reqs.length === n0 + 1, reqs.length - n0);
  check('請求裡帶了原本那張照片 ← 不用重拍的關鍵', blocks.some((x) => x.type === 'image'));
  const txt = (blocks.filter((x) => x.type === 'text')[0] || {}).text || '';
  check('告訴 AI 原本判斷成什麼', /燒鴨肉/.test(txt), txt.slice(0, 120));
  check('告訴 AI 正確的是什麼（含份量）', /叉燒/.test(txt) && /3 片/.test(txt), txt.slice(0, 160));
  check('要求只回這一項', /只回這一項|其他項目不用列/.test(txt), txt.slice(0, 160));

  const after = await p.$$eval('.ai-name', (e) => e.map((x) => x.textContent.replace('✎', '').trim()));
  check('回到結果頁，還是六項', after.length === 6, after);
  check('第 4 項被換成叉燒', /叉燒/.test(after[3]), after[3]);
  check('其他五項原封不動 ← 這就是重點',
    after[0] === before[0] && after[1] === before[1] && after[2] === before[2] &&
    after[4] === before[4] && after[5] === before[5], { before, after });
  const kcal3 = await p.inputValue('[data-f="kcal"][data-i="3"]');
  check('那一項的數字也換成重估的 260', kcal3 === '260', kcal3);
  await p.screenshot({ path: '/tmp/aifix-done.png' });

  console.log('\n[D] 「只改名稱」不打 AI');
  const n1 = reqs.length;
  await p.click('[data-fix="0"]');
  await p.waitForTimeout(600);
  await p.fill('#fix-name', '糙米飯');
  await p.click('[data-fix2="rename"]');
  await p.waitForTimeout(800);
  check('沒有打 AI', reqs.length === n1, reqs.length - n1);
  const after2 = await p.$$eval('.ai-name', (e) => e.map((x) => x.textContent.replace('✎', '').trim()));
  check('名稱改掉了', /糙米飯/.test(after2[0]), after2[0]);
  const kcal0 = await p.inputValue('[data-f="kcal"][data-i="0"]');
  check('數字不動', kcal0 === '100', kcal0);

  console.log('\n[E] 補一項（AI 漏掉的）');
  await p.click('[data-fix="-1"]');
  await p.waitForTimeout(600);
  check('開出「補一項」', (await p.textContent('.sheet-head h2')).trim() === '補一項');
  check('名稱是空的', (await p.inputValue('#fix-name')) === '');
  await p.fill('#fix-name', '例湯');
  await p.click('[data-fix2="manual"]');     // 不打 AI，自己填數字
  await p.waitForTimeout(800);
  const after3 = await p.$$eval('.ai-name', (e) => e.map((x) => x.textContent.replace('✎', '').trim()));
  check('變成七項', after3.length === 7, after3);
  check('最後一項是例湯', /例湯/.test(after3[6]), after3[6]);
  await p.fill('[data-f="kcal"][data-i="6"]', '60');
  await p.waitForTimeout(400);

  console.log('\n[F] 存進去');
  await p.click('[data-ai="save"]');
  await p.waitForTimeout(1800);
  /* 今天頁超過 4 項會摺疊（v4.4），所以問資料、不要數畫面上的列 */
  const d = new Date();
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const saved = await (await fetch(BASE + '/api/days?u=' + u + '&dates=' + key)).json();
  const rows = ((saved.days[0] || {}).entries || []).map((e) => e.name);
  check('七項都寫進今天', rows.length === 7
    && ['糙米飯', '叉燒（3 片）', '例湯'].every((n) => rows.some((r) => r.indexOf(n) >= 0)), rows);
  const eaten = (await p.textContent('.kv.eat b')).trim();
  // 100(糙米飯) + 110 + 120 + 260(叉燒重估) + 140 + 150 + 60(例湯) = 940
  check('總熱量用重估後的數字（940）', eaten === '940', eaten);

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
