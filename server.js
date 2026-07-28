'use strict';

/*
 * 減重助手（lose-weight-helper）— 本機 Node server（零執行期依賴）
 * - 服務 ./public 的 PWA 前端
 * - 多使用者：Benson 與女友各自獨立，資料完全不共用
 *     使用者名冊 ./data/users.md
 *     每人一個資料夾 ./data/users/<uid>/
 *       ├─ profile.md          身體資料／目標／模型
 *       ├─ foods.md            常吃清單
 *       └─ days/YYYY-MM-DD.md  每天一個檔
 * - 寫入成功後自動 git add/commit -> pull(-X ours) -> push（GitHub 為同步中樞）
 * 架構比照 travel-book（port 3618）；本專案 port 3619。
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.md');
const USERS_DIR = path.join(DATA_DIR, 'users');

const PORT = process.env.PORT || 3619;

for (const d of [DATA_DIR, USERS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/* 每位使用者的檔案位置 */
function userDir(uid) { return path.join(USERS_DIR, uid); }
function profileFile(uid) { return path.join(userDir(uid), 'profile.md'); }
function foodsFile(uid) { return path.join(userDir(uid), 'foods.md'); }
function daysDir(uid) { return path.join(userDir(uid), 'days'); }

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// 日期就是檔名，只收嚴格的 YYYY-MM-DD（同時擋掉 path traversal）
function safeDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  return m ? m[0] : '';
}

// 使用者資料夾名。字元集必須與前端 slugify（\p{L}\p{N} ＋ ._-）完全一致，
// 否則手機端建的中文／日文名字會在電腦端被 mangle 成另一個資料夾
// → 同一個人跨裝置分裂成兩份資料（travel-book QA B1 的教訓）
function safeName(name) {
  return path.basename(String(name || '')).replace(/[^\p{L}\p{N}._\-]+/gu, '_');
}
function slugify(str) {
  const base = String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'user';
}

// 原子寫入：先寫私有 temp 檔再 rename 蓋過目標（同磁碟 rename 是原子的）
async function atomicWrite(file, data, encoding) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp~' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  try {
    await fsp.writeFile(tmp, data, encoding || 'utf8');
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 自動同步 GitHub（debounce 的 git add/commit/pull/push）              */
/* ------------------------------------------------------------------ */
const AUTO_SYNC = process.env.AUTO_SYNC !== '0';
let syncEnabled = false; // 啟動時偵測到 origin remote 才開
let syncBranch = 'main';
let syncTimer = null;
let syncing = false;
let syncPending = false;

function gitCmd(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(((stderr || stdout || err.message) + '').slice(0, 400)));
      else resolve((stdout || '') + '');
    });
  });
}

function scheduleSync() {
  if (!AUTO_SYNC || !syncEnabled) return;
  syncPending = true;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 2500); // 連續存檔只同步一次
}

// push 前先 pull，把手機端的變更合併進來；同檔衝突固定「電腦版本勝（-X ours）」
async function pullRemote(tag) {
  try {
    await gitCmd(['pull', '--no-edit', '--no-rebase', '-X', 'ours', 'origin', syncBranch]);
    console.log('[sync] ' + tag + ' pull ok');
  } catch (e) {
    console.error('[sync] ' + tag + ' pull failed (continuing):', e.message);
  }
}

async function runSync() {
  if (syncing) return; // 進行中；syncPending 會補跑
  syncing = true;
  syncPending = false;
  try {
    await gitCmd(['add', '-A']);
    const status = await gitCmd(['status', '--porcelain']);
    if (status.trim()) {
      await gitCmd(['commit', '-m', 'auto: sync data ' + new Date().toISOString()]);
    }
    await pullRemote('pre-push');
    await gitCmd(['push', 'origin', 'HEAD']);
    console.log('[sync] pushed to GitHub');
  } catch (e) {
    // 同步失敗絕不影響使用者的存檔，只記 log
    console.error('[sync] failed:', e.message);
  } finally {
    syncing = false;
    if (syncPending) scheduleSync();
  }
}

async function initSync() {
  if (!AUTO_SYNC) { console.log('[sync] disabled (AUTO_SYNC=0)'); return; }
  // ROOT 必須自己就是 repo 根（有 .git）才同步。
  // 這道守門是刻意的：本專案若被放進「別的 repo 的子資料夾」暫存，
  // 沒有它就會把那個 repo 整包 add -A / push 出去。
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.log('[sync] ' + ROOT + ' is not a git repo root; auto-push disabled');
    return;
  }
  try {
    const url = (await gitCmd(['remote', 'get-url', 'origin'])).trim();
    if (!url) throw new Error('no origin');
    try { syncBranch = (await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main'; } catch { syncBranch = 'main'; }
    syncEnabled = true;
    console.log('[sync] enabled -> ' + url + ' (' + syncBranch + ')');
    // 啟動先 pull 一次，把手機端新增的資料接回電腦
    await pullRemote('startup');
  } catch {
    console.log('[sync] no git remote "origin"; auto-push disabled');
  }
}

/* ------------------------------------------------------------------ */
/* 資料 <-> markdown（frontmatter + 每列一筆 JSON）序列化                */
/* 格式定案見專案 CLAUDE.md；前端 store.js 有同一套 mirror，改就要一起改  */
/* ------------------------------------------------------------------ */

function fmString(v) { return JSON.stringify(String(v == null ? '' : v)); }
function fmNumber(v) { const n = Number(v); return String(isFinite(n) ? n : 0); }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function round(v) { return Math.round(num(v)); }
// 三大營養素保留一位小數：食品標示常常是「蛋白質 2.5 g」，全部進位成整數，
// 一天記十筆就會累積出可觀的誤差。熱量維持整數（0.5 大卡沒有意義）。
// ⚠️ 與 public/store.js 的 round1 是鏡像。
function round1(v) { return Math.round(num(v) * 10) / 10; }

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];

/* ---- 使用者名冊 ---- */
const USER_COLORS = ['#2fa86a', '#3b82f6', '#e0952c', '#a855f7', '#e0447f', '#0e7490'];

function cleanUser(u) {
  const o = {
    id: safeName((u && u.id) || ''),
    name: String((u && u.name) || '').trim().slice(0, 20) || '未命名',
    emoji: String((u && u.emoji) || '🙂').slice(0, 8),
    color: String((u && u.color) || ''),
    createdAt: String((u && u.createdAt) || new Date().toISOString()),
  };
  if (!/^#[0-9a-fA-F]{3,8}$/.test(o.color)) o.color = USER_COLORS[0];
  if (!o.id) o.id = Date.now().toString(36) + '-' + slugify(o.name);
  return o;
}
function normalizeUsers(list) {
  const out = [];
  const seen = {};
  for (const u of Array.isArray(list) ? list : []) {
    const o = cleanUser(u);
    if (seen[o.id]) continue; // id 重複只留第一個，避免兩個人指到同一個資料夾
    seen[o.id] = true;
    out.push(o);
  }
  return out;
}
function serializeUsers(list) {
  const L = ['## 使用者', ''];
  for (const u of normalizeUsers(list)) {
    L.push('- ' + JSON.stringify({ id: u.id, name: u.name, emoji: u.emoji, color: u.color, createdAt: u.createdAt }));
  }
  L.push('');
  return L.join('\n');
}
function parseUsers(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const im = /^-\s+(\{.*\})\s*$/.exec(line);
    if (!im) continue;
    try { out.push(JSON.parse(im[1])); } catch { /* 壞列跳過 */ }
  }
  return normalizeUsers(out);
}
async function readUsers() {
  try { return parseUsers(await fsp.readFile(USERS_FILE, 'utf8')); }
  catch { return []; } // 還沒有任何使用者：前端會顯示「新增第一位使用者」
}

/* ---- 飲食 / 運動 / 常吃 ---- */
// 固定 key 順序、空值不寫，讓 md 檔乾淨且 diff 穩定
function cleanEntry(e) {
  const o = { id: String((e && e.id) || '') };
  o.time = String((e && e.time) || '');
  o.meal = MEALS.indexOf(e && e.meal) >= 0 ? e.meal : 'snack';
  o.name = String((e && e.name) || '');
  o.kcal = round(e && e.kcal);
  if (num(e && e.p)) o.p = round1(e.p);
  if (num(e && e.c)) o.c = round1(e.c);
  if (num(e && e.f)) o.f = round1(e.f);
  if (e && e.portion) o.portion = String(e.portion);
  if (e && e.note) o.note = String(e.note);
  if (e && e.src) o.src = String(e.src); // ai | manual | preset（來源，供之後檢討估算準度）
  return o;
}
function cleanMove(m) {
  const o = { id: String((m && m.id) || '') };
  o.time = String((m && m.time) || '');
  o.name = String((m && m.name) || '');
  o.kcal = round(m && m.kcal);
  return o;
}
function cleanFood(f) {
  const o = { id: String((f && f.id) || ''), name: String((f && f.name) || '') };
  o.kcal = round(f && f.kcal);
  if (num(f && f.p)) o.p = round1(f.p);
  if (num(f && f.c)) o.c = round1(f.c);
  if (num(f && f.f)) o.f = round1(f.f);
  if (f && f.portion) o.portion = String(f.portion);
  // star＝使用者主動釘選的「真的常吃」，排最上面（記過的東西都會進這份清單，
  // 很快就幾十筆、大半只吃過一次，不釘選就找不到常吃的那幾樣）。
  // ⚠️ 與 public/store.js 的 cleanFood 是鏡像。
  if (f && f.star) o.star = true;
  o.n = Math.max(1, round(f && f.n) || 1); // 用過次數：常吃清單的排序依據
  return o;
}

function serializeDay(d) {
  const L = [];
  L.push('---');
  L.push('date: ' + fmString(d.date));
  L.push('weight: ' + fmNumber(d.weight)); // 0 = 當天沒量
  L.push('updatedAt: ' + fmString(d.updatedAt || new Date().toISOString()));
  L.push('---');
  L.push('');
  L.push('## 飲食');
  L.push('');
  for (const e of d.entries || []) L.push('- ' + JSON.stringify(cleanEntry(e)));
  L.push('');
  L.push('## 運動');
  L.push('');
  for (const m of d.moves || []) L.push('- ' + JSON.stringify(cleanMove(m)));
  L.push('');
  L.push('## 講評');
  L.push('');
  const co = cleanCoach(d.coach);
  if (co) L.push('- ' + JSON.stringify(co));
  L.push('');
  L.push('## 備註');
  L.push('');
  const notes = String(d.notes || '').replace(/\r\n/g, '\n');
  if (notes.trim()) L.push(notes.trimEnd());
  L.push('');
  return L.join('\n');
}

function parseFrontmatterLine(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  const raw = line.slice(idx + 1).trim();
  let value;
  try { value = JSON.parse(raw); } catch { value = raw.replace(/^["']|["']$/g, ''); }
  return [key, value];
}

// AI 營養師講評（一天最多一則，重新評估就覆蓋）。存在那一天的檔案裡：
// 跟日期綁在一起、跨裝置同步、刪掉那天就一起刪。
// ⚠️ 與 public/store.js 的 cleanCoach 是鏡像，改要一起改。
function cleanCoach(c) {
  if (!c || !String(c.verdict || '').trim()) return null;
  const arr = (v) => (Array.isArray(v) ? v : [])
    .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4);
  return {
    at: String(c.at || ''),
    verdict: String(c.verdict || '').trim(),
    good: arr(c.good),
    issues: arr(c.issues),
    next: String(c.next || '').trim(),
  };
}

function emptyDay(date) {
  return { date: date, weight: 0, updatedAt: '', entries: [], moves: [], coach: null, notes: '' };
}

function parseDay(date, text) {
  const d = emptyDay(date);
  text = String(text).replace(/\r\n/g, '\n'); // 容忍 CRLF（Windows checkout/pull 後）
  let body = text;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const parsed = parseFrontmatterLine(line);
      if (!parsed) continue;
      const [k, v] = parsed;
      if (k === 'weight') d.weight = num(v);
      else if (k === 'updatedAt') d.updatedAt = String(v);
      // date 以檔名為準，frontmatter 只是給人看的
    }
    body = text.slice(fm[0].length);
  }
  let section = null;
  let inNotes = false; // 備註永遠是最後一段：進入後整段原樣收，內文的 ## 不再當標題
  const notesBuf = [];
  for (const line of body.split('\n')) {
    if (inNotes) { notesBuf.push(line); continue; }
    const h2 = /^##\s+(.+)$/.exec(line.trim());
    if (h2) {
      const name = h2[1].trim();
      if (name === '飲食') section = 'eat';
      else if (name === '運動') section = 'move';
      else if (name === '講評') section = 'coach';
      else if (name === '備註') { inNotes = true; }
      else section = null;
      continue;
    }
    const im = /^-\s+(\{.*\})\s*$/.exec(line);
    if (!im) continue;
    let obj;
    try { obj = JSON.parse(im[1]); } catch { continue; } // 壞列跳過，不整檔炸掉
    if (section === 'eat') d.entries.push(cleanEntry(obj));
    else if (section === 'move') d.moves.push(cleanMove(obj));
    else if (section === 'coach') d.coach = cleanCoach(obj);
  }
  d.notes = notesBuf.join('\n').trim();
  return d;
}

function defaultProfile() {
  return {
    sex: 'male', age: 30,
    birth: '',       // 生日 YYYY-MM-DD（選填）：填了就由它推算年齡，生日過了自動 +1
    height: 170, weight: 65,
    activity: 1.375, // 久坐1.2／輕度1.375／中度1.55／高度1.725／極高1.9
    tdee: 0,         // >0 = 手動覆寫，0 = 用 Mifflin-St Jeor 自動算
    goal: 0,         // 每日熱量調整：-400 減脂、0 維持、+300 增肌
    proteinPerKg: 1.6, // 蛋白質目標 = 體重 × 這個係數（減脂期常見 1.6–2.2）
    fatPct: 25,        // 脂肪目標 = 目標熱量 × 這個百分比 ÷ 9
    model: 'claude-sonnet-5',
    updatedAt: '',
  };
}
// 生日（YYYY-MM-DD，選填）。填了之後 age 一律由它推算——cleanProfile 每次讀檔／存檔
// 都會重算，所以生日一過年齡就自己 +1，BMR 與 TDEE 跟著更新。
// 格式不合、不存在的日期（2-30）、未來日期，一律當作沒填。
// ⚠️ 與 public/store.js 的 cleanBirth / ageFromBirth 是鏡像，改要一起改。
function cleanBirth(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const y = +s.slice(0, 4), mo = +s.slice(5, 7), da = +s.slice(8, 10);
  if (y < 1900 || mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return '';
  const now = new Date();
  if (d > new Date(now.getFullYear(), now.getMonth(), now.getDate())) return '';
  return s;
}
function ageFromBirth(birth) {
  const s = cleanBirth(birth);
  if (!s) return 0;
  const y = +s.slice(0, 4), mo = +s.slice(5, 7), da = +s.slice(8, 10);
  const now = new Date();
  let a = now.getFullYear() - y;
  const m = (now.getMonth() + 1) - mo;
  if (m < 0 || (m === 0 && now.getDate() < da)) a--;
  return Math.max(0, a);
}

function cleanProfile(p) {
  const d = defaultProfile();
  const o = {
    sex: (p && p.sex) === 'female' ? 'female' : 'male',
    age: Math.min(120, Math.max(1, round((p && p.age) || d.age))),
    birth: cleanBirth(p && p.birth),
    height: Math.min(260, Math.max(80, round((p && p.height) || d.height))),
    weight: Math.min(400, Math.max(20, round((p && p.weight) || d.weight))),
    activity: num(p && p.activity) || d.activity,
    tdee: Math.max(0, round(p && p.tdee)),
    goal: round(p && p.goal),
    proteinPerKg: num(p && p.proteinPerKg) || d.proteinPerKg,
    fatPct: num(p && p.fatPct) || d.fatPct,
    model: String((p && p.model) || d.model),
    // 讀取時原樣保留：這裡若蓋成 now，updatedAt 就變成「剛才讀檔的時間」而不是
    // 「上次存檔的時間」，前端「還沒設定過身體資料」的判斷會永遠失效。
    // 真正的時間戳在 serializeProfile 落檔那一刻蓋。
    updatedAt: String((p && p.updatedAt) || ''),
  };
  if (!(o.activity >= 1 && o.activity <= 2.5)) o.activity = d.activity;
  // 夾在有醫學意義的範圍：蛋白質過低沒有保留肌肉的效果，過高沒有額外好處
  if (!(o.proteinPerKg >= 0.8 && o.proteinPerKg <= 3)) o.proteinPerKg = d.proteinPerKg;
  // 脂肪低於 15% 會影響荷爾蒙，高於 45% 就擠掉蛋白質與碳水了
  if (!(o.fatPct >= 15 && o.fatPct <= 45)) o.fatPct = d.fatPct;
  // 有生日就以生日為準（每次讀寫都重算 -> 生日過了自動加一歲）
  if (o.birth) o.age = Math.min(120, Math.max(1, ageFromBirth(o.birth)));
  return o;
}
function serializeProfile(p) {
  const o = cleanProfile(p);
  o.updatedAt = new Date().toISOString(); // 寫入＝這一刻才是 updatedAt
  const L = ['---'];
  L.push('sex: ' + fmString(o.sex));
  L.push('age: ' + fmNumber(o.age));
  L.push('birth: ' + fmString(o.birth));
  L.push('height: ' + fmNumber(o.height));
  L.push('weight: ' + fmNumber(o.weight));
  L.push('activity: ' + fmNumber(o.activity));
  L.push('tdee: ' + fmNumber(o.tdee));
  L.push('goal: ' + fmNumber(o.goal));
  L.push('proteinPerKg: ' + fmNumber(o.proteinPerKg));
  L.push('fatPct: ' + fmNumber(o.fatPct));
  L.push('model: ' + fmString(o.model));
  L.push('updatedAt: ' + fmString(o.updatedAt));
  L.push('---', '');
  return L.join('\n');
}
function parseProfile(text) {
  const p = defaultProfile();
  const t = String(text).replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!fm) return p;
  for (const line of fm[1].split('\n')) {
    const parsed = parseFrontmatterLine(line);
    if (!parsed) continue;
    const [k, v] = parsed;
    if (k === 'sex' || k === 'model' || k === 'updatedAt' || k === 'birth') p[k] = String(v);
    else if (k in p) p[k] = num(v);
  }
  return cleanProfile(p);
}

function serializeFoods(list) {
  const L = ['## 食物', ''];
  for (const f of Array.isArray(list) ? list : []) L.push('- ' + JSON.stringify(cleanFood(f)));
  L.push('');
  return L.join('\n');
}
function parseFoods(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const im = /^-\s+(\{.*\})\s*$/.exec(line);
    if (!im) continue;
    try { out.push(cleanFood(JSON.parse(im[1]))); } catch { /* 壞列跳過 */ }
  }
  return out;
}

/* ---- 讀取（缺檔一律回安全預設，不落地寫檔） ---- */
async function readProfile(uid) {
  try { return parseProfile(await fsp.readFile(profileFile(uid), 'utf8')); }
  catch { return defaultProfile(); }
}
async function readFoods(uid) {
  try { return parseFoods(await fsp.readFile(foodsFile(uid), 'utf8')); }
  catch { return []; }
}
async function readDay(uid, date) {
  try { return parseDay(date, await fsp.readFile(path.join(daysDir(uid), date + '.md'), 'utf8')); }
  catch { return emptyDay(date); } // 沒記錄的日子 = 空的一天
}

/* ------------------------------------------------------------------ */
/* v1 -> v2 遷移：單人版的 data/profile.md 等搬進第一位使用者資料夾       */
/* 冪等：users.md 已存在就完全不動                                       */
/* ------------------------------------------------------------------ */
async function migrateSingleUserIfNeeded() {
  if (fs.existsSync(USERS_FILE)) return false;
  const oldProfile = path.join(DATA_DIR, 'profile.md');
  const oldFoods = path.join(DATA_DIR, 'foods.md');
  const oldDays = path.join(DATA_DIR, 'days');
  const hasOld = fs.existsSync(oldProfile) || fs.existsSync(oldFoods)
    || (fs.existsSync(oldDays) && fs.readdirSync(oldDays).some((f) => f.endsWith('.md')));
  if (!hasOld) return false;

  const u = cleanUser({ name: '我', emoji: '🙂', color: USER_COLORS[0] });
  await fsp.mkdir(daysDir(u.id), { recursive: true });
  if (fs.existsSync(oldProfile)) await fsp.rename(oldProfile, profileFile(u.id));
  if (fs.existsSync(oldFoods)) await fsp.rename(oldFoods, foodsFile(u.id));
  if (fs.existsSync(oldDays)) {
    for (const f of await fsp.readdir(oldDays)) {
      if (f.endsWith('.md')) await fsp.rename(path.join(oldDays, f), path.join(daysDir(u.id), f));
    }
    try { await fsp.rm(oldDays, { recursive: true, force: true }); } catch { /* 還有別的檔就留著 */ }
  }
  await atomicWrite(USERS_FILE, serializeUsers([u]), 'utf8');
  console.log('[migrate] 單人版資料已搬進使用者 "' + u.name + '" (' + u.id + ')');
  return true;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

// 每個涉及個人資料的端點都必須指定 u=<uid>，避免寫錯人
function uidOf(url) { return safeName(url.searchParams.get('u') || ''); }

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // GET /api/users -> 使用者名冊（Netflix 式切換畫面用）
  if (p === '/api/users' && method === 'GET') {
    return sendJson(res, 200, { users: await readUsers() });
  }

  // POST /api/users（整份名冊覆蓋：新增／改名／換頭像都走這支）
  if (p === '/api/users' && method === 'POST') {
    const body = await readJson(req);
    const list = normalizeUsers(body.users || body);
    await atomicWrite(USERS_FILE, serializeUsers(list), 'utf8');
    for (const u of list) await fsp.mkdir(daysDir(u.id), { recursive: true });
    scheduleSync();
    return sendJson(res, 200, { ok: true, users: await readUsers() });
  }

  // DELETE /api/users/:id（連同該使用者的所有紀錄一起刪）
  const userSingle = /^\/api\/users\/([^/]+)$/.exec(p);
  if (userSingle && method === 'DELETE') {
    const uid = safeName(decodeURIComponent(userSingle[1]));
    if (!uid) return sendJson(res, 400, { ok: false, message: '缺少使用者 id。' });
    const list = (await readUsers()).filter((u) => u.id !== uid);
    await atomicWrite(USERS_FILE, serializeUsers(list), 'utf8');
    try { await fsp.rm(userDir(uid), { recursive: true, force: true }); } catch { /* 已不存在 */ }
    scheduleSync();
    return sendJson(res, 200, { ok: true, users: await readUsers() });
  }

  // 以下都是「某一位使用者」的資料
  const uid = uidOf(url);

  // GET /api/core?u=<uid> -> profile + foods（前端切換使用者後先拿這包）
  if (p === '/api/core' && method === 'GET') {
    if (!uid) return sendJson(res, 400, { ok: false, message: '缺少使用者 id。' });
    return sendJson(res, 200, { profile: await readProfile(uid), foods: await readFoods(uid) });
  }

  // GET /api/days?u=<uid>&dates=2026-07-25,2026-07-24
  // 刻意「按日期取」而不是列整個資料夾：GitHubStore 那邊一天一個 API 請求，
  // 列全部會隨著使用月數線性變慢。
  if (p === '/api/days' && method === 'GET') {
    if (!uid) return sendJson(res, 400, { ok: false, message: '缺少使用者 id。' });
    const dates = String(url.searchParams.get('dates') || '')
      .split(',').map(safeDate).filter(Boolean).slice(0, 400);
    const days = [];
    for (const d of dates) days.push(await readDay(uid, d));
    return sendJson(res, 200, { days });
  }

  // GET /api/days/index?u=<uid> -> 有記錄的日期清單（歷史頁用）
  if (p === '/api/days/index' && method === 'GET') {
    if (!uid) return sendJson(res, 400, { ok: false, message: '缺少使用者 id。' });
    let files = [];
    try { files = await fsp.readdir(daysDir(uid)); } catch { /* 資料夾還沒建 */ }
    const dates = files.filter((f) => f.endsWith('.md'))
      .map((f) => safeDate(f.replace(/\.md$/, ''))).filter(Boolean).sort();
    return sendJson(res, 200, { dates });
  }

  // POST /api/profile  { u, profile }
  if (p === '/api/profile' && method === 'POST') {
    const body = await readJson(req);
    const id = safeName(body.u || uid);
    if (!id) return sendJson(res, 400, { ok: false, message: '缺少使用者 id。' });
    const prof = cleanProfile(body.profile || body);
    await atomicWrite(profileFile(id), serializeProfile(prof), 'utf8');
    scheduleSync();
    return sendJson(res, 200, { ok: true, profile: prof });
  }

  // POST /api/foods  { u, foods }（整份清單覆蓋）
  if (p === '/api/foods' && method === 'POST') {
    const body = await readJson(req);
    const id = safeName(body.u || uid);
    if (!id) return sendJson(res, 400, { ok: false, message: '缺少使用者 id。' });
    const list = (Array.isArray(body.foods) ? body.foods : []).map(cleanFood);
    await atomicWrite(foodsFile(id), serializeFoods(list), 'utf8');
    scheduleSync();
    return sendJson(res, 200, { ok: true, foods: list });
  }

  // POST /api/days  { u, ...day }（單日整份更新）
  if (p === '/api/days' && method === 'POST') {
    const body = await readJson(req);
    const id = safeName(body.u || uid);
    if (!id) return sendJson(res, 400, { ok: false, message: '缺少使用者 id。' });
    const date = safeDate(body.date);
    if (!date) return sendJson(res, 400, { ok: false, message: '日期格式錯誤（需 YYYY-MM-DD）。' });
    const day = Object.assign(emptyDay(date), body, { date, updatedAt: new Date().toISOString() });
    const isEmpty = !(day.entries || []).length && !(day.moves || []).length
      && !String(day.notes || '').trim() && !num(day.weight);
    const file = path.join(daysDir(id), date + '.md');
    if (isEmpty) {
      // 一整天被清空就把檔案刪掉，不要留一堆空殼 md
      try { await fsp.unlink(file); } catch { /* 本來就不存在 */ }
    } else {
      await atomicWrite(file, serializeDay(day), 'utf8');
    }
    scheduleSync();
    return sendJson(res, 200, { ok: true, day: await readDay(id, date) });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  return streamFile(res, file);
}

function streamFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!res.headersSent) {
      if (/payload too large/i.test(msg)) {
        sendJson(res, 413, { ok: false, code: 'too_large', message: '資料太大，超過伺服器上限。' });
      } else if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, code: 'bad_json', message: '請求格式錯誤。' });
      } else {
        sendJson(res, 500, { ok: false, code: 'server_error', message: '伺服器錯誤：' + msg });
      }
    } else res.end();
  }
});

// require.main 守門：被 test 引入時只拿 parser/serializer，不要真的開 server
if (require.main === module) {
  // 啟動先鏡射 docs/（保證從任何入口啟動 docs/ 都不落後 public/）；
  // build 失敗只記 log，不擋本機服務
  try {
    require('./build.js').build();
  } catch (e) {
    console.error('[build] failed (continuing):', e.message);
  }

  server.listen(PORT, async () => {
    console.log('Lose Weight Helper server running at http://localhost:' + PORT);
    console.log('Data dir: ' + DATA_DIR);
    await initSync(); // 先 pull（若手機端剛建了使用者，避免遷移邏輯誤判）
    try {
      if (await migrateSingleUserIfNeeded()) scheduleSync();
    } catch (e) {
      console.error('[migrate] failed:', e.message);
    }
  });
}

module.exports = {
  serializeDay, parseDay, serializeProfile, parseProfile,
  serializeFoods, parseFoods, serializeUsers, parseUsers,
  defaultProfile, cleanEntry, cleanCoach, cleanUser, normalizeUsers, safeDate, safeName, slugify,
  cleanBirth, ageFromBirth,
};
