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
  for (const marker of ['## 飲食', '## 運動', '## 備註', '## 食物', '## 使用者']) {
    assert.ok(store.indexOf(marker) >= 0, 'store.js 缺少區段 ' + marker);
    assert.ok(server.indexOf(marker) >= 0, 'server.js 缺少區段 ' + marker);
  }
  for (const key of ['sex:', 'age:', 'height:', 'weight:', 'activity:', 'tdee:', 'goal:', 'model:']) {
    assert.ok(store.indexOf('"' + key.slice(0, -1) + '"') >= 0 || store.indexOf(key) >= 0,
      'store.js profile 缺 ' + key);
    assert.ok(server.indexOf(key) >= 0, 'server.js profile 缺 ' + key);
  }
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
});

console.log('\n' + pass + ' passed' + (process.exitCode ? ', 有失敗' : ''));
