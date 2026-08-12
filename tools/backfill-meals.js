'use strict';
/* 一次性：從既有的每日紀錄回填常吃清單的 mc（每一餐各吃過幾次）。
 *
 * v5.8 起常吃清單會自動分成「早餐／午餐／晚餐／點心」，依據是 mc。
 * 但那個欄位是新的，既有的兩百多筆都沒有 —— 不回填的話升級當下所有東西
 * 都會掉進「其他」，分組等於沒有作用。歷史紀錄裡本來就有「哪一餐吃的」，
 * 直接算回去就好。
 *
 * 用法：node tools/backfill-meals.js [--dry-run]
 * 冪等：重跑會重算一次覆蓋掉，不會累加。
 */
const fs = require('fs');
const path = require('path');
const S = require('../server.js');

const ROOT = path.join(__dirname, '..');
const USERS_DIR = path.join(ROOT, 'data', 'users');
const DRY = process.argv.includes('--dry-run');
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];

/* 名稱比對的 key。⚠️ 必須跟 public/app.js 的 foodKey 一模一樣，
 * 不然回填會對不上那些「AI 每次名字有小差異」的項目（白飯／白飯（便當盒））。 */
function foodKey(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/[\s·・、,，.。!！?？~～\-—_]/g, '');
}

let touched = 0;
for (const uid of fs.readdirSync(USERS_DIR)) {
  const foodsFile = path.join(USERS_DIR, uid, 'foods.md');
  const daysDir = path.join(USERS_DIR, uid, 'days');
  if (!fs.existsSync(foodsFile)) continue;

  const foods = S.parseFoods(fs.readFileSync(foodsFile, 'utf8'));
  if (!foods.length) continue;

  // 先算出每個名稱 key 在各餐出現幾次
  const counts = {};
  let days = 0;
  if (fs.existsSync(daysDir)) {
    for (const fn of fs.readdirSync(daysDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(fn)) continue;
      days++;
      const d = S.parseDay(fn.replace(/\.md$/, ''), fs.readFileSync(path.join(daysDir, fn), 'utf8'));
      for (const e of d.entries || []) {
        const k = foodKey(e.name);
        if (!k || MEALS.indexOf(e.meal) < 0) continue;
        counts[k] = counts[k] || {};
        counts[k][e.meal] = (counts[k][e.meal] || 0) + 1;
      }
    }
  }

  let hit = 0;
  for (const f of foods) {
    const c = counts[foodKey(f.name)];
    if (!c) { delete f.mc; continue; }   // 對不上就留空，歸到「其他」
    f.mc = c;
    hit++;
  }

  const out = S.serializeFoods(foods);
  const grouped = foods.filter((f) => f.mc).length;
  console.log(`${uid}：${days} 天紀錄 · 常吃 ${foods.length} 筆 · 對上 ${hit} 筆 · 有分組 ${grouped} 筆`);
  if (!DRY) {
    fs.writeFileSync(foodsFile, out, 'utf8');
    touched++;
  }
}
console.log(DRY ? '\n[dry-run] 沒有寫入' : `\n已更新 ${touched} 個 foods.md`);
