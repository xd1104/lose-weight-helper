'use strict';
/* 每日提醒的送出端。由 .github/workflows/daily-reminder.yml 每 30 分鐘叫一次。
 *
 * 為什麼是 GitHub Actions：手機推播一定要有一台機器主動送，而這個 app 兩台都不合格
 * ——GitHub Pages 是靜態的不會主動做事，家裡的 server.js 外面連不到、電腦關機就沒了。
 * Actions 排程剛好是免費又一直在的那台。
 *
 * 零套件（跟 server.js 一樣的規矩）：VAPID 只需要 ES256 簽章，Node 內建 crypto 就有。
 * 而且刻意送「沒有內容的推播」——帶內容要做 ECDH + HKDF + AES-GCM 加密，
 * 文字反正是固定的，寫在 sw.js 裡就好。
 *
 * 一天只吵一次：送完把 sentAt 寫回 data/push.md 並 commit。
 * 不靠「排程準時」來去重——Actions 誤點 5～30 分鐘是常態，用時間窗去推會漏送或重送。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUSH_FILE = path.join(ROOT, 'data', 'push.md');

/* 公鑰不是祕密（瀏覽器本來就拿得到），所以寫死在這裡當預設值——
 * 這樣要設定的只有 VAPID_PRIVATE 一個 secret，少一個會忘記的步驟。
 * ⚠️ 必須跟 public/app.js 的 VAPID_PUBLIC 完全一樣，不一樣就推不動而且沒有錯誤訊息。
 *    test/reminders.js 有比對這兩個字串。 */
const VAPID_PUBLIC = process.env.VAPID_PUBLIC
  || 'BBlsPY61wGRzCZKpmz2nrnWGWlXyRjxIF0H1l5b2G9TjaV5JheSfRxG-Q8reWflHgPp7YrFgB0x1h2yQo8jQ74U';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const VAPID_SUB = process.env.VAPID_SUBJECT || 'mailto:a0970797036@gmail.com';
const DRY = process.argv.includes('--dry-run');

/* 提醒時間之後多久內還算數。超過就不送了——早上 7:30 的提醒中午才跳出來只會讓人困惑。
 * 排程每 30 分鐘一次，所以正常情況下窗口一開就會被第一次執行接到。 */
const WINDOW_MIN = 120;

/* ---- data/push.md 的 parser（mirror：server.js / public/store.js 各有一份）---- */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function cleanPushSub(s) {
  const o = { id: String((s && s.id) || '') };
  o.u = String((s && s.u) || '');
  o.time = /^([01]\d|2[0-3]):[0-5]\d$/.test(s && s.time) ? s.time : '07:30';
  o.tz = Math.round(num(s && s.tz));
  o.endpoint = String((s && s.endpoint) || '');
  o.skipIfWeighed = (s && s.skipIfWeighed) !== false;
  if (s && s.sentAt) o.sentAt = String(s.sentAt);
  return o;
}
function normalizePushSubs(list) {
  const out = [], seen = {};
  for (const s of Array.isArray(list) ? list : []) {
    const o = cleanPushSub(s);
    if (!o.id || !o.u || !o.endpoint) continue;
    if (seen[o.endpoint]) continue;
    seen[o.endpoint] = 1;
    out.push(o);
  }
  return out;
}
function serializePushSubs(list) {
  const L = ['## 提醒', ''];
  for (const s of normalizePushSubs(list)) {
    const o = { id: s.id, u: s.u, time: s.time, tz: s.tz, endpoint: s.endpoint, skipIfWeighed: s.skipIfWeighed };
    if (s.sentAt) o.sentAt = s.sentAt;
    L.push('- ' + JSON.stringify(o));
  }
  L.push('');
  return L.join('\n');
}
function parsePushSubs(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const im = /^-\s+(\{.*\})\s*$/.exec(line);
    if (!im) continue;
    try { out.push(JSON.parse(im[1])); } catch { /* 壞列跳過 */ }
  }
  return normalizePushSubs(out);
}

/* ---- 使用者當地時間 ----
 * tz ＝ 瀏覽器的 getTimezoneOffset()，台灣是 -480（UTC+8）。
 * 所以「當地時間 = UTC - tz 分鐘」。 */
function localNow(tz, nowMs) {
  const d = new Date(nowMs - tz * 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    date: d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
function targetMinutes(hhmm) {
  const m = /^(\d\d):(\d\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 450;
}

/* 當天有沒有量體重。資料就在 repo 裡（手機直接寫 GitHub、電腦靠同步推上來），
 * 所以不用打任何 API，讀檔就好。 */
function weighedOn(userId, dateKey) {
  const f = path.join(ROOT, 'data', 'users', userId, 'days', dateKey + '.md');
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return false; }
  const m = /^weight:\s*([\d.]+)\s*$/m.exec(txt.replace(/\r\n/g, '\n'));
  return !!(m && Number(m[1]) > 0);
}

/* ---- VAPID ----
 * 私鑰只有 d（secret），x/y 從公鑰拆出來——公鑰本來就公開，前端也有同一份。 */
function vapidKey() {
  const raw = Buffer.from(VAPID_PUBLIC, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('VAPID_PUBLIC 格式不對（要 65 bytes 的未壓縮公鑰）');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
      d: VAPID_PRIVATE,
    },
  });
}
function vapidHeader(endpoint, key) {
  const aud = new URL(endpoint).origin;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ typ: 'JWT', alg: 'ES256' });
  // 有效期最長 24 小時；抓 12 小時，時鐘有點偏差也還在範圍內
  const body = b64({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: VAPID_SUB });
  // ES256 的簽章必須是 raw r||s（64 bytes），不是 Node 預設的 DER
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + sig.toString('base64url') + ', k=' + VAPID_PUBLIC;
}

async function sendPush(endpoint, key) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(endpoint, key),
      TTL: '10800',              // 手機關機的話，3 小時內開機仍然收得到
      'Content-Length': '0',
    },
  });
  return res.status;
}

(async () => {
  let subs = [];
  try { subs = parsePushSubs(fs.readFileSync(PUSH_FILE, 'utf8')); }
  catch { console.log('沒有 data/push.md －－ 還沒有人開提醒，收工'); return; }
  if (!subs.length) { console.log('push.md 是空的，收工'); return; }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) throw new Error('缺 VAPID_PUBLIC / VAPID_PRIVATE');
  const key = vapidKey();
  const now = Date.now();

  let changed = false;
  const keep = [];
  for (const s of subs) {
    const L = localNow(s.tz, now);
    const want = targetMinutes(s.time);
    const label = s.u + ' ' + s.time + '（當地 ' + L.date + '）';

    if (s.sentAt === L.date) { keep.push(s); continue; }                 // 今天送過了
    if (L.minutes < want) { keep.push(s); continue; }                    // 還沒到時間
    if (L.minutes >= want + WINDOW_MIN) {                                 // 錯過太久：跳過今天，別半夜才跳
      console.log('略過（超過窗口）：' + label);
      keep.push(Object.assign({}, s, { sentAt: L.date }));
      changed = true;
      continue;
    }
    if (s.skipIfWeighed && weighedOn(s.u, L.date)) {
      console.log('略過（今天量過了）：' + label);
      keep.push(Object.assign({}, s, { sentAt: L.date }));
      changed = true;
      continue;
    }

    if (DRY) { console.log('[dry-run] 會送：' + label); keep.push(s); continue; }

    let status = 0;
    try { status = await sendPush(s.endpoint, key); }
    catch (e) { console.log('送出失敗（網路）：' + label + ' － ' + e.message); keep.push(s); continue; }

    if (status === 404 || status === 410) {
      // 訂閱已失效（app 被刪掉、重灌）。留著只會每天白送，直接清掉。
      console.log('訂閱已失效，移除：' + label + '（' + status + '）');
      changed = true;
      continue;
    }
    if (status >= 200 && status < 300) {
      console.log('已送出：' + label + '（' + status + '）');
      keep.push(Object.assign({}, s, { sentAt: L.date }));
      changed = true;
      continue;
    }
    // 其他錯誤（429 之類）不要記 sentAt，下一次排程再試
    console.log('送出失敗：' + label + '（' + status + '）');
    keep.push(s);
  }

  if (!changed) { console.log('沒有變動'); return; }
  if (keep.length) fs.writeFileSync(PUSH_FILE, serializePushSubs(keep), 'utf8');
  else { try { fs.unlinkSync(PUSH_FILE); } catch { /* 已經不在 */ } }
  console.log('push.md 已更新');
})().catch((e) => { console.error(e); process.exit(1); });
