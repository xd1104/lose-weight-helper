/* GitHubStore 寫入路徑測試
 * 用一個「有狀態」的假 Contents API：會記 sha、缺 sha 或 sha 過期就回 422/409，
 * 逼出 GitHubStore 從來沒被跑過的「重取 sha 再試一次」那條路。
 */
const { chromium } = require('playwright');
const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  // ---- 假 GitHub：path -> {content, sha} ----
  const files = new Map();
  let sha = 0;
  const log = [];
  let forceStaleOnce = null; // 指定 path：下一次 PUT 假裝 sha 過期回 409

  await p.route('https://api.github.com/repos/xd1104/lose-weight-helper/contents/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.split('/contents/')[1]);
    const method = req.method();
    const H = { 'access-control-allow-origin': '*' };

    if (method === 'GET') {
      // 資料夾列表
      const kids = [...files.keys()].filter((k) => k.startsWith(path + '/'));
      if (kids.length && !files.has(path)) {
        const seen = new Set();
        const items = [];
        for (const k of kids) {
          const rest = k.slice(path.length + 1);
          const seg = rest.split('/')[0];
          if (seen.has(seg)) continue;
          seen.add(seg);
          items.push(rest.includes('/')
            ? { name: seg, type: 'dir' }
            : { name: seg, type: 'file', sha: files.get(k).sha });
        }
        log.push('LIST ' + path);
        return route.fulfill({ status: 200, contentType: 'application/json', headers: H, body: JSON.stringify(items) });
      }
      if (!files.has(path)) {
        log.push('GET404 ' + path);
        return route.fulfill({ status: 404, contentType: 'application/json', headers: H, body: '{"message":"Not Found"}' });
      }
      const f = files.get(path);
      log.push('GET ' + path);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: H,
        body: JSON.stringify({ sha: f.sha, content: f.content }) });
    }

    if (method === 'PUT') {
      const body = JSON.parse(req.postData());
      const exists = files.has(path);
      if (exists && forceStaleOnce === path) {
        forceStaleOnce = null;
        log.push('PUT409 ' + path);
        return route.fulfill({ status: 409, contentType: 'application/json', headers: H, body: '{"message":"conflict"}' });
      }
      if (exists && !body.sha) {                       // 真 GitHub 的行為：覆蓋既有檔沒帶 sha -> 422
        log.push('PUT422 ' + path);
        return route.fulfill({ status: 422, contentType: 'application/json', headers: H, body: '{"message":"sha required"}' });
      }
      if (exists && body.sha !== files.get(path).sha) { // sha 過期 -> 409
        log.push('PUT409stale ' + path);
        return route.fulfill({ status: 409, contentType: 'application/json', headers: H, body: '{"message":"stale sha"}' });
      }
      const ns = 'sha' + (++sha);
      files.set(path, { content: body.content, sha: ns });
      log.push('PUT ' + path);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: H,
        body: JSON.stringify({ content: { sha: ns } }) });
    }

    if (method === 'DELETE') {
      const body = JSON.parse(req.postData());
      if (!files.has(path)) return route.fulfill({ status: 404, headers: H, contentType: 'application/json', body: '{}' });
      if (body.sha !== files.get(path).sha) {
        log.push('DEL409 ' + path);
        return route.fulfill({ status: 409, headers: H, contentType: 'application/json', body: '{"message":"stale"}' });
      }
      files.delete(path);
      log.push('DEL ' + path);
      return route.fulfill({ status: 200, headers: H, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 405, headers: H, body: '' });
  });

  await p.route('https://raw.githubusercontent.com/**', (r) =>
    r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'nf' }));

  await p.goto('http://localhost:3619/?store=github', { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    localStorage.setItem('lwh_gh_pat', 'github_pat_fake');
    localStorage.removeItem('lwh_user');
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);

  console.log('\n[1] 建立使用者 → 應該真的 PUT 出 data/users.md');
  await p.click('[data-act="new-user"]');
  await p.waitForTimeout(400);
  await p.fill('#u-name', 'Benson');
  await p.click('#f-user button[type="submit"]');
  await p.waitForTimeout(1800);
  check('users.md 被建立', files.has('data/users.md'));
  const roster = files.has('data/users.md') ? unb64(files.get('data/users.md').content) : '';
  check('名冊內容正確', /"name":"Benson"/.test(roster), roster.slice(0, 120));
  const uid = (roster.match(/"id":"([^"]+)"/) || [])[1];

  console.log('\n[2] 完成身體資料 → PUT profile.md（新檔，無 sha）');
  await p.fill('#s-weight', '78');
  await p.dispatchEvent('#s-weight', 'change');
  await p.waitForTimeout(300);
  await p.click('#f-setup button[type="submit"]');
  await p.waitForTimeout(1500);
  check('profile.md 被建立', files.has('data/users/' + uid + '/profile.md'), [...files.keys()]);

  console.log('\n[3] 再改一次設定 → 這次檔案已存在，必須帶 sha（不帶會 422）');
  const before = log.filter((l) => l.startsWith('PUT422')).length;
  await p.click('[data-nav="settings"]');
  await p.waitForTimeout(600);
  await p.click('[data-set="goal"][data-val="-300"]');
  await p.waitForTimeout(1500);
  check('沒有觸發 422（第一次寫入後有記住 sha）', log.filter((l) => l.startsWith('PUT422')).length === before,
    log.filter((l) => l.startsWith('PUT422')));
  const prof = unb64(files.get('data/users/' + uid + '/profile.md').content);
  check('目標 -300 有寫進去', /goal: -300/.test(prof), prof.split('\n').filter((l) => /goal/.test(l)));

  console.log('\n[4] sha 過期（別台裝置剛改過）→ 應自動重取 sha 再試一次，不能失敗');
  forceStaleOnce = 'data/users/' + uid + '/profile.md';
  const errBefore = errs.length;
  await p.click('[data-set="goal"][data-val="-500"]');
  await p.waitForTimeout(2200);
  const retried = log.some((l) => l.startsWith('PUT409'));
  check('確實遇到 409', retried, log.slice(-6));
  const prof2 = unb64(files.get('data/users/' + uid + '/profile.md').content);
  check('409 之後重試成功，資料有寫進去', /goal: -500/.test(prof2), prof2.split('\n').filter((l) => /goal/.test(l)));
  check('沒有跳錯誤 toast', errs.length === errBefore);

  console.log('\n[5] 記一筆 → PUT 當天的 day 檔');
  await p.click('[data-nav="today"]');
  await p.waitForTimeout(600);
  await p.click('.fab');
  await p.waitForTimeout(400);
  await p.click('[data-tab="manual"]');
  await p.waitForTimeout(300);
  await p.fill('#m-name', '滷肉飯');
  await p.fill('#m-kcal', '480');
  await p.click('#f-manual button[type="submit"]');
  await p.waitForTimeout(1800);
  const dayKey = [...files.keys()].find((k) => /\/days\/\d{4}-\d{2}-\d{2}\.md$/.test(k));
  check('day 檔被建立', !!dayKey, [...files.keys()]);
  check('內容含滷肉飯', dayKey && /滷肉飯/.test(unb64(files.get(dayKey).content)));
  check('foods.md（常吃）也被建立', files.has('data/users/' + uid + '/foods.md'));

  console.log('\n[6] 清空一整天 → 應該 DELETE 掉檔案，而不是留空殼');
  await p.click('.row[data-act="edit-entry"]');
  await p.waitForTimeout(500);
  p.once('dialog', (d) => d.accept());
  await p.click('[data-del]');
  await p.waitForTimeout(1800);
  check('day 檔被刪除', !files.has(dayKey), [...files.keys()]);

  console.log('\n[7] 刪除使用者 → 整個資料夾（含子資料夾）都要清掉');
  await p.click('[data-nav="settings"]');
  await p.waitForTimeout(600);
  await p.click('[data-act="new-user"]');            // 先建第二位，才允許刪第一位
  await p.waitForTimeout(400);
  await p.fill('#u-name', '小美');
  await p.click('#f-user button[type="submit"]');
  await p.waitForTimeout(1800);
  await p.click('[data-sheet="close"]').catch(() => {});
  await p.waitForTimeout(400);
  await p.click('[data-nav="settings"]');
  await p.waitForTimeout(600);
  await p.click('[data-edit-user="' + uid + '"]');
  await p.waitForTimeout(500);
  p.once('dialog', (d) => d.accept());
  await p.click('[data-del-user]');
  await p.waitForTimeout(3000);
  const left = [...files.keys()].filter((k) => k.startsWith('data/users/' + uid + '/'));
  check('該使用者的檔案全部刪光（含 days/ 子資料夾）', left.length === 0, left);
  check('名冊裡也移除了', !/"id":"' + uid + '"/.test(unb64(files.get('data/users.md').content)));

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log('剩下的檔案:', [...files.keys()]);
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過' : '\n✅ 全部通過');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
