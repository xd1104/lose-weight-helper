'use strict';
/* tools/send-reminders.js 的邏輯測試（不碰真的推播服務，自己起一台假的）。
 *
 * 這支的重點是「該送的時候才送、而且一天只送一次」。排程會誤點 5～30 分鐘是常態，
 * 所以任何「靠排程準時」的寫法都會漏送或重送——這裡把誤點的情境直接測出來。
 *
 * 也驗 VAPID 簽章是真的可以被公鑰驗回去的：簽錯了推播服務只會回 401，
 * 而那時候是「通知不會跳」，從 app 這端完全看不出原因。
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const ROOT = path.join(__dirname, '..');
const PUB = 'BBlsPY61wGRzCZKpmz2nrnWGWlXyRjxIF0H1l5b2G9TjaV5JheSfRxG-Q8reWflHgPp7YrFgB0x1h2yQo8jQ74U';
const PRIV = 'C16Csdbly0he6mZZaDhp7CHvY1MsEXUZMhvm1k4ZIQE';

let pass = 0;
/* ⚠️ 一定要 async。假的推播服務跟測試跑在同一個 process 裡，
 * 用 execFileSync 叫子行程會把 event loop 卡住——子行程打進來的請求永遠不會被接，
 * 兩邊互等直接死鎖（踩過，測試整個沒有輸出就停在那裡）。 */
async function t(name, fn) {
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

/* ---- 假的推播服務：收下請求、記下來、回我們指定的狀態碼 ---- */
const hits = [];
let reply = 201;
const server = http.createServer((req, res) => {
  hits.push({ url: req.url, auth: req.headers.authorization || '' });
  res.writeHead(reply); res.end();
});

/* 把 repo 複製一份到暫存目錄再跑，免得測試動到真的 data/ */
function sandbox(pushMd, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwh-push-'));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'send-reminders.js'), path.join(dir, 'tools', 'send-reminders.js'));
  if (pushMd !== null) fs.writeFileSync(path.join(dir, 'data', 'push.md'), pushMd, 'utf8');
  for (const [rel, body] of Object.entries(files || {})) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, 'utf8');
  }
  return dir;
}
function run(dir, extraEnv) {
  return execFileP(process.execPath, [path.join(dir, 'tools', 'send-reminders.js')], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { VAPID_PUBLIC: PUB, VAPID_PRIVATE: PRIV }, extraEnv || {}),
  }).then((r) => r.stdout);
}
const readPush = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'data', 'push.md'), 'utf8'); } catch { return null; }
};

/* 造一筆「當地時間剛過提醒時間 10 分鐘」的訂閱。
   tz 用台灣的 -480，提醒時間由現在的 UTC 時間往回推，測試才不會挑時段跑。 */
function subDueNow(port, over, extra) {
  const tz = -480;
  const local = new Date(Date.now() - tz * 60000);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes() - (over === undefined ? 10 : over);
  const wrapped = ((mins % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return Object.assign({
    id: 's1', u: 'benson', time: hh + ':' + mm, tz,
    endpoint: 'http://127.0.0.1:' + port + '/push/abc', skipIfWeighed: true,
  }, extra || {});
}
const todayLocal = () => {
  const d = new Date(Date.now() + 480 * 60000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
};
const md = (list) => '## 提醒\n\n' + list.map((s) => '- ' + JSON.stringify(s)).join('\n') + '\n';

server.listen(0, async () => {
  const port = server.address().port;
  console.log('每日提醒的送出邏輯');

  await t('時間到了就送出，並把 sentAt 記成當地日期', async () => {
    hits.length = 0; reply = 201;
    const dir = sandbox(md([subDueNow(port)]));
    const out = await run(dir);
    assert.strictEqual(hits.length, 1, '應該送出一次，實際 ' + hits.length + '\n' + out);
    assert.ok(readPush(dir).includes('"sentAt":"' + todayLocal() + '"'), 'sentAt 沒寫回去：' + readPush(dir));
  });

  await t('同一天再跑一次不會重送 ← 排程每 30 分鐘一次，沒去重的話一個早上會吵好幾遍', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port, 10, { sentAt: todayLocal() })]));
    await run(dir);
    assert.strictEqual(hits.length, 0, '不該再送');
  });

  await t('還沒到時間不送', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port, -60)]));   // 提醒時間在一小時後
    await run(dir);
    assert.strictEqual(hits.length, 0);
  });

  await t('誤點超過 2 小時就跳過今天 ← 早上的提醒不該中午才跳出來', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port, 200)]));
    await run(dir);
    assert.strictEqual(hits.length, 0, '不該送');
    assert.ok(readPush(dir).includes('"sentAt"'), '要記成今天已處理，不然下一輪又進來一次');
  });

  await t('誤點 25 分鐘照樣送得出去 ← GitHub 排程誤點是常態，不能靠準時', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port, 25)]));
    await run(dir);
    assert.strictEqual(hits.length, 1);
  });

  await t('當天量過體重就不吵（skipIfWeighed）', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port)]), {
      ['data/users/benson/days/' + todayLocal() + '.md']:
        '---\ndate: "' + todayLocal() + '"\nweight: 78.4\nupdatedAt: "x"\n---\n',
    });
    await run(dir);
    assert.strictEqual(hits.length, 0, '量過了還送');
  });

  await t('weight: 0 ＝ 當天沒量，還是要提醒', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port)]), {
      ['data/users/benson/days/' + todayLocal() + '.md']:
        '---\ndate: "' + todayLocal() + '"\nweight: 0\nupdatedAt: "x"\n---\n',
    });
    await run(dir);
    assert.strictEqual(hits.length, 1, '只記了飲食沒量體重，這正是最該提醒的情況');
  });

  await t('關掉「量過就不吵」的話，量過了也照樣提醒', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port, 10, { skipIfWeighed: false })]), {
      ['data/users/benson/days/' + todayLocal() + '.md']:
        '---\ndate: "' + todayLocal() + '"\nweight: 78.4\nupdatedAt: "x"\n---\n',
    });
    await run(dir);
    assert.strictEqual(hits.length, 1);
  });

  await t('410 ＝ 訂閱失效，直接從清單移除（不然每天白送）', async () => {
    hits.length = 0; reply = 410;
    const dir = sandbox(md([subDueNow(port)]));
    await run(dir);
    assert.strictEqual(readPush(dir), null, '最後一筆被移除後整個檔要刪掉');
    reply = 201;
  });

  await t('429 之類的暫時錯誤不記 sentAt ← 下一輪要能再試', async () => {
    hits.length = 0; reply = 429;
    const dir = sandbox(md([subDueNow(port)]));
    await run(dir);
    assert.ok(!/sentAt/.test(readPush(dir) || ''), '暫時失敗不可以當成已送出');
    reply = 201;
  });

  await t('沒有 push.md 就安靜收工（沒人開提醒是正常狀態，不是錯誤）', async () => {
    const dir = sandbox(null);
    const out = await run(dir);
    assert.ok(/還沒有人開提醒/.test(out), out);
  });

  await t('兩個人各自的時間互不影響', async () => {
    hits.length = 0;
    const dir = sandbox(md([
      subDueNow(port, 10, { id: 's1', u: 'benson', endpoint: 'http://127.0.0.1:' + port + '/push/a' }),
      subDueNow(port, -90, { id: 's2', u: 'girlfriend', endpoint: 'http://127.0.0.1:' + port + '/push/b' }),
    ]));
    await run(dir);
    assert.strictEqual(hits.length, 1, '只有到時間的那位要送');
    assert.ok(hits[0].url.endsWith('/a'), hits[0].url);
    const left = readPush(dir);
    assert.ok(/girlfriend/.test(left), '另一位的訂閱不可以被寫掉');
  });

  await t('時區真的有換算 ← tz 錯了會在半夜跳通知', async () => {
    hits.length = 0;
    /* 同樣的 07:30，台灣（-480）跟倫敦（0）是不同的 UTC 時刻。
       把時間設在「台灣當地剛過 10 分鐘」，倫敦那筆就不該送。 */
    const tw = subDueNow(port, 10, { id: 's1', endpoint: 'http://127.0.0.1:' + port + '/push/tw' });
    const uk = Object.assign({}, tw, { id: 's2', tz: 0, endpoint: 'http://127.0.0.1:' + port + '/push/uk' });
    const dir = sandbox(md([tw, uk]));
    await run(dir);
    assert.strictEqual(hits.length, 1, '兩筆同樣的 time 但時區不同，只該送一筆');
    assert.ok(hits[0].url.endsWith('/tw'), hits[0].url);
  });

  await t('VAPID 簽章用公鑰驗得回去 ← 簽錯只會拿到 401，通知靜靜不跳', async () => {
    const auth = hits[hits.length - 1].auth;
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=(.+)$/.exec(auth);
    assert.ok(m, 'Authorization 格式不對：' + auth);
    assert.strictEqual(m[4], PUB, 'k= 要是公鑰本人');
    const raw = Buffer.from(PUB, 'base64url');
    const pubKey = crypto.createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33, 65).toString('base64url') },
    });
    const ok = crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]),
      { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
    assert.ok(ok, 'ES256 簽章驗不過');
    const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString());
    assert.strictEqual(payload.aud, 'http://127.0.0.1:' + port, 'aud 要是推播服務的 origin');
    assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'exp 已過期');
    assert.ok(payload.exp - Math.floor(Date.now() / 1000) <= 86400, 'exp 不可以超過 24 小時');
    assert.ok(/^(mailto:|https:)/.test(payload.sub), 'sub 要是 mailto: 或 https:');
  });

  await t('缺金鑰時要大聲失敗（不要安靜地什麼都沒送）', async () => {
    const dir = sandbox(md([subDueNow(port)]));
    let threw = false;
    try { await run(dir, { VAPID_PRIVATE: '' }); } catch { threw = true; }
    assert.ok(threw, '缺金鑰應該非零離開，不是安靜跳過');
  });

  await t('FORCE=1 不管時間直接送，而且不記 sentAt ← 測試不該把今天真正的提醒吃掉', async () => {
    hits.length = 0; reply = 201;
    /* 提醒時間在 5 小時前（早就過了窗口），平常這一筆今天不會送 */
    const dir = sandbox(md([subDueNow(port, 300)]));
    await run(dir, { FORCE: '1' });
    assert.strictEqual(hits.length, 1, 'force 應該照送');
    assert.ok(!/sentAt/.test(readPush(dir) || ''), 'force 不可以記 sentAt');
  });

  await t('FORCE 也不看「今天量過了」← 它的用途是確認整條路通不通', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port)]), {
      ['data/users/benson/days/' + todayLocal() + '.md']:
        '---\ndate: "' + todayLocal() + '"\nweight: 78.4\nupdatedAt: "x"\n---\n',
    });
    await run(dir, { FORCE: '1' });
    assert.strictEqual(hits.length, 1);
  });

  await t('FORCE 沒設的時候不可以誤判成開啟', async () => {
    hits.length = 0;
    const dir = sandbox(md([subDueNow(port, 300)]));
    await run(dir, { FORCE: 'false' });
    assert.strictEqual(hits.length, 0, 'FORCE=false 還照送的話，每 30 分鐘就會被吵一次');
  });

  await t('送出端與 public/app.js 的 VAPID 公鑰一致 ← 不一致就推不動，而且沒有錯誤訊息', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const sendSrc = fs.readFileSync(path.join(ROOT, 'tools', 'send-reminders.js'), 'utf8');
    const inApp = /var VAPID_PUBLIC="([\w-]+)"/.exec(appSrc);
    const inSend = /\|\|\s*'([\w-]+)';/.exec(sendSrc);
    assert.ok(inApp && inSend, '兩邊都要找得到公鑰');
    assert.strictEqual(inSend[1], inApp[1], '公鑰不一致');
    assert.strictEqual(Buffer.from(inApp[1], 'base64url').length, 65, '公鑰要是 65 bytes 的未壓縮點');
  });

  server.close();
  console.log('\n' + pass + ' passed' + (process.exitCode ? ', 有失敗' : ''));
});
