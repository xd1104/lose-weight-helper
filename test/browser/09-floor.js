const { chromium } = require('playwright');
const { BASE, seedUser, openSet, closeSet } = require('./_setup');
const dayKey = () => { const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
/* 直接用 API 灌今天的紀錄，比一筆一筆從 UI 敲快很多 */
const seedToday = (u, eaten, burn) => fetch(BASE+'/api/days', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ u, date: dayKey(),
    entries: eaten ? [{ id:'e1', name:'測試餐', kcal:eaten, meal:'lunch' }] : [],
    moves:  burn  ? [{ id:'m1', name:'測試運動', kcal:burn }] : [] }) });
const fail=[]; const check=(n,c,g)=>{ if(c) console.log('  ok  '+n); else {console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):'')); fail.push(n);} };
(async () => {
  // 用 Benson 實際的設定：27歲 168cm 80kg 久坐 -500 -> BMR 1720 / TDEE 2064 / 目標 1564
  const uid = await seedUser({ age:27, height:168, weight:80, activity:1.2, goal:-500 });
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport:{width:390,height:844}, deviceScaleFactor:2 });
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://localhost:3619/',{waitUntil:'networkidle'});
  await p.waitForTimeout(900);
  const t = await p.$('.picker-tile[data-pick]'); if(t){ await t.click(); await p.waitForTimeout(1600); }

  console.log('\n[1] 首頁：減脂時標籤要叫「上限」');
  /* v6.4：這個標籤跟著熱量從圓環搬到那一條上，而且不用展開就看得到了 */
  const foot = (await p.textContent('.eatfoot').catch(()=> '')||'').replace(/\s+/g,' ');
  check('顯示「每日上限」而非「每日目標」', /每日上限/.test(foot) && !/每日目標/.test(foot), foot);

  console.log('\n[2] 設定索引就會亮警告（不用點進去才看得到）');
  await p.click('[data-nav="settings"]'); await p.waitForTimeout(700);
  const alert = await p.textContent('.set-alert').catch(()=> '');
  check('索引上有紅色警示', /低於基礎代謝/.test(alert||''), (alert||'').slice(0,40));
  check('警示帶出正確數字 1,564 / 1,720', /1,564/.test(alert||'') && /1,720/.test(alert||''), (alert||'').slice(0,60));
  check('每日目標那列有紅點', !!(await p.$('.set-row .wdot:not(.amber)')));
  await p.screenshot({ path:'/tmp/floor-index.png', fullPage:true });

  console.log('\n[2a] 點進「每日目標」看完整說明');
  await openSet(p, 'goal');
  const warn = await p.textContent('.warn-box').catch(()=> '');
  check('出現警告', /低於基礎代謝/.test(warn||''), (warn||'').slice(0,40));
  check('警告帶出正確數字 1,564 / 1,720', /1,564/.test(warn||'') && /1,720/.test(warn||''), (warn||'').slice(0,60));
  check('給了具體建議', /缺口|活動量/.test(warn||''));
  await p.screenshot({ path:'/tmp/floor-warn.png', fullPage:true });

  console.log('\n[2b] 顯示缺口佔 TDEE 的百分比與理論減重');
  const boxes = await p.$$eval('.tdee-box', e => e.map(x => x.textContent.replace(/\s+/g,' ')));
  const box = boxes.find(t => /缺口/.test(t)) || '';
  check('顯示缺口百分比 24%', /24%/.test(box||''), (box||'').replace(/\s+/g,' ').slice(0,80));
  check('顯示理論每週減重 0.45kg', /0\.45/.test(box||''), (box||'').replace(/\s+/g,' ').slice(0,80));

  console.log('\n[3] 把缺口縮小 → 紅色警告消失');
  await p.click('[data-set="goal"][data-val="-300"]'); await p.waitForTimeout(1000);
  check('sheet 裡的紅色警告消失', !(await p.$('.warn-box:not(.amber)')));
  await p.click('[data-sheet="close"]'); await p.waitForTimeout(500);
  check('索引上的紅色警示也消失', !(await p.$('.set-alert:not(.amber)')));

  console.log('\n[3b] 活動量改輕度 + 缺口 -500 → 也該安全');
  await openSet(p, 'goal');
  await p.click('[data-set="goal"][data-val="-500"]'); await p.waitForTimeout(900);
  await openSet(p, 'activity');
  await p.click('[data-set="activity"][data-val="1.375"]'); await p.waitForTimeout(1000);
  await p.click('[data-sheet="close"]'); await p.waitForTimeout(500);
  check('輕度 -500（上限 1865 > BMR 1720）索引上沒有紅色警示', !(await p.$('.set-alert:not(.amber)')));
  await openSet(p, 'goal');
  const boxes2 = await p.$$eval('.tdee-box', e => e.map(x => x.textContent.replace(/\s+/g,' ')));
  const box2 = boxes2.find(t => /缺口/.test(t)) || '';
  check('缺口百分比降到 21%', /21%/.test(box2||''), (box2||'').replace(/\s+/g,' ').slice(0,60));
  await openSet(p, 'activity');
  await p.click('[data-set="activity"][data-val="1.2"]'); await p.waitForTimeout(900);

  console.log('\n[4] 維持體重時標籤回到「每日目標」');
  await openSet(p, 'goal');
  await p.click('[data-set="goal"][data-val="0"]'); await p.waitForTimeout(1000);
  await p.click('[data-sheet="close"]'); await p.waitForTimeout(400);
  await p.click('[data-nav="today"]'); await p.waitForTimeout(700);
  const foot2 = (await p.textContent('.eatfoot').catch(()=> '')||'').replace(/\s+/g,' ');
  check('顯示「每日目標」', /每日目標/.test(foot2), foot2);

  console.log('\n[5] 三段語意：超過減脂上限 ≠ 超過 TDEE');
  /* v6.4 起首頁的熱量從圓環換成一條（主角讓給體重趨勢），
     但綠／黃／紅三段的語意一模一樣，這裡測的是語意不是形狀。 */
  // 27歲 168cm 80kg 久坐 -300 -> BMR 1720 / TDEE 2064 / 每日上限 1764
  await openSet(p, 'goal');
  await p.click('[data-set="goal"][data-val="-300"]'); await p.waitForTimeout(900);
  await closeSet(p);

  const zone = async (eaten, burn) => {
    await seedToday(uid, eaten, burn);
    await p.reload({ waitUntil:'networkidle' }); await p.waitForTimeout(1400);
    return {
      tag: (await p.textContent('.over-tag').catch(()=> '')||'').replace(/\s+/g,' ').trim(),
      cls: (await p.getAttribute('.over-tag','class').catch(()=> '')||''),
      mid: (await p.textContent('.eattop .left').catch(()=> '')||'').replace(/\s+/g,' ').trim(),
      bar: (await p.getAttribute('.eatbar i','class').catch(()=> '')||''),
    };
  };

  const green = await zone(1200, 0);   // 1,200 / 1,764 = 68%，還不到「快到上限」的 85%
  check('綠：正常範圍不再多印一條提示（跟圓環中央重複）', green.cls === '', green);
  check('綠：進度條是綠的（沒有加深色的 class）', green.bar === '', green.bar);
  check('綠：條上寫「564 可以吃」', /564/.test(green.mid) && /可以吃/.test(green.mid), green.mid);

  // Benson 2026-07-25 真實的一天：吃 2,288、運動 240 -> 淨 2,048
  const amber = await zone(2288, 240);
  check('黃：超過上限但還在 TDEE 以內', /mid/.test(amber.cls), amber);
  check('黃：算出超過上限 284', /超過上限 284/.test(amber.tag), amber.tag);
  check('黃：算出距離 TDEE 還有 16', /距離 TDEE 還有 16/.test(amber.tag), amber.tag);
  check('黃：明講不會胖、只是缺口比計畫小', /不會胖/.test(amber.tag) && /缺口比計畫小/.test(amber.tag), amber.tag);
  check('黃：進度條是黃的，不是紅的', amber.bar === 'mid', amber.bar);
  check('黃：條上寫「284 超過」', /284/.test(amber.mid) && /超過/.test(amber.mid), amber.mid);
  await p.screenshot({ path:'/tmp/eatbar-amber.png', fullPage:false });

  const red = await zone(2500, 0);
  check('紅：淨 2,500 真的超過 TDEE 2,064', /over/.test(red.cls) && !/mid/.test(red.cls), red);
  check('紅：算出超過上限 736、超出 TDEE 436', /超過上限 736/.test(red.tag) && /超出 TDEE 436/.test(red.tag), red.tag);
  check('紅：進度條是紅的', red.bar === 'over', red.bar);

  console.log('\n[5b] 明細裡看得到 TDEE（「上限」是從哪來的）');
  check('收合時不顯示 TDEE（版面留給每天真的要看的東西）',
    !(await p.$$eval('.kv', e=>e.filter(x=>/TDEE/.test(x.textContent)).length)));
  await p.click('[data-act="toggle-detail"]'); await p.waitForTimeout(500);
  const kvs = await p.$$eval('.kv', e=>e.map(x=>x.textContent.replace(/\s+/g,' ').trim()));
  check('展開後列出維持體重（TDEE）2,064', kvs.some(t=>/維持體重（TDEE）/.test(t) && /2,064/.test(t)), kvs);
  check('明細裡只有熱量的算式，營養素不重複放', (await p.$$('.detail .macro')).length === 0);
  /* v6.4：三大營養素整組搬去「營養」頁（Benson 拍板），首頁只留一個入口。
     ⚠️ 入口一定要在——不然蛋白質差多少就完全看不到了。 */
  const link = await p.$('.detail [data-nav2="macros"]');
  check('明細裡有到「營養」頁的入口', !!link);
  check('入口就寫出蛋白質差多少（不用點進去才知道）',
    /蛋白\s*\d+／\d+\s*g/.test(await p.textContent('.detail [data-nav2="macros"]').catch(()=> '')),
    await p.textContent('.detail [data-nav2="macros"]').catch(()=> ''));
  await p.click('.detail [data-nav2="macros"]'); await p.waitForTimeout(700);
  check('點下去真的到營養頁', (await p.$$('.mcard .mrow')).length === 3, (await p.$$('.mcard .mrow')).length);
  await p.click('[data-nav="today"]'); await p.waitForTimeout(600);
  check('首頁收合的卡上不再放三大營養素', (await p.$$('.macro')).length === 0);

  console.log('\n[5c] 目標設成「維持」時沒有中間地帶（上限就是 TDEE）');
  await openSet(p, 'goal');
  await p.click('[data-set="goal"][data-val="0"]'); await p.waitForTimeout(900);
  await closeSet(p);
  await p.click('[data-nav="today"]'); await p.waitForTimeout(800);
  const keep = (await p.getAttribute('.over-tag','class').catch(()=> '')||'');
  check('維持模式下超過 TDEE 直接是紅色', /over/.test(keep) && !/mid/.test(keep), keep);
  check('維持模式不顯示重複的 TDEE 那列',
    !(await p.$$eval('.kv.tdee', e=>e.length)));

  console.log('\npageerrors:', errs.length?errs:'none');
  console.log(fail.length?'\n❌ '+fail.length+' 項未過':'\n✅ 全部通過');
  await b.close(); process.exit(fail.length?1:0);
})();
