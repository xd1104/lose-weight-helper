'use strict';
/* 瀏覽器測試的狀態重置。
 * 每支測試都動同一個本機 server 的資料，不重置就會互相污染
 * （前一支留下的飲食累加到同一天，後一支的斷言就會亂噴假警報）。
 * 用法見各測試開頭。 */
const BASE = process.env.LWH_BASE || 'http://localhost:3619';

async function clearAll() {
  const res = await fetch(BASE + '/api/users');
  const { users } = await res.json();
  for (const u of users || []) {
    await fetch(BASE + '/api/users/' + encodeURIComponent(u.id), { method: 'DELETE' });
  }
}

/* 建一位測試使用者並填好身體資料，回傳 uid */
async function seedUser(profile) {
  await clearAll();
  const id = 't-b';
  await fetch(BASE + '/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: [{ id, name: 'Benson', emoji: '🐻', color: '#2fa86a' }] }),
  });
  await fetch(BASE + '/api/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u: id, profile: Object.assign(
      { sex: 'male', age: 32, height: 175, weight: 78, activity: 1.375, goal: -400,
        proteinPerKg: 1.6, fatPct: 25 }, profile || {}) }),
  });
  return id;
}

/* 設定頁是索引式的：控制項都在各自的 sheet 裡，要先點進去。
 * sec: body | activity | goal | macros | ai | gh | users | data */
async function openSet(page, sec) {
  await page.evaluate(() => { if (typeof closeAllSheets === 'function') closeAllSheets(); });
  await page.click('[data-nav="settings"]');
  await page.waitForTimeout(450);
  await page.click('[data-sec="' + sec + '"]');
  await page.waitForTimeout(550);
}

/* 設定 sheet 開著的時候底下的導覽列點不到，換頁前要先關 */
async function closeSet(page) {
  await page.evaluate(() => { if (typeof closeAllSheets === 'function') closeAllSheets(); });
  await page.waitForTimeout(250);
}

/* v6.4 起「今天」頁的每一餐都是收起來的一列，細項要點開才在 DOM 裡。
 * 任何要點 .row[data-act="edit-entry"] 的測試，前面都要先叫這個。 */
async function openMeals(page) {
  /* ⚠️ 一次抓一個、每次重新查詢：點下去會整頁重畫，先抓好的那批 handle 會全部脫離 DOM。 */
  const SEL = '.meal-row[data-act="fold-meal"][aria-expanded="false"]';
  for (let i = 0; i < 6; i++) {
    const f = await page.$(SEL);
    if (!f) break;
    await f.click().catch(() => {});
    await page.waitForTimeout(260);
  }
  await page.waitForTimeout(200);
}

module.exports = { BASE, clearAll, seedUser, openSet, closeSet, openMeals };
