const { chromium } = require('playwright');
const { seedUser } = require('./_setup');
const fail=[]; const check=(n,c,g)=>{ if(c) console.log('  ok  '+n); else {console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):'')); fail.push(n);} };
(async () => {
  // 用 Benson 實際的設定：27歲 168cm 80kg 久坐 -500 -> BMR 1720 / TDEE 2064 / 目標 1564
  await seedUser({ age:27, height:168, weight:80, activity:1.2, goal:-500 });
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport:{width:390,height:844}, deviceScaleFactor:2 });
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://localhost:3619/',{waitUntil:'networkidle'});
  await p.waitForTimeout(900);
  const t = await p.$('.picker-tile[data-pick]'); if(t){ await t.click(); await p.waitForTimeout(1600); }

  console.log('\n[1] 首頁：減脂時標籤要叫「上限」');
  const labels = await p.$$eval('.kv span', e=>e.map(x=>x.textContent.trim()));
  check('顯示「每日上限」而非「每日目標」', labels.includes('每日上限'), labels);

  console.log('\n[2] 設定頁：目標低於 BMR 要跳警告');
  await p.click('[data-nav="settings"]'); await p.waitForTimeout(700);
  const warn = await p.textContent('.warn-box').catch(()=> '');
  check('出現警告', /低於基礎代謝/.test(warn||''), (warn||'').slice(0,40));
  check('警告帶出正確數字 1,564 / 1,720', /1,564/.test(warn||'') && /1,720/.test(warn||''), (warn||'').slice(0,60));
  check('給了具體建議', /缺口|活動量/.test(warn||''));
  await p.screenshot({ path:'/tmp/floor-warn.png', fullPage:true });

  console.log('\n[3] 把缺口縮小 → 警告要消失');
  await p.click('[data-set="goal"][data-val="-300"]'); await p.waitForTimeout(1000);
  check('缺口 -300（目標 1764 > BMR 1720）時警告消失', !(await p.$('.warn-box')));

  console.log('\n[4] 維持體重時標籤回到「每日目標」');
  await p.click('[data-set="goal"][data-val="0"]'); await p.waitForTimeout(1000);
  await p.click('[data-nav="today"]'); await p.waitForTimeout(700);
  const labels2 = await p.$$eval('.kv span', e=>e.map(x=>x.textContent.trim()));
  check('顯示「每日目標」', labels2.includes('每日目標'), labels2);

  console.log('\npageerrors:', errs.length?errs:'none');
  console.log(fail.length?'\n❌ '+fail.length+' 項未過':'\n✅ 全部通過');
  await b.close(); process.exit(fail.length?1:0);
})();
