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

module.exports = { BASE, clearAll, seedUser };
