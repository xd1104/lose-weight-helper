/* 模擬手機端第一次開啟（GitHub 模式、沒有金鑰、也還沒有任何使用者）
 * 用 ?store=github 強制走 GitHubStore，並攔截 GitHub API 回「檔案不存在」 */
const { chromium } = require('playwright');
const fail = [];
function check(n, c, g) {
  if (c) console.log('  ok  ' + n);
  else { console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); fail.push(n); }
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  // raw.githubusercontent：users.md 不存在
  await p.route('https://raw.githubusercontent.com/**', (r) =>
    r.fulfill({ status: 404, body: 'Not Found', headers: { 'access-control-allow-origin': '*' } }));
  await p.route('https://api.github.com/**', (r) =>
    r.fulfill({ status: 404, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: '{"message":"Not Found"}' }));

  await p.goto('http://localhost:3619/?store=github', { waitUntil: 'networkidle' });
  await p.evaluate(() => { localStorage.removeItem('lwh_gh_pat'); localStorage.removeItem('lwh_user'); });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: '/tmp/ro-1.png', fullPage: true });

  check('停在選人畫面', !!(await p.$('.picker')));
  check('唯讀時不顯示「新增使用者」（按了也沒用，不如不給）', !(await p.$('[data-act="new-user"]')));
  check('有唯讀說明卡', !!(await p.$('.picker-note')));
  const btn = await p.$('[data-act="open-keys"]');
  check('有「貼上金鑰」出口 ← 這就是原本卡死的地方', !!btn);

  await btn.click();
  await p.waitForTimeout(500);
  check('金鑰 sheet 打得開（此時 me 是 null）', !!(await p.$('#k-gh')));
  check('sheet 裡有 GitHub 金鑰欄', !!(await p.$('#k-gh')));
  check('sheet 裡有 Anthropic API key 欄', !!(await p.$('#k-ai')));
  await p.screenshot({ path: '/tmp/ro-2.png', fullPage: true });

  // 貼上金鑰 -> 應觸發 reload
  await p.fill('#k-gh', 'github_pat_testtoken');
  await p.fill('#k-ai', 'sk-ant-testkey');
  await p.click('[data-keys="save"]');
  await p.waitForTimeout(1600);
  const tok = await p.evaluate(() => localStorage.getItem('lwh_gh_pat'));
  const aik = await p.evaluate(() => localStorage.getItem('lwh_anthropic_key'));
  check('GitHub 金鑰已存', tok === 'github_pat_testtoken', tok);
  check('API key 已存', aik === 'sk-ant-testkey', aik);
  check('有金鑰後出現「新增使用者」', !!(await p.$('[data-act="new-user"]')));
  check('唯讀說明卡消失', !(await p.$('.picker-note')));
  await p.screenshot({ path: '/tmp/ro-3.png', fullPage: true });

  console.log('\npageerrors:', errs.length ? errs : 'none');
  console.log(fail.length ? '\n❌ ' + fail.length + ' 項未過' : '\n✅ 全部通過');
  await b.close();
  process.exit(fail.length ? 1 : 0);
})();
