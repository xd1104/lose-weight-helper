'use strict';
/* 每日提醒（Web Push）的 app 這一端。
 *
 * 推播本身沒辦法在無頭瀏覽器裡真的走一遍（要真的推播服務、真的裝置），
 * 所以這裡把 Notification / pushManager 換成假的，測我們自己那一段：
 * 該不該給按、按了寫進 push.md 的東西對不對、關掉有沒有清乾淨。
 *
 *   A. 設定索引看得到，預設是關的
 *   B. iPhone 用 Safari 分頁開 -> 直接講「要先加入主畫面」，不要給一顆按了沒反應的按鈕
 *   C. 打開：權限 -> 訂閱 -> 寫進 push.md（時間、時區、使用者都要對）
 *   D. 先選 08:00 再打開，存的要是 08:00 而不是預設的 07:30
 *   E. 使用者按「不允許」-> 講清楚怎麼改，而且不可以留下一筆假的訂閱
 *   F. 關閉：要真的退訂，push.md 那一筆要消失
 *   G. ⚠️ 別台裝置／女友的訂閱不可以被蓋掉（同一個檔，整份覆蓋最容易出這種事）
 *   H. 已經開著時改時間，直接存回去
 *
 * ⚠️ 會清掉本機 server 上的所有使用者資料（_setup.js 的 clearAll），跑之前先備份 data/。
 */
const { chromium } = require('playwright');
const { BASE, seedUser } = require('./_setup');

const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const getPush = () => fetch(BASE + '/api/push').then((r) => r.json()).then((j) => j.subs || []);
const setPush = (subs) => fetch(BASE + '/api/push', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subs }),
});

const EP = 'https://web.push.apple.com/TEST-endpoint-benson';
/* 假的推播堆疊。真的那一套在無頭 Chromium 裡跑不起來（沒有推播服務），
   但我們要測的本來就是「app 拿到訂閱之後做了什麼」。 */
const stub = (perm, subscribed) => `
  window.__perm = ${JSON.stringify(perm)};
  window.__asked = 0;
  window.__unsub = 0;
  window.Notification = function () {};
  window.Notification.permission = window.__perm === 'granted' ? 'default' : window.__perm;
  window.Notification.requestPermission = function () {
    window.__asked++;
    return Promise.resolve(window.__perm);
  };
  window.PushManager = function () {};
  const fakeSub = {
    endpoint: ${JSON.stringify(EP)},
    toJSON: function () { return { keys: { p256dh: 'BPfake-p256dh', auth: 'BPfake-auth' } }; },
    unsubscribe: function () { window.__unsub++; window.__subbed = null; return Promise.resolve(true); },
  };
  /* subscribed=true ＝ 這台裝置本來就訂閱過（重開 app 之後的正常狀態）。
     app 是靠「瀏覽器手上有沒有訂閱」來認自己那一筆的，少了這個就會以為是關的。 */
  window.__subbed = ${subscribed ? 'fakeSub' : 'null'};
  Object.defineProperty(navigator.serviceWorker, 'ready', {
    configurable: true,
    get: function () {
      return Promise.resolve({
        pushManager: {
          getSubscription: function () { return Promise.resolve(window.__subbed); },
          subscribe: function (o) {
            window.__subOpts = { userVisibleOnly: o.userVisibleOnly, keyLen: (o.applicationServerKey || []).length };
            window.__subbed = fakeSub;
            return Promise.resolve(fakeSub);
          },
        },
      });
    },
  });
`;

(async () => {
  const u = await seedUser();
  await setPush([]);

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errs = [];

  const open = async (initScript, ua) => {
    const ctx = await b.newContext(Object.assign(
      { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
      ua ? { userAgent: ua } : {}));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript((id) => localStorage.setItem('lwh_user', id), u);
    if (initScript) await p.addInitScript(initScript);
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1600);
    return { ctx, p };
  };
  const openPush = async (p) => {
    await p.evaluate(() => closeAllSheets());
    await p.click('[data-nav="settings"]'); await p.waitForTimeout(450);
    await p.click('[data-sec="push"]'); await p.waitForTimeout(500);
  };

  console.log('\n[A] 設定索引看得到，預設是關的');
  let { ctx, p } = await open(stub('granted'));
  await p.click('[data-nav="settings"]'); await p.waitForTimeout(500);
  check('索引有「每日提醒」這一列', !!(await p.$('[data-sec="push"]')));
  check('摘要寫「關閉中」', /關閉中/.test(await p.textContent('[data-sec="push"]')),
    await p.textContent('[data-sec="push"]'));

  console.log('\n[C] 打開：權限 → 訂閱 → 寫進 push.md');
  await openPush(p);
  check('有時間可以選', (await p.$$('[data-ptime]')).length >= 6);
  check('預設勾「已經量過就不要吵我」', !!(await p.$('.opt-row.on')));
  await p.click('[data-push="on"]');
  await p.waitForTimeout(1800);
  check('有跟使用者要權限', (await p.evaluate(() => window.__asked)) === 1,
    await p.evaluate(() => window.__asked));
  check('userVisibleOnly 是 true ← iOS 硬性要求，false 會被直接撤銷訂閱',
    (await p.evaluate(() => window.__subOpts || {})).userVisibleOnly === true,
    await p.evaluate(() => window.__subOpts));
  check('送出去的是 65 bytes 的公鑰（不是那串 base64 字串本身）',
    (await p.evaluate(() => window.__subOpts || {})).keyLen === 65,
    await p.evaluate(() => window.__subOpts));
  let subs = await getPush();
  check('push.md 多了一筆', subs.length === 1, subs);
  check('綁的是這位使用者', subs[0] && subs[0].u === u, subs[0]);
  check('endpoint 存進去了', subs[0] && subs[0].endpoint === EP, subs[0]);
  check('有記時區 ← 少了它送出端會在半夜推通知',
    subs[0] && typeof subs[0].tz === 'number' && Math.abs(subs[0].tz) <= 840, subs[0]);
  check('預設 skipIfWeighed 是開的', subs[0] && subs[0].skipIfWeighed === true, subs[0]);
  check('有存加密金鑰 ← 少了它只能送無內容推播，iOS 上不一定會顯示',
    subs[0] && subs[0].p256dh === 'BPfake-p256dh' && subs[0].auth === 'BPfake-auth', subs[0]);
  check('設定頁改口成「每天 … 提醒」', /每天\s*\d\d:\d\d\s*提醒/.test(await p.textContent('#app')));

  console.log('\n[H] 開著的時候改時間，直接存回去');
  await openPush(p);
  await p.click('[data-ptime="09:00"]');
  await p.waitForTimeout(1500);
  subs = await getPush();
  check('存成 09:00', subs[0] && subs[0].time === '09:00', subs[0]);
  check('沒有變成兩筆', subs.length === 1, subs.length);

  console.log('\n[G] 別台裝置／女友的訂閱不可以被蓋掉');
  await ctx.close();
  await setPush([
    { id: 'gf', u: 'someone-else', time: '06:30', tz: -480, endpoint: 'https://web.push.apple.com/HER', skipIfWeighed: true },
    { id: 'me2', u, time: '09:00', tz: -480, endpoint: EP, skipIfWeighed: true },
  ]);
  /* 重開 app：裝置上本來就有訂閱，所以 stub 要回報 subscribed */
  ({ ctx, p } = await open(stub('granted', true)));
  await openPush(p);
  check('重開 app 之後認得出自己已經開著 ← 認的是瀏覽器手上的 endpoint',
    !!(await p.$('[data-push="off"]')));
  await p.click('[data-ptime="07:00"]');
  await p.waitForTimeout(1500);
  subs = await getPush();
  check('還是兩筆 ← 整份覆蓋前沒重讀的話，這裡會把女友的提醒無聲關掉',
    subs.length === 2, subs);
  check('女友那筆原封不動',
    (subs.filter((x) => x.u === 'someone-else')[0] || {}).time === '06:30', subs);
  check('自己那筆改成 07:00', (subs.filter((x) => x.u === u)[0] || {}).time === '07:00', subs);

  console.log('\n[I] v5.2 之前訂的沒有加密金鑰，開 app 時要自己補上（不用叫他重開一次）');
  await ctx.close();
  await setPush([
    { id: 'old', u, time: '07:30', tz: -480, endpoint: EP, skipIfWeighed: true },  // 沒有 p256dh/auth
  ]);
  ({ ctx, p } = await open(stub('granted', true)));
  await p.waitForTimeout(1500);
  subs = await getPush();
  check('金鑰被默默補上去了', subs[0] && subs[0].p256dh === 'BPfake-p256dh', subs[0]);
  check('其他欄位沒被動到', subs[0] && subs[0].time === '07:30' && subs[0].id === 'old', subs[0]);

  console.log('\n[J] 訂閱綁在另一位使用者身上時，還是要認得出來（v5.3 的真 bug）');
  /* 實際踩到的：訂閱是在「黏」底下開的，app 現在切到「肚」。
     以前用 (endpoint, 使用者) 去找自己那筆 -> 完全看不到：
     顯示「關閉中」、加密金鑰補不上去，而且在「肚」底下按打開會被去重規則默默丟掉。
     瀏覽器層面一台裝置只有一個訂閱，所以正確的鍵是 endpoint。 */
  await ctx.close();
  await fetch(BASE + '/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: [
      { id: u, name: 'Benson', emoji: '🐻', color: '#2fa86a' },
      { id: 'other-one', name: '黏', emoji: '🐱', color: '#e0447f' }] }),
  });
  await setPush([
    { id: 'bound', u: 'other-one', time: '07:30', tz: -480, endpoint: EP, skipIfWeighed: true },
  ]);
  ({ ctx, p } = await open(stub('granted', true)));   // 現在的使用者是 u，訂閱綁在 other-one
  await p.waitForTimeout(1600);
  subs = await getPush();
  check('金鑰照樣補得上去 ← 這正是他手機上卡住的地方',
    subs[0] && subs[0].p256dh === 'BPfake-p256dh', subs);
  check('補金鑰不會偷偷改綁定的人', subs[0] && subs[0].u === 'other-one', subs[0]);
  await openPush(p);
  check('設定頁顯示「開著」，不是「關閉中」', !!(await p.$('[data-push="off"]')));
  check('而且講明現在是看誰的體重', /目前是看「黏」有沒有量體重/.test(await p.textContent('.sheet')),
    (await p.textContent('.sheet')).slice(0, 200));
  await p.click('[data-ptime="08:30"]');
  await p.waitForTimeout(1500);
  subs = await getPush();
  check('動了設定就改綁現在這位 ← 不然會一直看錯人的紀錄',
    subs.length === 1 && subs[0].u === u && subs[0].time === '08:30', subs);
  await ctx.close();
  ({ ctx, p } = await open(stub('granted', true)));

  console.log('\n[K] 狀態一覽 ＋ 一鍵重新設定（v5.4）');
  /* 「通知沒跳」的成因有好幾種，從外面完全看不出是哪一種——猜了好幾輪都沒中。
     所以 app 要自己把每一關的狀態顯示出來，並且給一顆一次收掉所有情況的按鈕。 */
  await ctx.close();
  await setPush([
    { id: 'stale', u, time: '07:30', tz: -480, endpoint: 'https://web.push.apple.com/OLD-gone',
      skipIfWeighed: true },     // 雲端有一筆，但這台裝置的訂閱已經沒了
  ]);
  ({ ctx, p } = await open(stub('granted', false)));   // getSubscription() -> null
  await openPush(p);
  let panel = await p.textContent('.sheet');
  check('看得出訂閱不見了', /沒有（可能被 iOS 撤銷）/.test(panel), panel.slice(0, 260));
  check('有「重新設定」按鈕', !!(await p.$('[data-push="fix"]')));
  await p.click('[data-push="fix"]');
  await p.waitForTimeout(2000);
  subs = await getPush();
  const fresh = subs.filter((x) => x.endpoint === EP)[0];
  check('這台裝置多了一筆新的訂閱', !!fresh, subs);
  check('金鑰補齊了', fresh && fresh.p256dh === 'BPfake-p256dh' && fresh.auth === 'BPfake-auth', fresh);
  check('綁到目前這位使用者', fresh && fresh.u === u, fresh);
  /* 舊訂閱已經被 iOS 撤銷 -> app 無從得知雲端哪一筆是自己的（他可能還有第二台裝置）。
     刻意不猜著刪：這種孤兒紀錄由送出端收到 410 時自動清掉。 */
  check('猜不到的舊紀錄留著，交給 410 清（不要亂刪別台裝置的）',
    subs.filter((x) => x.endpoint === 'https://web.push.apple.com/OLD-gone').length === 1, subs);
  panel = await p.textContent('.sheet');
  check('三個狀態都變綠（沒有紅點文字了）',
    !/缺少|被拒絕|可能被 iOS 撤銷/.test(panel), panel.slice(0, 260));
  await ctx.close();
  ({ ctx, p } = await open(stub('granted', true)));

  console.log('\n[F] 關閉：真的退訂，push.md 那一筆消失');
  await openPush(p);
  await p.click('[data-push="off"]');
  await p.waitForTimeout(1800);
  check('有呼叫 unsubscribe ← 只清檔不退訂的話推播服務還是會推過來',
    (await p.evaluate(() => window.__unsub)) === 1, await p.evaluate(() => window.__unsub));
  subs = await getPush();
  check('自己那筆不見了', !subs.filter((x) => x.endpoint === EP).length, subs);
  await ctx.close();

  console.log('\n[D] 先選 08:00 再打開，存的要是 08:00');
  await setPush([]);
  ({ ctx, p } = await open(stub('granted')));
  await openPush(p);
  await p.click('[data-ptime="08:00"]');
  await p.waitForTimeout(400);
  await p.click('[data-push="on"]');
  await p.waitForTimeout(1800);
  subs = await getPush();
  check('存成 08:00，不是預設的 07:30 ← 先選再開是很自然的順序',
    subs[0] && subs[0].time === '08:00', subs[0]);
  await ctx.close();

  console.log('\n[E] 按「不允許」：講清楚怎麼改，而且不留假訂閱');
  await setPush([]);
  ({ ctx, p } = await open(stub('denied')));
  await openPush(p);
  const denied = await p.textContent('.sheet');
  check('直接說明權限被拒過、瀏覽器不會再問', /不會再問|被拒絕/.test(denied), denied.slice(0, 120));
  check('指路到 iPhone 的設定', /設定\s*→\s*通知/.test(denied), denied.slice(0, 160));
  check('沒有給一顆按了沒用的按鈕', !(await p.$('[data-push="on"]')));
  check('push.md 沒有留下東西', (await getPush()).length === 0);
  await ctx.close();

  console.log('\n[B] iPhone Safari 分頁：先叫他加入主畫面');
  ({ ctx, p } = await open(stub('default'),
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'));
  await p.click('[data-nav="settings"]'); await p.waitForTimeout(500);
  check('索引就直接寫「要先加入主畫面」',
    /要先加入主畫面/.test(await p.textContent('[data-sec="push"]')),
    await p.textContent('[data-sec="push"]'));
  await openPush(p);
  const ios = await p.textContent('.sheet');
  check('說明怎麼加入主畫面', /分享鍵.*加入主畫面/s.test(ios), ios.slice(0, 200));
  check('不給按鈕（按了 iOS 也不會問，會以為是壞的）', !(await p.$('[data-push="on"]')));
  check('但有講清楚它做得到什麼（不用開著 app、電腦關機也會響）',
    /電腦關機也照樣會響/.test(ios), ios.slice(0, 260));
  await ctx.close();

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過：\n  - ' + fail.join('\n  - ') : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
