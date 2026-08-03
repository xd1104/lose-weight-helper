'use strict';
/*
 * md 格式 round-trip 測試：serialize -> parse -> 值要一模一樣。
 * 前後端各有一套 mirror parser，格式一改就容易只改一邊；這支測 server 那半，
 * 並額外驗前端 store.js 的字串內容與 server.js 對齊（避免無聲分岔）。
 * 跑法：node test/roundtrip.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../server.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

console.log('day round-trip');

t('完整的一天：所有欄位原樣回來', () => {
  const day = {
    date: '2026-07-25', weight: 70.4, updatedAt: '2026-07-25T01:00:00.000Z',
    entries: [
      { id: 'a1', time: '08:12', meal: 'breakfast', name: '蛋餅加蛋', kcal: 380, p: 15, c: 42, f: 16,
        portion: '一份、加一顆蛋', note: '', src: 'ai' },
      { id: 'a2', time: '12:30', meal: 'lunch', name: '排骨便當（加飯）', kcal: 980, p: 34, c: 128, f: 33,
        portion: '便當盒、白飯約 1.5 碗', src: 'ai' },
      { id: 'a3', time: '15:00', meal: 'snack', name: '黑咖啡', kcal: 5 },
    ],
    moves: [{ id: 'm1', time: '19:00', name: '慢跑 30 分', kcal: 300 }],
    notes: '今天外食比較多。\n\n## 這行故意用 ## 開頭，不可以被當標題吃掉',
  };
  const back = S.parseDay('2026-07-25', S.serializeDay(day));
  assert.strictEqual(back.date, '2026-07-25');
  assert.strictEqual(back.weight, 70.4);
  assert.strictEqual(back.entries.length, 3);
  assert.strictEqual(back.entries[0].name, '蛋餅加蛋');
  assert.strictEqual(back.entries[0].meal, 'breakfast');
  assert.strictEqual(back.entries[1].kcal, 980);
  assert.strictEqual(back.entries[1].portion, '便當盒、白飯約 1.5 碗');
  assert.strictEqual(back.entries[2].kcal, 5);
  assert.strictEqual(back.moves[0].kcal, 300);
  assert.strictEqual(back.notes, day.notes, '備註要整段原樣（含裡面的 ##）');
});

t('空的一天不會炸', () => {
  const back = S.parseDay('2026-01-01', S.serializeDay({ date: '2026-01-01', entries: [], moves: [], notes: '' }));
  assert.strictEqual(back.entries.length, 0);
  assert.strictEqual(back.moves.length, 0);
  assert.strictEqual(back.notes, '');
});

t('壞掉的 JSON 行跳過，不整檔炸掉', () => {
  const md = [
    '---', 'date: "2026-07-25"', 'weight: 0', 'updatedAt: ""', '---', '',
    '## 飲食', '',
    '- {"id":"ok","time":"08:00","meal":"breakfast","name":"good","kcal":100}',
    '- {這行壞了',
    '- {"id":"ok2","time":"09:00","meal":"snack","name":"good2","kcal":200}',
    '', '## 運動', '', '## 備註', '',
  ].join('\n');
  const back = S.parseDay('2026-07-25', md);
  assert.strictEqual(back.entries.length, 2);
  assert.strictEqual(back.entries[1].name, 'good2');
});

t('CRLF（Windows checkout）也要解得開', () => {
  const md = S.serializeDay({
    date: '2026-07-25', entries: [{ id: 'x', time: '08:00', meal: 'lunch', name: '拉麵', kcal: 700 }],
    moves: [], notes: '備註一行',
  }).replace(/\n/g, '\r\n');
  const back = S.parseDay('2026-07-25', md);
  assert.strictEqual(back.entries.length, 1);
  assert.strictEqual(back.entries[0].name, '拉麵');
  assert.strictEqual(back.notes, '備註一行');
});

t('未知的 meal 值落到 snack（不會消失）', () => {
  const back = S.parseDay('2026-07-25', S.serializeDay({
    date: '2026-07-25', entries: [{ id: 'x', time: '', meal: 'brunch', name: 'x', kcal: 1 }], moves: [], notes: '',
  }));
  assert.strictEqual(back.entries[0].meal, 'snack');
});

t('0 值的營養素不寫進檔案，但讀回來是 0 不是 undefined', () => {
  const md = S.serializeDay({
    date: '2026-07-25', entries: [{ id: 'x', time: '', meal: 'snack', name: '水', kcal: 0, p: 0, c: 0, f: 0 }],
    moves: [], notes: '',
  });
  assert.ok(md.indexOf('"p":0') === -1, '0 值不該落檔');
  const back = S.parseDay('2026-07-25', md);
  assert.strictEqual(back.entries[0].kcal, 0);
});

t('AI 講評 round-trip：存在那一天的檔案裡，之後回頭看不用再花錢', () => {
  const coach = {
    at: '2026-07-27T13:30:00.000Z',
    verdict: '熱量守得不錯，但油脂偏高',
    good: ['三餐都有蔬菜', '早餐的豆漿選無糖的很好'],
    issues: ['午餐的燒鴨油脂高，可以換成滷雞腿', '蛋白質還差 18 g'],
    next: '晚餐吃清蒸魚配一碗糙米飯',
  };
  const day = { date: '2026-07-27', weight: 0, entries: [{ id: 'a', name: '燒餅', kcal: 280, meal: 'breakfast' }], moves: [], coach, notes: '外食' };
  const md = S.serializeDay(day);
  assert.ok(md.indexOf('## 講評') >= 0, '要有講評這一段');
  assert.ok(md.indexOf('## 講評') < md.indexOf('## 備註'), '講評必須排在備註之前（備註會吃掉後面全部）');
  const back = S.parseDay('2026-07-27', md);
  assert.strictEqual(back.coach.verdict, coach.verdict);
  assert.deepStrictEqual(back.coach.good, coach.good);
  assert.deepStrictEqual(back.coach.issues, coach.issues);
  assert.strictEqual(back.coach.next, coach.next);
  assert.strictEqual(back.coach.at, coach.at);
  assert.strictEqual(back.notes, '外食', '備註不受影響');
  assert.strictEqual(back.entries.length, 1, '飲食不受影響');
});

t('AI 講評：沒有講評、或內容是空的，一律當作沒有', () => {
  const md = S.serializeDay({ date: '2026-07-27', entries: [], moves: [], notes: '' });
  assert.strictEqual(S.parseDay('2026-07-27', md).coach, null, '沒評過就是 null');
  assert.strictEqual(S.cleanCoach({ verdict: '  ' }), null, '總評是空白就當沒有');
  assert.strictEqual(S.cleanCoach(null), null);
  // 陣列最多留 4 點，避免 AI 一次噴十點把版面塞爆
  const many = S.cleanCoach({ verdict: 'x', good: ['1', '2', '3', '4', '5', '6'], issues: [], next: '' });
  assert.strictEqual(many.good.length, 4);
});

t('AI 講評：舊的 day 檔（沒有 ## 講評 這段）照樣讀得動', () => {
  const legacy = ['---', 'date: "2026-07-25"', 'weight: 0', 'updatedAt: "2026-07-25T11:23:05.598Z"', '---', '',
    '## 飲食', '', '- {"id":"x","time":"12:44","meal":"breakfast","name":"碗粿","kcal":320}', '',
    '## 運動', '', '', '## 備註', '', '今天外食'].join('\n');
  const back = S.parseDay('2026-07-25', legacy);
  assert.strictEqual(back.coach, null, '沒有講評段就是 null');
  assert.strictEqual(back.entries.length, 1);
  assert.strictEqual(back.notes, '今天外食');
});

t('三大營養素可以有小數（食品標示常常是 2.5 g，全部進位會累積誤差）', () => {
  const day = { date: '2026-07-28', entries: [
    { id: 'a', name: '低脂起司片', kcal: 50, p: 4.5, c: 1.2, f: 2.8, meal: 'snack' },
  ], moves: [], notes: '' };
  const back = S.parseDay('2026-07-28', S.serializeDay(day));
  assert.strictEqual(back.entries[0].p, 4.5, '小數要留住，不能變成 5');
  assert.strictEqual(back.entries[0].c, 1.2);
  assert.strictEqual(back.entries[0].f, 2.8);
  assert.strictEqual(back.entries[0].kcal, 50, '熱量還是整數');
  // 只留一位：AI 有時會回 12.3456
  assert.strictEqual(S.cleanEntry({ id: 'x', p: 12.3456 }).p, 12.3);
  // 常吃清單同一套
  const f = S.parseFoods(S.serializeFoods([{ id: 'a', name: '起司片', kcal: 50, p: 4.5, c: 1.2, f: 2.8 }]));
  assert.strictEqual(f[0].p, 4.5);
  assert.strictEqual(f[0].f, 2.8);
});

t('體重的兩位小數要留著（有些體重計是 0.05 kg 一格）', () => {
  const back = S.parseDay('2026-07-25', S.serializeDay({
    date: '2026-07-25', weight: 59.45, entries: [], moves: [], notes: '',
  }));
  assert.strictEqual(back.weight, 59.45);
  // 再多的位數就沒有意義了，砍到兩位
  const back2 = S.parseDay('2026-07-25', S.serializeDay({
    date: '2026-07-25', weight: 59.4567, entries: [], moves: [], notes: '',
  }));
  assert.strictEqual(back2.weight, 59.46);
  // 整數與一位小數不可以被寫成 59.00 / 59.40
  const md = S.serializeDay({ date: '2026-07-25', weight: 59, entries: [], moves: [], notes: '' });
  assert.ok(md.includes('weight: 59\n'), md.split('\n')[2]);
});

console.log('profile round-trip');

t('profile 欄位原樣回來', () => {
  const p = { sex: 'female', age: 34, height: 162, weight: 55, activity: 1.55, tdee: 0, goal: -300, model: 'claude-opus-5' };
  const back = S.parseProfile(S.serializeProfile(p));
  assert.strictEqual(back.sex, 'female');
  assert.strictEqual(back.age, 34);
  assert.strictEqual(back.height, 162);
  assert.strictEqual(back.weight, 55);
  assert.strictEqual(back.activity, 1.55);
  assert.strictEqual(back.goal, -300);
  assert.strictEqual(back.model, 'claude-opus-5');
});

t('身體資料的體重也留兩位小數（以前被 round() 進位成整數）', () => {
  const back = S.parseProfile(S.serializeProfile({
    sex: 'male', age: 27, height: 168, weight: 59.45, activity: 1.2, goal: -300,
  }));
  assert.strictEqual(back.weight, 59.45, '打 59.45 存進去不可以變成 59');
});

t('生日：填了就由生日推算年齡，生日過了自動 +1', () => {
  const today = new Date();
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  // 生日剛好是今天 -> 整整 30 歲
  const hadBirthday = new Date(today.getFullYear() - 30, today.getMonth(), today.getDate());
  assert.strictEqual(S.ageFromBirth(iso(hadBirthday)), 30, '生日當天要算滿歲');

  // 生日還沒到（明天）-> 還是 29 歲
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const notYet = new Date(today.getFullYear() - 30, tomorrow.getMonth(), tomorrow.getDate());
  if (notYet.getMonth() !== today.getMonth() || notYet.getDate() !== today.getDate()) {
    assert.strictEqual(S.ageFromBirth(iso(notYet)), 29, '今年還沒過生日要少一歲');
  }

  // 存檔時 age 由生日蓋掉：故意填一個錯的年齡
  const back = S.parseProfile(S.serializeProfile({ age: 99, birth: iso(hadBirthday), height: 170, weight: 70 }));
  assert.strictEqual(back.birth, iso(hadBirthday), '生日要原樣存回來');
  assert.strictEqual(back.age, 30, '有生日時 age 一律以生日為準（自己填的 99 要被蓋掉）');
});

t('生日：格式不對／不存在的日期／未來日期一律當沒填', () => {
  const next = new Date(); next.setFullYear(next.getFullYear() + 1);
  const futureIso = next.getFullYear() + '-01-01';
  ['', '1990/01/01', '90-1-1', '1990-02-30', '1899-12-31', futureIso, 'abc'].forEach((v) => {
    assert.strictEqual(S.cleanBirth(v), '', JSON.stringify(v) + ' 應該被當作沒填');
  });
  // 沒填生日時，自己輸入的年齡要留著（不強迫交出生日）
  const back = S.parseProfile(S.serializeProfile({ age: 41, birth: '1990-02-30', height: 170, weight: 70 }));
  assert.strictEqual(back.birth, '');
  assert.strictEqual(back.age, 41, '生日無效時要沿用自己填的年齡');
});

t('生日：舊的 profile 檔（沒有 birth 這行）照樣讀得動', () => {
  const legacy = ['---', 'sex: "male"', 'age: 27', 'height: 168', 'weight: 80',
    'activity: 1.2', 'tdee: 0', 'goal: -300', 'proteinPerKg: 1.6', 'fatPct: 25',
    'model: "claude-sonnet-5"', 'updatedAt: "2026-07-25T10:11:50.481Z"', '---', ''].join('\n');
  const back = S.parseProfile(legacy);
  assert.strictEqual(back.birth, '', '沒有 birth 就是空字串');
  assert.strictEqual(back.age, 27, '沒有生日時年齡照舊');
  assert.strictEqual(back.updatedAt, '2026-07-25T10:11:50.481Z', '其他欄位不受影響');
});

t('缺檔／亂七八糟的 profile 落到安全預設', () => {
  const back = S.parseProfile('這不是 frontmatter');
  assert.strictEqual(back.sex, 'male');
  assert.ok(back.activity >= 1 && back.activity <= 2.5);
});

t('離譜的數值被夾住（不會產生負熱量目標）', () => {
  const back = S.parseProfile(S.serializeProfile({ age: 9999, height: -5, weight: 0, activity: 99 }));
  assert.ok(back.age <= 120 && back.age >= 1);
  assert.ok(back.height >= 80);
  assert.ok(back.weight >= 20);
  assert.strictEqual(back.activity, 1.375, '超出範圍的活動係數要落回預設');
});

t('updatedAt 只在寫入時蓋，讀取要原樣帶回（「還沒設定過」判斷靠它）', () => {
  // 從沒存過的 profile：updatedAt 必須是空字串，前端才知道要跳設定引導
  assert.strictEqual(S.defaultProfile().updatedAt, '', '預設 profile 的 updatedAt 要是空的');
  assert.strictEqual(S.parseProfile('這不是 frontmatter').updatedAt, '', '讀不到檔時 updatedAt 要是空的');

  // 存過一次之後：檔案裡有時間戳，且讀回來要是「存檔時間」而不是「讀檔時間」
  const md = S.serializeProfile({ sex: 'male', age: 30, height: 170, weight: 65 });
  const stamped = S.parseProfile(md).updatedAt;
  assert.ok(stamped, '存檔後 updatedAt 不可為空');
  const again = S.parseProfile(md).updatedAt;
  assert.strictEqual(again, stamped, '重複讀取不可以改變 updatedAt');
});

console.log('foods round-trip');

t('常吃清單原樣回來、次數保留', () => {
  const list = [
    { id: 'f1', name: '滷肉飯', kcal: 480, p: 12, c: 62, f: 19, portion: '小碗', n: 7 },
    { id: 'f2', name: '無糖豆漿', kcal: 130, p: 11, c: 9, f: 6, n: 1 },
  ];
  const back = S.parseFoods(S.serializeFoods(list));
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].name, '滷肉飯');
  assert.strictEqual(back[0].n, 7);
  assert.strictEqual(back[1].kcal, 130);
});

t('常吃清單：釘選（star）存得住，沒釘的不寫這個欄位', () => {
  const md = S.serializeFoods([
    { id: 'a', name: '無糖豆漿', kcal: 30, p: 3, c: 1, f: 2, portion: '半杯', star: true, n: 3 },
    { id: 'b', name: '芒果', kcal: 90, p: 1, c: 23, n: 1 },
  ]);
  const back = S.parseFoods(md);
  assert.strictEqual(back[0].star, true, '釘選的要存回來');
  assert.strictEqual(back[1].star, undefined, '沒釘選的不要多寫一個欄位出來');
  assert.strictEqual(back[0].kcal, 30);
  assert.strictEqual(back[1].name, '芒果');
  // 舊的 foods.md 沒有 star 這個 key，照樣讀得動
  const legacy = ['## 食物', '', '- {"id":"x","name":"燒餅","kcal":280,"n":2}', ''].join('\n');
  assert.strictEqual(S.parseFoods(legacy)[0].star, undefined);
  assert.strictEqual(S.parseFoods(legacy)[0].name, '燒餅');
});

console.log('安全性');

t('safeDate 擋掉 path traversal 與亂格式', () => {
  assert.strictEqual(S.safeDate('2026-07-25'), '2026-07-25');
  assert.strictEqual(S.safeDate('../../etc/passwd'), '');
  assert.strictEqual(S.safeDate('2026-7-5'), '');
  assert.strictEqual(S.safeDate('2026-07-25/../x'), '');
  assert.strictEqual(S.safeDate(''), '');
});

console.log('使用者名冊');

t('使用者 round-trip：id／名字／頭像／顏色都原樣回來', () => {
  const list = [
    { id: 'mabc-benson', name: 'Benson', emoji: '🐻', color: '#2fa86a', createdAt: '2026-07-25T00:00:00.000Z' },
    { id: 'mabd-女友', name: '小美', emoji: '🌸', color: '#e0447f', createdAt: '2026-07-25T00:01:00.000Z' },
  ];
  const back = S.parseUsers(S.serializeUsers(list));
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].name, 'Benson');
  assert.strictEqual(back[1].emoji, '🌸');
  assert.strictEqual(back[1].id, 'mabd-女友', '中文 id 不可被 mangle');
});

t('id 重複只留第一個（兩個人不能指到同一個資料夾）', () => {
  const back = S.normalizeUsers([{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }]);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].name, 'A');
});

t('沒給 id 會自動生成，且生成的 id 通得過 safeName', () => {
  const u = S.cleanUser({ name: '小美' });
  assert.ok(u.id, '要有 id');
  assert.strictEqual(S.safeName(u.id), u.id, '生成的 id 不可被 safeName 改寫');
});

t('safeName 與 slugify 字元集一致（travel-book QA B1 的教訓）', () => {
  for (const name of ['小美', 'ベンソン', '벤슨', 'Benson']) {
    const id = Date.now().toString(36) + '-' + S.slugify(name);
    assert.strictEqual(S.safeName(id), id, name + ' 的 id 被 mangle 了');
  }
});

t('壞掉的名冊行跳過，不整檔炸掉', () => {
  const md = ['## 使用者', '', '- {"id":"a","name":"A"}', '- {壞了', '- {"id":"b","name":"B"}', ''].join('\n');
  assert.strictEqual(S.parseUsers(md).length, 2);
});

console.log('前後端 mirror 一致性');

t('store.js 與 server.js 的區段標題／欄位順序一致', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'public', 'store.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // 這幾個字串一改就會兩邊分岔，資料在電腦端與手機端會長不一樣
  for (const marker of ['## 飲食', '## 運動', '## 講評', '## 備註', '## 食物', '## 使用者']) {
    assert.ok(store.indexOf(marker) >= 0, 'store.js 缺少區段 ' + marker);
    assert.ok(server.indexOf(marker) >= 0, 'server.js 缺少區段 ' + marker);
  }
  for (const key of ['sex:', 'age:', 'birth:', 'height:', 'weight:', 'activity:', 'tdee:', 'goal:', 'model:']) {
    assert.ok(store.indexOf('"' + key.slice(0, -1) + '"') >= 0 || store.indexOf(key) >= 0,
      'store.js profile 缺 ' + key);
    assert.ok(server.indexOf(key) >= 0, 'server.js profile 缺 ' + key);
  }
});

console.log('每日提醒（push.md）');

const SUB = { id: 'p1', u: 'mabc-benson', time: '07:30', tz: -480,
  endpoint: 'https://web.push.apple.com/AAA-bbb_ccc', skipIfWeighed: true };

t('提醒 round-trip：欄位原樣回來', () => {
  const back = S.parsePushSubs(S.serializePushSubs([SUB]));
  assert.deepStrictEqual(back, [SUB]);
});

t('sentAt 有寫才留（沒送過的不要多一個空欄位）', () => {
  assert.ok(!/sentAt/.test(S.serializePushSubs([SUB])));
  const withSent = Object.assign({}, SUB, { sentAt: '2026-08-03' });
  assert.strictEqual(S.parsePushSubs(S.serializePushSubs([withSent]))[0].sentAt, '2026-08-03');
});

t('同一台裝置只留一筆 ← 重新訂閱會拿到同樣的 endpoint，不去重會每天收到兩則', () => {
  const dup = [SUB, Object.assign({}, SUB, { id: 'p2', time: '09:00' })];
  assert.strictEqual(S.normalizePushSubs(dup).length, 1);
});

t('缺 endpoint／缺使用者的整筆丟掉（推不到的訂閱留著只會每天白送）', () => {
  assert.strictEqual(S.normalizePushSubs([
    Object.assign({}, SUB, { endpoint: '' }),
    Object.assign({}, SUB, { u: '', endpoint: 'https://x/1' }),
  ]).length, 0);
});

t('壞掉的時間退回 07:30，不是拿去算出一個半夜的提醒', () => {
  assert.strictEqual(S.cleanPushSub(Object.assign({}, SUB, { time: '25:99' })).time, '07:30');
  assert.strictEqual(S.cleanPushSub(Object.assign({}, SUB, { time: '7:5' })).time, '07:30');
});

t('skipIfWeighed 預設是開的（沒寫 ＝ 開）', () => {
  assert.strictEqual(S.cleanPushSub({ id: 'a', u: 'b', endpoint: 'https://x/1' }).skipIfWeighed, true);
  assert.strictEqual(S.cleanPushSub(Object.assign({}, SUB, { skipIfWeighed: false })).skipIfWeighed, false);
});

t('tz 是數字：字串「-480」也要收成 -480 ← 存成字串會讓送出端整個時區算錯', () => {
  assert.strictEqual(S.cleanPushSub(Object.assign({}, SUB, { tz: '-480' })).tz, -480);
});

t('push.md 的 parser 三邊逐字相同（store.js / server.js / tools/send-reminders.js）', () => {
  /* 這個檔案有三份 parser：手機寫、電腦寫、GitHub Actions 讀。
     任何一邊分岔的症狀都是「通知就是不跳」，而且完全沒有錯誤訊息可看。 */
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'store.js'), 'utf8');
  const sandbox = {
    location: { hostname: 'localhost', search: '' },
    localStorage: { getItem: () => '', setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.reject(new Error('no network in test')),
    TextEncoder, TextDecoder, btoa: () => '', atob: () => '',
  };
  const front = new Function(...Object.keys(sandbox),
    src + '\n;return {serializePushSubs, parsePushSubs};')(...Object.values(sandbox));

  const senderSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'send-reminders.js'), 'utf8');
  // 送出端是個會自己跑起來的腳本，只把 parser 那幾個函式挖出來當函式庫用
  const cut = senderSrc.slice(senderSrc.indexOf('function num('), senderSrc.indexOf('/* ---- 使用者當地時間'));
  const sender = new Function(cut + '\n;return {serializePushSubs, parsePushSubs};')();

  const list = [SUB, Object.assign({}, SUB, { id: 'p2', u: 'x-gf', time: '09:00',
    endpoint: 'https://web.push.apple.com/ZZZ', skipIfWeighed: false, sentAt: '2026-08-03' })];
  const a = S.serializePushSubs(list);
  assert.strictEqual(front.serializePushSubs(list), a, 'store.js 與 server.js 不一致');
  assert.strictEqual(sender.serializePushSubs(list), a, 'tools/send-reminders.js 與 server.js 不一致');
  assert.deepStrictEqual(front.parsePushSubs(a), S.parsePushSubs(a), 'store.js 的 parse 不一致');
  assert.deepStrictEqual(sender.parsePushSubs(a), S.parsePushSubs(a), '送出端的 parse 不一致');
});

t('前端 store.js 的 serializeDay 產出與 server.js 逐字相同', () => {
  // 在 Node 裡把 store.js 當純函式庫載入（它只有在最後幾行碰 location/localStorage，
  // 所以先塞最小的 stub 進去）
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'store.js'), 'utf8');
  const sandbox = {
    location: { hostname: 'localhost', search: '' },
    localStorage: { getItem: () => '', setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.reject(new Error('no network in test')),
    TextEncoder, TextDecoder, btoa: () => '', atob: () => '',
  };
  const fn = new Function(...Object.keys(sandbox), src + '\n;return {serializeDay, serializeProfile, serializeFoods, serializeUsers};');
  const front = fn(...Object.values(sandbox));

  const day = {
    date: '2026-07-25', weight: 70, updatedAt: '2026-07-25T01:00:00.000Z',
    entries: [{ id: 'a1', time: '08:12', meal: 'breakfast', name: '蛋餅', kcal: 380, p: 15, c: 42, f: 16,
      portion: '一份', src: 'ai' }],
    moves: [{ id: 'm1', time: '19:00', name: '慢跑', kcal: 300 }],
    notes: '備註',
  };
  assert.strictEqual(front.serializeDay(day), S.serializeDay(day), 'day 序列化兩邊必須逐字相同');

  const foods = [{ id: 'f1', name: '滷肉飯', kcal: 480, p: 12, c: 62, f: 19, portion: '小碗', n: 7 }];
  assert.strictEqual(front.serializeFoods(foods), S.serializeFoods(foods), 'foods 序列化兩邊必須逐字相同');

  const roster = [{ id: 'mabc-benson', name: 'Benson', emoji: '🐻', color: '#2fa86a', createdAt: '2026-07-25T00:00:00.000Z' }];
  assert.strictEqual(front.serializeUsers(roster), S.serializeUsers(roster), 'users 序列化兩邊必須逐字相同');

  // profile 的 updatedAt 每次都是 now，比對時剔掉那一行
  const strip = (s) => s.replace(/^updatedAt: .*$/m, 'updatedAt: "X"');
  const prof = { sex: 'female', age: 34, height: 162, weight: 55, activity: 1.55, tdee: 0, goal: -300, model: 'claude-opus-5' };
  assert.strictEqual(strip(front.serializeProfile(prof)), strip(S.serializeProfile(prof)),
    'profile 序列化兩邊必須逐字相同');
  // 生日推年齡也是鏡像邏輯，兩邊算出來必須一樣（不然手機與電腦的 TDEE 會差一歲）
  const withBirth = Object.assign({}, prof, { age: 99, birth: '1990-03-15' });
  assert.strictEqual(strip(front.serializeProfile(withBirth)), strip(S.serializeProfile(withBirth)),
    '有生日時 profile 序列化兩邊也必須逐字相同（含推算出來的 age）');
});

console.log('\n' + pass + ' passed' + (process.exitCode ? ', 有失敗' : ''));
