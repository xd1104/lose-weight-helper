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

  console.log('\n[2b] 顯示缺口佔 TDEE 的百分比與理論減重');
  // 頁面上有多個 .tdee-box（身體資料／每日目標／營養目標），掃全部再挑含「缺口」的那個
  const boxes = await p.$$eval('.tdee-box', e => e.map(x => x.textContent.replace(/\s+/g,' ')));
  const box = boxes.find(t => /缺口/.test(t)) || '';
  check('顯示缺口百分比 24%', /24%/.test(box||''), (box||'').replace(/\s+/g,' ').slice(0,80));
  check('顯示理論每週減重 0.45kg', /0\.45/.test(box||''), (box||'').replace(/\s+/g,' ').slice(0,80));

  console.log('\n[3] 把缺口縮小 → 紅色警告消失');
  await p.click('[data-set="goal"][data-val="-300"]'); await p.waitForTimeout(1000);
  const w2 = await p.$('.warn-box:not(.amber)');
  check('缺口 -300（上限 1764 > BMR 1720）時紅色警告消失', !w2);

  console.log('\n[3b] 活動量改輕度 + 缺口 -500 → 也該安全');
  await p.click('[data-set="goal"][data-val="-500"]'); await p.waitForTimeout(900);
  await p.click('[data-set="activity"][data-val="1.375"]'); await p.waitForTimeout(1000);
  check('輕度 -500（上限 1865 > BMR 1720）沒有紅色警告', !(await p.$('.warn-box:not(.amber)')));
  const boxes2 = await p.$$eval('.tdee-box', e => e.map(x => x.textContent.replace(/\s+/g,' ')));
  const box2 = boxes2.find(t => /缺口/.test(t)) || '';
  check('缺口百分比降到 21%', /21%/.test(box2||''), (box2||'').replace(/\s+/g,' ').slice(0,60));
  await p.click('[data-set="activity"][data-val="1.2"]'); await p.waitForTimeout(900);

  console.log('\n[4] 維持體重時標籤回到「每日目標」');
  await p.click('[data-set="goal"][data-val="0"]'); await p.waitForTimeout(1000);
  await p.click('[data-nav="today"]'); await p.waitForTimeout(700);
  const labels2 = await p.$$eval('.kv span', e=>e.map(x=>x.textContent.trim()));
  check('顯示「每日目標」', labels2.includes('每日目標'), labels2);

  console.log('\npageerrors:', errs.length?errs:'none');
  console.log(fail.length?'\n❌ '+fail.length+' 項未過':'\n✅ 全部通過');
  await b.close(); process.exit(fail.length?1:0);
})();
