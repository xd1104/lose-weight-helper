'use strict';
/* 每日提醒的送出端。由 .github/workflows/daily-reminder.yml 每 30 分鐘叫一次。
 *
 * 為什麼是 GitHub Actions：手機推播一定要有一台機器主動送，而這個 app 兩台都不合格
 * ——GitHub Pages 是靜態的不會主動做事，家裡的 server.js 外面連不到、電腦關機就沒了。
 * Actions 排程剛好是免費又一直在的那台。
 *
 * 零套件（跟 server.js 一樣的規矩）：VAPID 的 ES256 簽章與 RFC 8291 的內容加密
 * （ECDH P-256 + HKDF + AES-128-GCM）Node 內建 crypto 都有。
 *
 * v5.2 起改送「有內容」的推播。原本送無內容的（文字寫死在 sw.js），
 * Apple 回 201 收下了、手機卻不顯示——payload-less 是 iOS 上唯一不確定的環節，
 * 與其猜不如直接消除。舊訂閱沒存加密金鑰時仍會退回無內容送法。
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
/* 測試用：不管時間、不管今天送過沒、不管量過體重，馬上推一發給所有人。
 * 從 Actions 頁面 Run workflow 勾「force」進來的，用來確認整條路（金鑰、簽章、
 * 訂閱）是通的——不然要等到隔天早上才知道有沒有設錯。
 * 刻意不寫 sentAt：測試不該把今天真正的提醒吃掉。 */
const FORCE = /^(1|true|yes)$/i.test(process.env.FORCE || '');

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
  if (s && s.p256dh) o.p256dh = String(s.p256dh);
  if (s && s.auth) o.auth = String(s.auth);
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
    const o = { id: s.id, u: s.u, time: s.time, tz: s.tz, endpoint: s.endpoint };
    if (s.p256dh) o.p256dh = s.p256dh;
    if (s.auth) o.auth = s.auth;
    o.skipIfWeighed = s.skipIfWeighed;
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

/* ---- RFC 8291：把通知內容加密 ----
 * 推播服務只是個中繼站，看不到內容——金鑰是瀏覽器產的，只有那台裝置解得開。
 * 所以這段一定要對，錯了症狀是手機收到卻不顯示（跟沒送到長得一模一樣）。 */
function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
}
function encryptPayload(p256dhB64, authB64, text) {
  const ua = Buffer.from(p256dhB64, 'base64url');      // 裝置公鑰（65 bytes）
  const auth = Buffer.from(authB64, 'base64url');      // 裝置的 auth secret（16 bytes）
  const es = crypto.createECDH('prime256v1');
  es.generateKeys();
  const as = es.getPublicKey();                        // 這次專用的臨時公鑰
  const ikm = hkdf(auth, es.computeSecret(ua),
    Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 明文結尾要接一個 0x02 當 padding delimiter，少了它瀏覽器會解不開
  const body = Buffer.concat([
    c.update(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([as.length]), as, body]);
}

async function sendPush(sub, key, text) {
  const headers = {
    Authorization: vapidHeader(sub.endpoint, key),
    TTL: '10800',                // 手機關機的話，3 小時內開機仍然收得到
  };
  let body;
  if (sub.p256dh && sub.auth) {
    body = encryptPayload(sub.p256dh, sub.auth, text);
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Length'] = String(body.length);
  } else {
    // 舊訂閱沒存金鑰：退回無內容，文字用 sw.js 裡的預設
    headers['Content-Length'] = '0';
  }
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return res.status;
}

/* 通知文字。有內容的推播才看得到這個，無內容的會用 sw.js 的預設。 */
function noticeFor() {
  return JSON.stringify({ title: '早安 ☀️ 量個體重吧', body: '30 秒的事。順便把昨天沒記的補一補。' });
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

    if (!FORCE) {
      if (s.sentAt === L.date) { keep.push(s); continue; }               // 今天送過了
      if (L.minutes < want) { keep.push(s); continue; }                  // 還沒到時間
      if (L.minutes >= want + WINDOW_MIN) {                              // 錯過太久：跳過今天，別半夜才跳
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
    }

    if (DRY) { console.log('[dry-run] 會送：' + label); keep.push(s); continue; }

    let status = 0;
    try { status = await sendPush(s, key, noticeFor()); }
    catch (e) { console.log('送出失敗（網路）：' + label + ' － ' + e.message); keep.push(s); continue; }

    if (status === 404 || status === 410) {
      // 訂閱已失效（app 被刪掉、重灌）。留著只會每天白送，直接清掉。
      console.log('訂閱已失效，移除：' + label + '（' + status + '）');
      changed = true;
      continue;
    }
    if (status >= 200 && status < 300) {
      console.log('已送出：' + label + '（' + status + '）'
        + (s.p256dh && s.auth ? ' 有內容' : ' 無內容(舊訂閱)') + (FORCE ? ' [force]' : ''));
      // force 是測試，不記 sentAt——否則今天真正的提醒會被這一發吃掉
      if (FORCE) { keep.push(s); continue; }
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
