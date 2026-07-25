"use strict";
/*
 * 減重助手 — 前端主程式
 * 資料層在 store.js（LocalStore / GitHubStore 自動切）、AI 在 ai.js。
 * 這支只管畫面與互動。
 *
 * 多使用者：Benson 與女友各自獨立（紀錄／TDEE／目標／常吃清單都不共用），
 * 進 app 先選人（Netflix 式），選過之後這台裝置會記住，點右上頭像可切換。
 */

/* ============ 小工具 ============ */
function esc(s){
  return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
var WD=["日","一","二","三","四","五","六"];
function fmtMD(key){ var d=parseDateKey(key); return (d.getMonth()+1)+"/"+d.getDate(); }
function fmtLong(key){
  var d=parseDateKey(key);
  return (d.getMonth()+1)+" 月 "+d.getDate()+" 日（"+WD[d.getDay()]+"）";
}
function kcal(n){ return Math.round(num(n)).toLocaleString("zh-TW"); }

var $app=document.getElementById("app");
var $sheetLayer=document.getElementById("sheet-layer");

/* ============ toast ============ */
var toastEl=document.getElementById("toast");
var toastTimer=null;
function toast(msg, isErr){
  toastEl.textContent=msg;
  toastEl.className=isErr?"err":"";
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){ toastEl.className+=" hidden"; }, 3000);
}

/* ============ 狀態 ============ */
var users=[];                   /* 使用者名冊 */
var me=null;                    /* 目前是誰在用 */
var db={ profile:defaultProfile(), foods:[], days:{} };
var view="today";               /* today | history | settings（picker 是獨立全螢幕） */
var picking=false;              /* 是否停在「誰在用？」畫面 */
var curDate=dateKey();
var histDates=[];
var histLoaded=false;
var booted=false;

function dayOf(key){ return db.days[key] || (db.days[key]=emptyDay(key)); }

/* ============ 持久化（樂觀更新：畫面先動，背景寫入，失敗才 toast） ============ */
var persistChains={}; /* 同一份檔案的寫入排隊，避免快速連點時並發互蓋 */
function chainPersist(key, job){
  var run=function(){
    return job().catch(function(e){
      toast("儲存失敗："+(e.userMessage||e.message||""), true);
    });
  };
  persistChains[key]=(persistChains[key]||Promise.resolve()).then(run);
  return persistChains[key];
}
/* chain key 一律帶 uid：切換使用者後不會跟前一個人的寫入排在同一條鏈上 */
function persistDay(key){
  var d=db.days[key];
  if(!d || !me) return Promise.resolve();
  var u=me.id;
  return chainPersist(u+":day:"+key, function(){ return STORE.saveDay(u, d); });
}
function persistProfile(){
  if(!me) return Promise.resolve();
  var u=me.id, p=db.profile;
  return chainPersist(u+":profile", function(){ return STORE.saveProfile(u, p); });
}
function persistFoods(){
  if(!me) return Promise.resolve();
  var u=me.id, l=db.foods;
  return chainPersist(u+":foods", function(){ return STORE.saveFoods(u, l); });
}
function persistUsers(){
  return chainPersist("users", function(){ return STORE.saveUsers(users); });
}

/* 唯讀守門（Pages 沒貼 GitHub 金鑰時） */
function requireWrite(){
  if(STORE.canWrite()) return true;
  toast("唯讀模式：到「設定」貼上 GitHub 金鑰才能記錄", true);
  return false;
}

/* ============ 常吃食物 ============ */
/* AI 算過一次就記起來，下次同一樣東西直接從「常吃」點，不用再花錢問 AI。
 * 兩個人的清單是分開的（各自獨立是拍板的決定）。 */
function rememberFood(item){
  var key=String(item.name||"").trim();
  if(!key) return;
  var hit=null;
  for(var i=0;i<db.foods.length;i++){
    if(db.foods[i].name===key){ hit=db.foods[i]; break; }
  }
  if(hit){
    hit.n=(num(hit.n)||1)+1;
    hit.kcal=round(item.kcal); hit.p=round(item.p); hit.c=round(item.c); hit.f=round(item.f);
    if(item.portion) hit.portion=item.portion;
  }else{
    db.foods.push({ id:uid(), name:key, kcal:round(item.kcal), p:round(item.p), c:round(item.c),
                    f:round(item.f), portion:item.portion||"", n:1 });
  }
  db.foods.sort(function(a,b){ return (num(b.n)-num(a.n)) || a.name.localeCompare(b.name,"zh-Hant"); });
  if(db.foods.length>200) db.foods.length=200; /* 清單無限長對手機沒好處 */
  persistFoods();
}

/* ============ 畫面 ============ */
function render(){
  if(picking){ $app.innerHTML=viewPicker(); wire(); window.scrollTo(0,0); return; }
  if(view==="today") $app.innerHTML=viewToday();
  else if(view==="history") $app.innerHTML=viewHistory();
  else $app.innerHTML=viewSettings();
  $app.innerHTML+=navHtml();
  if(view==="today") $app.innerHTML+='<button class="fab" data-act="add" aria-label="記一筆">＋</button>';
  wire();
}

function navHtml(){
  var t=function(id,ico,label){
    return '<button data-nav="'+id+'" class="'+(view===id?"on":"")+'"><i>'+ico+'</i>'+label+'</button>';
  };
  return '<nav class="nav">'+t("today","🍽","今天")+t("history","📈","歷史")+t("settings","⚙","設定")+'</nav>';
}

/* ---------- 誰在用？（Netflix 式） ---------- */
function avatarHtml(u, cls){
  return '<span class="avatar '+(cls||"")+'" style="background:'+esc(u.color)+'">'+esc(u.emoji)+'</span>';
}
function viewPicker(){
  var first=!users.length;
  var h='<div class="picker">';
  h+='<div class="picker-head">'+
      '<h1>'+(first?"歡迎使用減重助手":"誰在用？")+'</h1>'+
      '<p>'+(first?"先建立第一位使用者。兩個人的紀錄、目標與常吃清單完全獨立。"
                 :"每個人的紀錄與目標都是分開的。")+'</p>'+
     '</div>';
  h+='<div class="picker-grid">';
  users.forEach(function(u){
    h+='<button class="picker-tile" data-pick="'+esc(u.id)+'">'+
        '<span class="picker-face" style="background:'+esc(u.color)+'">'+esc(u.emoji)+'</span>'+
        '<b>'+esc(u.name)+'</b>'+
       '</button>';
  });
  h+='<button class="picker-tile add" data-act="new-user">'+
      '<span class="picker-face add">＋</span><b>新增使用者</b></button>';
  h+='</div>';
  if(!first){
    h+='<button class="picker-manage" data-act="manage-users">管理使用者</button>';
  }
  h+='</div>';
  return h;
}

/* ---------- 熱量環 ---------- */
function ringHtml(eaten, target){
  var pct = target>0 ? eaten/target : 0;
  var shown = Math.max(0, Math.min(1, pct));
  var R=58, C=2*Math.PI*R;
  var over = eaten>target;
  var color = over ? "var(--bad)" : (pct>=0.85 ? "var(--warn)" : "var(--acc)");
  var left = target-eaten;
  return ''+
  '<div class="ring">'+
    '<svg width="132" height="132" viewBox="0 0 132 132">'+
      '<circle cx="66" cy="66" r="'+R+'" fill="none" stroke="#eef1ea" stroke-width="12"/>'+
      '<circle cx="66" cy="66" r="'+R+'" fill="none" stroke="'+color+'" stroke-width="12" stroke-linecap="round"'+
        ' stroke-dasharray="'+(C*shown).toFixed(1)+' '+C.toFixed(1)+'"/>'+
    '</svg>'+
    '<div class="mid">'+
      '<b class="num" style="color:'+(over?"var(--bad)":"var(--ink)")+'">'+kcal(Math.abs(left))+'</b>'+
      '<span>'+(over?"超過 大卡":"還可以吃")+'</span>'+
    '</div>'+
  '</div>';
}

function headHtml(title){
  return '<header class="head"><h1>'+esc(title)+'</h1>'+
    (STORE.canWrite()?"":'<span class="sub">唯讀</span>')+
    '<button class="me-btn" data-act="switch-user" aria-label="切換使用者：'+esc(me.name)+'">'+
      avatarHtml(me)+'</button>'+
   '</header>';
}

function viewToday(){
  var d=dayOf(curDate);
  var eaten=sumKcal(d.entries), burn=sumKcal(d.moves);
  var target=targetOf(db.profile);
  var net=eaten-burn;
  var m=macrosOf(d);
  var isToday=curDate===dateKey();

  var tag;
  if(net>target) tag='<div class="over-tag over">今天超過目標 '+kcal(net-target)+' 大卡</div>';
  else if(target>0 && net/target>=0.85) tag='<div class="over-tag near">快到目標了，剩 '+kcal(target-net)+' 大卡</div>';
  else tag='<div class="over-tag ok">還在目標內，剩 '+kcal(target-net)+' 大卡</div>';

  var h=headHtml(me.name);

  h+='<div class="daynav">'+
      '<button data-act="prev-day" aria-label="前一天">‹</button>'+
      '<div class="date">'+esc(fmtLong(curDate))+
        '<small>'+(isToday?"今天":(curDate>dateKey()?"未來":""))+'</small></div>'+
      '<button data-act="next-day" aria-label="後一天" '+(curDate>=dateKey()?"disabled":"")+'>›</button>'+
      (isToday?"":'<button class="today-btn" data-act="go-today">今天</button>')+
     '</div>';

  h+='<section class="ring-card">'+
      '<div class="ring-wrap">'+ringHtml(net, target)+
        '<div class="ring-side">'+
          '<div class="kv eat"><span>已攝取</span><b class="num">'+kcal(eaten)+'</b></div>'+
          (burn?'<div class="kv burn"><span>運動消耗</span><b class="num">−'+kcal(burn)+'</b></div>':'')+
          '<div class="kv goal"><span>每日目標</span><b class="num">'+kcal(target)+'</b></div>'+
        '</div>'+
      '</div>'+
      tag+
      '<div class="macros">'+
        macroBox("蛋白","var(--p)",m.p)+macroBox("碳水","var(--c)",m.c)+macroBox("脂肪","var(--f)",m.f)+
      '</div>'+
     '</section>';

  /* 四個餐段 */
  MEALS.forEach(function(mk){
    var list=(d.entries||[]).filter(function(e){ return e.meal===mk; });
    var info=MEAL_INFO[mk];
    h+='<section class="sec">'+
        '<div class="sec-head"><h2>'+info.emoji+' '+info.label+'</h2>'+
          (list.length?'<span class="n">'+kcal(sumKcal(list))+' 大卡</span>':'')+'</div>'+
        '<div class="list">';
    if(!list.length){
      h+='<button class="row" data-act="add" data-meal="'+mk+'"><div class="row-mid">'+
         '<b style="color:var(--muted);font-weight:600">＋ 記一筆'+info.label+'</b></div></button>';
    }else{
      list.forEach(function(e){
        h+='<button class="row" data-act="edit-entry" data-id="'+esc(e.id)+'">'+
            '<div class="row-mid"><b>'+esc(e.name)+'</b>'+
              (e.portion||e.time ? '<span>'+esc([e.time,e.portion].filter(Boolean).join(" · "))+'</span>' : '')+
            '</div>'+
            '<div class="row-kcal num">'+kcal(e.kcal)+'<i>大卡</i></div>'+
           '</button>';
      });
    }
    h+='</div></section>';
  });

  /* 運動 */
  h+='<section class="sec">'+
      '<div class="sec-head"><h2>🏃 運動</h2>'+
        (d.moves.length?'<span class="n">−'+kcal(burn)+' 大卡</span>':'')+'</div>'+
      '<div class="list">';
  if(!d.moves.length){
    h+='<button class="row" data-act="add-move"><div class="row-mid">'+
       '<b style="color:var(--muted);font-weight:600">＋ 記一筆額外運動</b></div></button>';
  }else{
    d.moves.forEach(function(mv){
      h+='<button class="row" data-act="edit-move" data-id="'+esc(mv.id)+'">'+
          '<div class="row-mid"><b>'+esc(mv.name)+'</b>'+(mv.time?'<span>'+esc(mv.time)+'</span>':'')+'</div>'+
          '<div class="row-kcal burn num">−'+kcal(mv.kcal)+'<i>大卡</i></div>'+
         '</button>';
    });
    h+='<button class="row" data-act="add-move"><div class="row-mid">'+
       '<b style="color:var(--muted);font-weight:600">＋ 再記一筆</b></div></button>';
  }
  h+='</div></section>';

  /* 最近 7 天 */
  h+='<section class="sec"><div class="sec-head"><h2>最近 7 天</h2></div>'+sparkHtml(target)+'</section>';

  /* 備註 */
  h+='<section class="sec">'+
      '<div class="sec-head"><h2>📝 備註</h2></div>'+
      '<div class="list"><button class="row" data-act="edit-notes"><div class="row-mid">'+
        (d.notes ? '<b style="font-weight:600;white-space:pre-wrap">'+esc(d.notes)+'</b>'
                 : '<b style="color:var(--muted);font-weight:600">今天的身體感覺、外食場合…</b>')+
      '</div></button></div></section>';

  return h;
}
function macroBox(label,color,v){
  return '<div class="macro"><div class="lb"><span class="dot" style="background:'+color+'"></span>'+label+'</div>'+
         '<b class="num">'+kcal(v)+'<i>g</i></b></div>';
}

function sparkHtml(target){
  var keys=[], i;
  for(i=6;i>=0;i--) keys.push(shiftDate(curDate,-i));
  var vals=keys.map(function(k){ var d=db.days[k]; return d?netOf(d):0; });
  var max=Math.max(target, Math.max.apply(null, vals), 1);
  var h='<div class="spark">';
  keys.forEach(function(k,idx){
    var v=vals[idx];
    var pct=Math.max(0, Math.min(1, v/max));
    var cls=v<=0 ? "none" : (v>target ? "over" : "");
    h+='<div class="col'+(k===curDate?" today":"")+'">'+
        '<div class="bar '+cls+'" style="height:'+(v<=0?3:Math.max(6, pct*72))+'px" title="'+kcal(v)+' 大卡"></div>'+
        '<div class="lb">'+WD[parseDateKey(k).getDay()]+'</div>'+
       '</div>';
  });
  return h+'</div>';
}

/* ---------- 歷史 ---------- */
function viewHistory(){
  var target=targetOf(db.profile);
  var keys=histDates.slice().sort().reverse().slice(0,60);
  var h=headHtml("歷史");

  var loaded=keys.filter(function(k){ return db.days[k]; });
  var vals=loaded.map(function(k){ return netOf(db.days[k]); }).filter(function(v){ return v>0; });
  var avg7=avgOf(vals.slice(0,7)), avg30=avgOf(vals.slice(0,30));
  h+='<div class="hist-sum">'+
      '<div><span>7 日平均</span><b class="num">'+(avg7?kcal(avg7):"—")+'</b></div>'+
      '<div><span>30 日平均</span><b class="num">'+(avg30?kcal(avg30):"—")+'</b></div>'+
      '<div><span>每日目標</span><b class="num">'+kcal(target)+'</b></div>'+
     '</div>';

  if(!histLoaded){
    h+='<div class="card"><div class="spin"><div class="dots"><i></i><i></i><i></i></div>讀取紀錄中…</div></div>';
    return h;
  }
  if(!keys.length){
    h+='<div class="card"><p class="desc" style="margin:0">還沒有任何紀錄。回「今天」記第一筆吧。</p></div>';
    return h;
  }

  h+='<div class="sec"><div class="list">';
  keys.forEach(function(k){
    var d=db.days[k];
    var v=d?netOf(d):null;
    var pct=v!=null&&target>0 ? Math.max(0,Math.min(1,v/target)) : 0;
    var over=v!=null&&v>target;
    h+='<button class="hrow" data-act="open-day" data-date="'+esc(k)+'">'+
        '<div class="d">'+esc(fmtMD(k))+'<small>週'+WD[parseDateKey(k).getDay()]+'</small></div>'+
        '<div class="hbar"><i class="'+(over?"over":"")+'" style="width:'+(pct*100).toFixed(0)+'%"></i></div>'+
        '<div class="v num '+(v==null?"none":(over?"over":""))+'">'+(v==null?"…":kcal(v))+'</div>'+
       '</button>';
  });
  h+='</div></div>';
  return h;
}
function avgOf(list){
  if(!list.length) return 0;
  var s=0; list.forEach(function(v){ s+=v; });
  return Math.round(s/list.length);
}

/* ---------- 設定 ---------- */
var ACTIVITIES=[
  {v:1.2,   label:"久坐",   hint:"幾乎沒運動"},
  {v:1.375, label:"輕度",   hint:"每週 1–3 次"},
  {v:1.55,  label:"中度",   hint:"每週 3–5 次"},
  {v:1.725, label:"高度",   hint:"每週 6–7 次"},
  {v:1.9,   label:"極高",   hint:"體力工作／雙練"}
];
var GOALS=[
  {v:-500, label:"減脂 快", hint:"約每週 −0.45kg"},
  {v:-300, label:"減脂 緩", hint:"約每週 −0.27kg"},
  {v:0,    label:"維持",    hint:"吃到 TDEE"},
  {v:300,  label:"增肌",    hint:"小幅盈餘"}
];

function viewSettings(){
  var p=db.profile;
  var bmr=bmrOf(p), tdee=tdeeOf(p), target=targetOf(p);
  var h=headHtml("設定");

  /* 使用者 */
  h+='<div class="card">'+
      '<h2>使用者</h2>'+
      '<p class="desc">每個人的紀錄、TDEE、目標與常吃清單完全獨立，互不干擾。</p>'+
      '<div class="user-list">'+
        users.map(function(u){
          return '<button class="user-row" data-edit-user="'+esc(u.id)+'">'+
            avatarHtml(u,"sm")+
            '<b>'+esc(u.name)+(u.id===me.id?'<span class="tag-me">目前</span>':'')+'</b>'+
            '<span class="chev">›</span></button>';
        }).join("")+
      '</div>'+
      '<button class="btn ghost" data-act="new-user">＋ 新增使用者</button>'+
      '<button class="btn ghost" data-act="switch-user">切換使用者</button>'+
     '</div>';

  /* 個人資料 → TDEE */
  h+='<div class="card">'+
      '<h2>'+esc(me.name)+' 的身體資料</h2>'+
      '<p class="desc">用 Mifflin-St Jeor 公式算基礎代謝，再乘活動係數得到 TDEE。</p>'+
      '<div class="field"><label>性別</label><div class="chips">'+
        '<button class="chip '+(p.sex==="male"?"on":"")+'" data-set="sex" data-val="male">男</button>'+
        '<button class="chip '+(p.sex==="female"?"on":"")+'" data-set="sex" data-val="female">女</button>'+
      '</div></div>'+
      '<div class="grid2">'+
        '<div class="field"><label>年齡</label><input type="number" inputmode="numeric" data-num="age" value="'+p.age+'"></div>'+
        '<div class="field"><label>身高 (cm)</label><input type="number" inputmode="decimal" data-num="height" value="'+p.height+'"></div>'+
      '</div>'+
      '<div class="field"><label>體重 (kg)</label><input type="number" inputmode="decimal" data-num="weight" value="'+p.weight+'"></div>'+
      '<div class="field"><label>活動量</label><div class="chips">'+
        ACTIVITIES.map(function(a){
          return '<button class="chip '+(Math.abs(p.activity-a.v)<0.01?"on":"")+'" data-set="activity" data-val="'+a.v+'">'+
                 a.label+'</button>';
        }).join("")+
      '</div><div class="hint">'+esc((ACTIVITIES.filter(function(a){return Math.abs(p.activity-a.v)<0.01;})[0]||{}).hint||"")+'</div></div>'+
      '<div class="tdee-box">'+
        '<div class="r"><span>基礎代謝 BMR</span><b class="num">'+kcal(bmr)+'</b></div>'+
        '<div class="r"><span>每日總消耗 TDEE</span><b class="num">'+kcal(tdee)+'</b></div>'+
      '</div>'+
      '<div class="field"><label>手動覆寫 TDEE（0 = 用上面算的）</label>'+
        '<input type="number" inputmode="numeric" data-num="tdee" value="'+p.tdee+'">'+
        '<div class="hint">有做過體檢代謝測量的話填進來，會蓋掉公式估算值。</div></div>'+
     '</div>';

  /* 目標 */
  h+='<div class="card">'+
      '<h2>每日目標</h2>'+
      '<p class="desc">在 TDEE 上加減，決定「今天還可以吃多少」。</p>'+
      '<div class="chips">'+
        GOALS.map(function(g){
          return '<button class="chip '+(p.goal===g.v?"on":"")+'" data-set="goal" data-val="'+g.v+'">'+g.label+'</button>';
        }).join("")+
      '</div>'+
      '<div class="field"><label>自訂調整 (大卡)</label>'+
        '<input type="number" inputmode="numeric" data-num="goal" value="'+p.goal+'">'+
        '<div class="hint">負數 = 減脂缺口，正數 = 增肌盈餘。</div></div>'+
      '<div class="tdee-box"><div class="r"><span>每日目標攝取</span><b class="num">'+kcal(target)+'</b></div></div>'+
     '</div>';

  /* AI */
  var key=getAiKey();
  h+='<div class="card">'+
      '<h2>AI 熱量判讀</h2>'+
      '<p class="desc">用你自己的 Anthropic API key，從這台裝置直接呼叫 Claude。'+
        'key 只存在這支手機的瀏覽器裡，不會上傳、也不會進 GitHub。'+
        '<br><b>同一台裝置上兩個人共用同一把 key</b>（key 綁裝置，不綁使用者）。</p>'+
      '<div class="field"><label>API key</label>'+
        '<input type="password" id="ai-key" placeholder="sk-ant-..." value="'+esc(key)+'" autocomplete="off">'+
        '<div class="hint">到 console.anthropic.com → API keys 申請，並記得在 Billing 設每月上限。</div></div>'+
      '<div class="field"><label>模型</label><div class="chips">'+
        AI_MODELS.map(function(m){
          return '<button class="chip '+(p.model===m.id?"on":"")+'" data-set="model" data-val="'+esc(m.id)+'">'+
                 esc(m.label)+'</button>';
        }).join("")+
      '</div><div class="hint">'+esc(aiModelInfo(p.model).hint)+'</div></div>'+
      '<div class="tdee-box"><div class="r"><span>AI 用量（這台裝置）</span><b style="font-size:14px">'+esc(usageText())+'</b></div></div>'+
      '<button class="btn" data-act="save-key">儲存 API key</button>'+
      (key?'<button class="btn ghost" data-act="clear-key">移除這台裝置的 key</button>':'')+
     '</div>';

  /* GitHub 金鑰：只有非 localhost 才需要（本機版直接寫檔） */
  if(!STORE.local){
    var tok=getToken();
    h+='<div class="card">'+
        '<h2>GitHub 同步金鑰</h2>'+
        '<p class="desc">手機版直接讀寫 GitHub 上的資料檔。沒有金鑰只能看，不能記錄。'+
          '請用 fine-grained PAT，只授權 lose-weight-helper 這一個 repo，Contents 設為 Read and write。</p>'+
        '<div class="field"><label>Personal access token</label>'+
          '<input type="password" id="gh-key" placeholder="github_pat_..." value="'+esc(tok)+'" autocomplete="off"></div>'+
        '<button class="btn" data-act="save-gh">儲存金鑰</button>'+
        (tok?'<button class="btn ghost" data-act="clear-gh">移除金鑰</button>':'')+
       '</div>';
  }

  h+='<div class="card"><h2>資料</h2>'+
      '<p class="desc">紀錄存成 markdown：<br>'+
        '<code style="font-size:12px">data/users/'+esc(me.id)+'/days/YYYY-MM-DD.md</code><br>'+
        esc(me.name)+' 的常吃清單目前 '+db.foods.length+' 筆。</p>'+
      (db.foods.length?'<button class="btn ghost" data-act="clear-foods">清空常吃清單</button>':'')+
     '</div>';

  h+='<p style="text-align:center;color:#b0b8ac;font-size:12px;padding:6px 16px 30px">減重助手 v2.0</p>';
  return h;
}

/* ============ 事件綁定 ============ */
function wire(){
  $app.querySelectorAll("[data-nav]").forEach(function(b){
    b.onclick=function(){
      view=b.getAttribute("data-nav");
      if(view==="history") ensureHistory();
      render();
      window.scrollTo(0,0);
    };
  });

  $app.querySelectorAll("[data-pick]").forEach(function(b){
    b.onclick=function(){ switchUser(b.getAttribute("data-pick")); };
  });
  $app.querySelectorAll("[data-edit-user]").forEach(function(b){
    b.onclick=function(){ openUserSheet(b.getAttribute("data-edit-user")); };
  });

  $app.querySelectorAll("[data-act]").forEach(function(b){
    b.onclick=function(){ doAct(b.getAttribute("data-act"), b); };
  });

  /* 設定頁的 chip（性別/活動/目標/模型） */
  $app.querySelectorAll("[data-set]").forEach(function(b){
    b.onclick=function(){
      var k=b.getAttribute("data-set"), v=b.getAttribute("data-val");
      db.profile[k]=(k==="sex"||k==="model") ? v : Number(v);
      db.profile=cleanProfile(db.profile);
      persistProfile();
      render();
    };
  });

  /* 設定頁的數字欄位：change 才寫（避免每敲一個字就打一次 API） */
  $app.querySelectorAll("[data-num]").forEach(function(inp){
    inp.onchange=function(){
      db.profile[inp.getAttribute("data-num")]=Number(inp.value)||0;
      db.profile=cleanProfile(db.profile);
      persistProfile();
      render();
    };
  });
}

function doAct(act, el){
  if(act==="switch-user"){ picking=true; render(); return; }
  if(act==="manage-users"){
    /* 從選人畫面進管理：先進去目前這位（或第一位）的設定頁 */
    if(!me && users.length) return switchUser(users[0].id, function(){ view="settings"; picking=false; render(); });
    picking=false; view="settings"; render(); return;
  }
  if(act==="new-user"){ openUserSheet(null); return; }
  if(act==="prev-day"){ curDate=shiftDate(curDate,-1); ensureDays([curDate]); render(); return; }
  if(act==="next-day"){ if(curDate<dateKey()){ curDate=shiftDate(curDate,1); ensureDays([curDate]); render(); } return; }
  if(act==="go-today"){ curDate=dateKey(); ensureDays([curDate]); render(); return; }
  if(act==="open-day"){ curDate=el.getAttribute("data-date"); view="today"; ensureDays([curDate]); render(); window.scrollTo(0,0); return; }
  if(act==="add"){ if(requireWrite()) openAddSheet(el.getAttribute("data-meal")); return; }
  if(act==="add-move"){ if(requireWrite()) openMoveSheet(null); return; }
  if(act==="edit-entry"){ if(requireWrite()) openEntrySheet(el.getAttribute("data-id")); return; }
  if(act==="edit-move"){ if(requireWrite()) openMoveSheet(el.getAttribute("data-id")); return; }
  if(act==="edit-notes"){ if(requireWrite()) openNotesSheet(); return; }
  if(act==="save-key"){
    var v=(document.getElementById("ai-key")||{}).value||"";
    v=v.trim();
    if(!v){ toast("請先貼上 API key", true); return; }
    setAiKey(v); toast("API key 已存在這台裝置"); render(); return;
  }
  if(act==="clear-key"){ clearAiKey(); toast("已移除"); render(); return; }
  if(act==="save-gh"){
    var g=(document.getElementById("gh-key")||{}).value||"";
    g=g.trim();
    if(!g){ toast("請先貼上金鑰", true); return; }
    setToken(g); toast("金鑰已儲存，重新載入…");
    setTimeout(function(){ location.reload(); }, 700); return;
  }
  if(act==="clear-gh"){
    clearToken(); toast("已移除金鑰");
    setTimeout(function(){ location.reload(); }, 700); return;
  }
  if(act==="clear-foods"){
    if(!confirm("清空 "+me.name+" 的常吃清單？（不影響已記錄的飲食）")) return;
    db.foods=[]; persistFoods(); render(); return;
  }
}

/* ============ 使用者管理 ============ */
function openUserSheet(id){
  var u=id ? users.filter(function(x){ return x.id===id; })[0] : null;
  if(id && !u) return;
  if(!u && !STORE.canWrite()){ toast("唯讀模式：無法新增使用者", true); return; }
  var draft = u ? { id:u.id, name:u.name, emoji:u.emoji, color:u.color, createdAt:u.createdAt }
                : { id:"", name:"", emoji:USER_EMOJIS[users.length%USER_EMOJIS.length],
                    color:USER_COLORS[users.length%USER_COLORS.length], createdAt:"" };

  function body(){
    return '<form id="f-user">'+
      '<div class="user-preview"><span class="picker-face" style="background:'+esc(draft.color)+'">'+esc(draft.emoji)+'</span></div>'+
      '<div class="field"><label>名字</label>'+
        '<input type="text" id="u-name" value="'+esc(draft.name)+'" placeholder="例如：Benson" maxlength="20" autocomplete="off" required></div>'+
      '<div class="field"><label>頭像</label><div class="chips emoji-pick">'+
        USER_EMOJIS.map(function(e){
          return '<button type="button" class="chip '+(draft.emoji===e?"on":"")+'" data-uemoji="'+esc(e)+'">'+esc(e)+'</button>';
        }).join("")+'</div></div>'+
      '<div class="field"><label>顏色</label><div class="chips">'+
        USER_COLORS.map(function(c){
          return '<button type="button" class="swatch '+(draft.color===c?"on":"")+'" data-ucolor="'+esc(c)+'" '+
                 'style="background:'+esc(c)+'" aria-label="'+esc(c)+'"></button>';
        }).join("")+'</div></div>'+
      '<button class="btn" type="submit">'+(u?"儲存":"建立")+'</button>'+
      (u && users.length>1 ? '<button class="btn danger" type="button" data-del-user="1">刪除這位使用者</button>' : '')+
    '</form>';
  }

  function draw(isNew){
    var opts={ onDraw:function(root){
      root.querySelectorAll("[data-uemoji]").forEach(function(b){
        b.onclick=function(){ draft.emoji=b.getAttribute("data-uemoji"); draft.name=root.querySelector("#u-name").value; draw(false); };
      });
      root.querySelectorAll("[data-ucolor]").forEach(function(b){
        b.onclick=function(){ draft.color=b.getAttribute("data-ucolor"); draft.name=root.querySelector("#u-name").value; draw(false); };
      });
      var del=root.querySelector("[data-del-user]");
      if(del) del.onclick=function(){
        if(!confirm("刪除「"+u.name+"」？這會一併刪掉他/她所有的紀錄，無法復原。")) return;
        deleteUser(u.id);
      };
      root.querySelector("#f-user").onsubmit=function(ev){
        ev.preventDefault();
        var name=(root.querySelector("#u-name").value||"").trim();
        if(!name){ toast("請填名字", true); return; }
        draft.name=name;
        saveUser(draft, !u);
      };
    }};
    if(isNew) openSheet(u?"編輯使用者":"新增使用者", body(), opts);
    else replaceSheet(u?"編輯使用者":"新增使用者", body(), opts);
  }
  draw(true);
}

function saveUser(draft, isNew){
  var clean=cleanUser(draft);
  if(isNew){
    users.push(clean);
  }else{
    for(var i=0;i<users.length;i++){
      if(users[i].id===clean.id){ users[i]=clean; break; }
    }
    if(me && me.id===clean.id) me=clean;
  }
  users=normalizeUsers(users);
  persistUsers();
  closeAllSheets();
  if(isNew){
    toast("已建立 "+clean.name);
    switchUser(clean.id);
  }else{
    toast("已更新");
    render();
  }
}

function deleteUser(id){
  var wasMe = me && me.id===id;
  users=users.filter(function(u){ return u.id!==id; });
  chainPersist("users", function(){ return STORE.deleteUser(id); });
  closeAllSheets();
  toast("已刪除");
  if(wasMe){
    me=null; clearCurUserId();
    picking=true; render();
  }else{
    render();
  }
}

/* 切換使用者：把上一位的資料整個丟掉再載入，避免看到別人的紀錄 */
function switchUser(id, after){
  var u=users.filter(function(x){ return x.id===id; })[0];
  if(!u){ picking=true; render(); return; }
  me=u;
  setCurUserId(u.id);
  db={ profile:defaultProfile(), foods:[], days:{} };
  histDates=[]; histLoaded=false;
  curDate=dateKey();
  view="today"; picking=false;
  $app.innerHTML='<div class="spin" style="padding-top:140px"><div class="dots"><i></i><i></i><i></i></div>載入 '+esc(u.name)+' 的紀錄…</div>';
  loadUserData().then(function(){
    if(after) after(); else render();
    window.scrollTo(0,0);
  });
}

function loadUserData(){
  var todayKeys=[];
  for(var i=0;i<7;i++) todayKeys.push(shiftDate(curDate,-i));
  var u=me.id;
  return STORE.loadCore(u).then(function(core){
    if(!me || me.id!==u) return; /* 載入途中又切了人：丟棄這批結果 */
    db.profile=cleanProfile(core.profile||{});
    db.foods=core.foods||[];
    return STORE.loadDays(u, todayKeys);
  }).then(function(days){
    if(!me || me.id!==u) return;
    (days||[]).forEach(function(d){ db.days[d.date]=d; });
    histDates=Object.keys(db.days);
    booted=true;
  }).catch(function(e){
    booted=true;
    toast(e.userMessage||"載入失敗，先用預設值", true);
  });
}

/* ============ sheet 基礎 ============ */
var sheetStack=[];
function openSheet(title, bodyHtml, opts){
  opts=opts||{};
  sheetStack.push({title:title, body:bodyHtml, opts:opts});
  drawSheet();
}
function closeSheet(){
  sheetStack.pop();
  if(sheetStack.length) drawSheet();
  else { $sheetLayer.hidden=true; $sheetLayer.innerHTML=""; document.body.style.overflow=""; }
}
function closeAllSheets(){
  sheetStack=[];
  $sheetLayer.hidden=true; $sheetLayer.innerHTML=""; document.body.style.overflow="";
}
function drawSheet(){
  var s=sheetStack[sheetStack.length-1];
  $sheetLayer.hidden=false;
  document.body.style.overflow="hidden";
  $sheetLayer.innerHTML=
    '<div class="mask"></div>'+
    '<div class="sheet">'+
      '<div class="sheet-head"><h2>'+esc(s.title)+'</h2><button data-sheet="close">關閉</button></div>'+
      (s.opts.tabs||"")+
      '<div class="sheet-body">'+s.body+'</div>'+
    '</div>';
  $sheetLayer.querySelector(".mask").onclick=closeSheet;
  $sheetLayer.querySelector('[data-sheet="close"]').onclick=closeSheet;
  if(s.opts.onDraw) s.opts.onDraw($sheetLayer);
}
/* 只換內容不重推堆疊（AI 讀取中 -> 結果） */
function replaceSheet(title, bodyHtml, opts){
  sheetStack[sheetStack.length-1]={title:title, body:bodyHtml, opts:opts||{}};
  drawSheet();
}

/* ============ 新增飲食 sheet ============ */
function guessMeal(){
  var h=new Date().getHours();
  if(h<10) return "breakfast";
  if(h<15) return "lunch";
  if(h<21) return "dinner";
  return "snack";
}
var addTab="text";
var addMeal=null;

function openAddSheet(meal){
  addMeal=meal||guessMeal();
  addTab=hasAiKey()?"text":"manual";
  drawAddSheet(true);
}
function drawAddSheet(isNew){
  var tabs='<div class="tabs">'+
    tabBtn("text","📝 文字")+tabBtn("photo","📷 拍照")+tabBtn("fav","⭐ 常吃")+tabBtn("manual","✏️ 手動")+
  '</div>';
  var body=mealPicker()+addTabBody();
  var opts={ tabs:tabs, onDraw:wireAddSheet };
  if(isNew) openSheet("記一筆 · "+me.name, body, opts);
  else replaceSheet("記一筆 · "+me.name, body, opts);
}
function tabBtn(id,label){
  return '<button data-tab="'+id+'" class="'+(addTab===id?"on":"")+'">'+label+'</button>';
}
function mealPicker(){
  return '<div class="field" style="margin-top:0"><label>記在哪一餐</label><div class="chips">'+
    MEALS.map(function(mk){
      return '<button class="chip '+(addMeal===mk?"on":"")+'" data-meal-pick="'+mk+'">'+
             MEAL_INFO[mk].emoji+' '+MEAL_INFO[mk].label+'</button>';
    }).join("")+'</div></div>';
}

function noKeyBox(){
  return '<div class="card" style="margin:14px 0 0">'+
    '<h2>還沒設定 API key</h2>'+
    '<p class="desc" style="margin-bottom:0">AI 判讀需要你自己的 Anthropic API key。'+
    '到「設定 → AI 熱量判讀」貼上就能用；在那之前可以先用「手動」或「常吃」記錄。</p>'+
    '<button class="btn" data-act2="go-settings">前往設定</button></div>';
}

function addTabBody(){
  if(addTab==="text"){
    if(!hasAiKey()) return noKeyBox();
    return '<form id="f-text">'+
      '<div class="field"><label>吃了什麼</label>'+
        '<textarea id="i-text" placeholder="例如：排骨便當加飯、南瓜湯頭的麵疙瘩、大杯半糖珍奶" '+
          'autocomplete="off"></textarea>'+
        '<div class="hint">講得越具體越準：份量、湯頭、甜度、加不加飯都可以寫。</div></div>'+
      '<button class="btn" type="submit">交給 AI 估算</button>'+
    '</form>';
  }
  if(addTab==="photo"){
    if(!hasAiKey()) return noKeyBox();
    return '<form id="f-photo">'+
      '<div id="photo-slot">'+
        '<label class="photo-pick" for="i-photo"><i>📷</i>拍照或從相簿選一張'+
          '<span style="font-size:12px;font-weight:600">整桌、便當盒都可以，會自動拆成多筆</span></label>'+
      '</div>'+
      '<input type="file" id="i-photo" accept="image/*" capture="environment" hidden>'+
      '<div class="field"><label>補充說明（選填）</label>'+
        '<input type="text" id="i-hint" placeholder="例如：這碗是大碗、白飯只吃一半" autocomplete="off"></div>'+
      '<button class="btn" type="submit" id="b-photo" disabled>交給 AI 估算</button>'+
    '</form>';
  }
  if(addTab==="fav"){
    if(!db.foods.length){
      return '<div class="card" style="margin:14px 0 0"><p class="desc" style="margin:0">'+
             esc(me.name)+' 還沒有常吃項目。用 AI 或手動記過的東西會自動存進這裡，下次一鍵就能加。</p></div>';
    }
    return '<div class="field"><label>搜尋</label>'+
      '<input type="text" id="i-fav-q" placeholder="輸入食物名稱" autocomplete="off"></div>'+
      '<div id="fav-list">'+favListHtml("")+'</div>';
  }
  /* manual */
  return '<form id="f-manual">'+
    '<div class="field"><label>名稱</label><input type="text" id="m-name" placeholder="例如：滷肉飯" autocomplete="off" required></div>'+
    '<div class="field"><label>熱量 (大卡)</label><input type="number" inputmode="numeric" id="m-kcal" placeholder="0" required></div>'+
    '<div class="ai-nums c3" style="margin-top:12px">'+
      '<label><span>蛋白 g</span><input type="number" inputmode="numeric" id="m-p" placeholder="0"></label>'+
      '<label><span>碳水 g</span><input type="number" inputmode="numeric" id="m-c" placeholder="0"></label>'+
      '<label><span>脂肪 g</span><input type="number" inputmode="numeric" id="m-f" placeholder="0"></label>'+
    '</div>'+
    '<button class="btn" type="submit">加入</button>'+
  '</form>';
}

function favListHtml(q){
  q=String(q||"").trim().toLowerCase();
  var list=db.foods.filter(function(f){ return !q || f.name.toLowerCase().indexOf(q)>=0; }).slice(0,60);
  if(!list.length) return '<p class="empty">找不到符合的項目</p>';
  return list.map(function(f){
    return '<button class="food-row" data-fav="'+esc(f.id)+'">'+
      '<b>'+esc(f.name)+(f.portion?'<span style="display:block;font-size:11.5px;color:var(--muted);font-weight:600">'+esc(f.portion)+'</span>':'')+'</b>'+
      '<span class="k num">'+kcal(f.kcal)+'</span>'+
      '<span style="color:var(--acc);font-size:20px">＋</span>'+
    '</button>';
  }).join("");
}

function wireAddSheet(root){
  root.querySelectorAll("[data-tab]").forEach(function(b){
    b.onclick=function(){ addTab=b.getAttribute("data-tab"); drawAddSheet(false); };
  });
  root.querySelectorAll("[data-meal-pick]").forEach(function(b){
    b.onclick=function(){ addMeal=b.getAttribute("data-meal-pick"); drawAddSheet(false); };
  });
  root.querySelectorAll('[data-act2="go-settings"]').forEach(function(b){
    b.onclick=function(){ closeAllSheets(); view="settings"; render(); window.scrollTo(0,0); };
  });

  var fText=root.querySelector("#f-text");
  if(fText) fText.onsubmit=function(ev){
    ev.preventDefault();
    var t=(root.querySelector("#i-text")||{}).value||"";
    if(!t.trim()){ toast("先描述一下吃了什麼", true); return; }
    runAi(function(){ return aiAnalyzeText(db.profile.model, t); });
  };

  var fPhoto=root.querySelector("#f-photo");
  if(fPhoto){
    var input=root.querySelector("#i-photo");
    var btn=root.querySelector("#b-photo");
    var slot=root.querySelector("#photo-slot");
    input.onchange=function(){
      var file=input.files&&input.files[0];
      if(!file) return;
      btn.disabled=true;
      btn.textContent="處理照片中…";
      compressImage(file).then(function(dataUrl){
        pendingPhoto=dataUrl;
        slot.innerHTML='<img class="photo-prev" src="'+dataUrl+'" alt="餐點照片">'+
          '<label class="btn ghost" for="i-photo" style="margin-top:0">換一張</label>';
        btn.disabled=false;
        btn.textContent="交給 AI 估算";
      }).catch(function(e){
        toast(e.userMessage||"照片處理失敗", true);
        btn.textContent="交給 AI 估算";
      });
    };
    fPhoto.onsubmit=function(ev){
      ev.preventDefault();
      if(!pendingPhoto){ toast("請先選一張照片", true); return; }
      var hint=(root.querySelector("#i-hint")||{}).value||"";
      var photo=pendingPhoto;
      runAi(function(){ return aiAnalyzePhoto(db.profile.model, photo, hint); });
    };
  }

  var q=root.querySelector("#i-fav-q");
  if(q) q.oninput=function(){ root.querySelector("#fav-list").innerHTML=favListHtml(q.value); wireFav(root); };
  wireFav(root);

  var fMan=root.querySelector("#f-manual");
  if(fMan) fMan.onsubmit=function(ev){
    ev.preventDefault();
    var name=(root.querySelector("#m-name")||{}).value||"";
    var k=Number((root.querySelector("#m-kcal")||{}).value)||0;
    if(!name.trim()){ toast("請填名稱", true); return; }
    var item={ id:uid(), name:name.trim(),
      kcal:k, p:Number((root.querySelector("#m-p")||{}).value)||0,
      c:Number((root.querySelector("#m-c")||{}).value)||0,
      f:Number((root.querySelector("#m-f")||{}).value)||0,
      portion:"", src:"manual" };
    addEntries([item]);
  };
}
var pendingPhoto=null;

function wireFav(root){
  root.querySelectorAll("[data-fav]").forEach(function(b){
    b.onclick=function(){
      var id=b.getAttribute("data-fav");
      var f=db.foods.filter(function(x){ return x.id===id; })[0];
      if(!f) return;
      addEntries([{ id:uid(), name:f.name, kcal:f.kcal, p:f.p||0, c:f.c||0, f:f.f||0,
                    portion:f.portion||"", src:"preset" }]);
    };
  });
}

/* ---- 呼叫 AI 並顯示可編輯的預覽 ---- */
function runAi(fn){
  replaceSheet("AI 估算中",
    '<div class="spin"><div class="dots"><i></i><i></i><i></i></div>Claude 正在看你吃了什麼…</div>', {});
  fn().then(function(res){
    aiResult=res;
    drawAiResult();
  }).catch(function(e){
    toast(e.userMessage||"AI 估算失敗", true);
    drawAddSheet(false); /* 退回輸入畫面，讓他改描述重試 */
  });
}

var aiResult=null;
function drawAiResult(){
  var body='';
  if(aiResult.note) body+='<div class="ai-note">💡 '+esc(aiResult.note)+'</div>';
  body+=mealPicker();
  aiResult.items.forEach(function(it,idx){
    var cf = it.confidence==="high" ? "" :
      '<span class="conf '+it.confidence+'">'+(it.confidence==="low"?"不太確定":"約略")+'</span>';
    body+='<div class="ai-item">'+
      '<div class="t"><b>'+esc(it.name)+cf+'</b>'+
        '<button data-drop="'+idx+'" aria-label="移除">✕</button></div>'+
      (it.portion?'<div class="por">'+esc(it.portion)+'</div>':'')+
      '<div class="ai-nums">'+
        '<label><span>大卡</span><input type="number" inputmode="numeric" data-f="kcal" data-i="'+idx+'" value="'+it.kcal+'"></label>'+
        '<label><span>蛋白 g</span><input type="number" inputmode="numeric" data-f="p" data-i="'+idx+'" value="'+it.p+'"></label>'+
        '<label><span>碳水 g</span><input type="number" inputmode="numeric" data-f="c" data-i="'+idx+'" value="'+it.c+'"></label>'+
        '<label><span>脂肪 g</span><input type="number" inputmode="numeric" data-f="f" data-i="'+idx+'" value="'+it.f+'"></label>'+
      '</div>'+
    '</div>';
  });
  var total=0; aiResult.items.forEach(function(i){ total+=num(i.kcal); });
  body+='<button class="btn" data-ai="save">加入 '+aiResult.items.length+' 筆 · 共 '+kcal(total)+' 大卡</button>'+
        '<button class="btn ghost" data-ai="retry">重新描述</button>';

  replaceSheet("AI 估算結果 · "+me.name, body, { onDraw:function(root){
    root.querySelectorAll("[data-meal-pick]").forEach(function(b){
      b.onclick=function(){ addMeal=b.getAttribute("data-meal-pick"); drawAiResult(); };
    });
    root.querySelectorAll("[data-f]").forEach(function(inp){
      inp.oninput=function(){
        var i=+inp.getAttribute("data-i");
        aiResult.items[i][inp.getAttribute("data-f")]=Math.max(0, Math.round(Number(inp.value)||0));
        var t=0; aiResult.items.forEach(function(x){ t+=num(x.kcal); });
        var sv=root.querySelector('[data-ai="save"]');
        if(sv) sv.textContent="加入 "+aiResult.items.length+" 筆 · 共 "+kcal(t)+" 大卡";
      };
    });
    root.querySelectorAll("[data-drop]").forEach(function(b){
      b.onclick=function(){
        aiResult.items.splice(+b.getAttribute("data-drop"),1);
        if(!aiResult.items.length){ drawAddSheet(false); return; }
        drawAiResult();
      };
    });
    var save=root.querySelector('[data-ai="save"]');
    if(save) save.onclick=function(){ addEntries(aiResult.items); };
    var retry=root.querySelector('[data-ai="retry"]');
    if(retry) retry.onclick=function(){ drawAddSheet(false); };
  }});
}

/* ---- 真的寫進當天 ---- */
function addEntries(items){
  var d=dayOf(curDate);
  var t=nowHM();
  items.forEach(function(it){
    d.entries.push(cleanEntry({
      id:it.id||uid(), time:t, meal:addMeal, name:it.name, kcal:it.kcal,
      p:it.p, c:it.c, f:it.f, portion:it.portion, src:it.src||"ai"
    }));
    rememberFood(it);
  });
  persistDay(curDate);
  pendingPhoto=null; aiResult=null;
  closeAllSheets();
  render();
  toast("已記錄 "+items.length+" 筆");
}

/* ============ 編輯／刪除單筆飲食 ============ */
function openEntrySheet(id){
  var d=dayOf(curDate);
  var e=d.entries.filter(function(x){ return x.id===id; })[0];
  if(!e) return;
  var body='<form id="f-edit">'+
    '<div class="field" style="margin-top:0"><label>名稱</label>'+
      '<input type="text" id="e-name" value="'+esc(e.name)+'" autocomplete="off" required></div>'+
    (e.portion?'<p class="hint" style="font-size:12px;color:var(--muted);margin:-6px 0 0;line-height:1.5">AI 假設：'+esc(e.portion)+'</p>':'')+
    '<div class="field"><label>記在哪一餐</label><div class="chips">'+
      MEALS.map(function(mk){
        return '<button type="button" class="chip '+(e.meal===mk?"on":"")+'" data-emeal="'+mk+'">'+
               MEAL_INFO[mk].emoji+' '+MEAL_INFO[mk].label+'</button>';
      }).join("")+'</div></div>'+
    '<div class="ai-nums" style="margin-top:12px">'+
      '<label><span>大卡</span><input type="number" inputmode="numeric" id="e-kcal" value="'+e.kcal+'"></label>'+
      '<label><span>蛋白 g</span><input type="number" inputmode="numeric" id="e-p" value="'+(e.p||0)+'"></label>'+
      '<label><span>碳水 g</span><input type="number" inputmode="numeric" id="e-c" value="'+(e.c||0)+'"></label>'+
      '<label><span>脂肪 g</span><input type="number" inputmode="numeric" id="e-f" value="'+(e.f||0)+'"></label>'+
    '</div>'+
    '<div class="field"><label>時間</label><input type="time" id="e-time" value="'+esc(e.time||"")+'"></div>'+
    '<button class="btn" type="submit">儲存</button>'+
    '<button class="btn danger" type="button" data-del="1">刪除這筆</button>'+
  '</form>';

  var pickedMeal=e.meal;
  openSheet("編輯", body, { onDraw:function(root){
    root.querySelectorAll("[data-emeal]").forEach(function(b){
      b.onclick=function(){
        pickedMeal=b.getAttribute("data-emeal");
        root.querySelectorAll("[data-emeal]").forEach(function(x){
          x.className="chip"+(x.getAttribute("data-emeal")===pickedMeal?" on":"");
        });
      };
    });
    root.querySelector("[data-del]").onclick=function(){
      if(!confirm("刪除「"+e.name+"」？")) return;
      d.entries=d.entries.filter(function(x){ return x.id!==id; });
      persistDay(curDate);
      closeSheet(); render(); toast("已刪除");
    };
    root.querySelector("#f-edit").onsubmit=function(ev){
      ev.preventDefault();
      e.name=(root.querySelector("#e-name").value||"").trim()||e.name;
      e.meal=pickedMeal;
      e.kcal=Math.max(0, Math.round(Number(root.querySelector("#e-kcal").value)||0));
      e.p=Math.max(0, Math.round(Number(root.querySelector("#e-p").value)||0));
      e.c=Math.max(0, Math.round(Number(root.querySelector("#e-c").value)||0));
      e.f=Math.max(0, Math.round(Number(root.querySelector("#e-f").value)||0));
      e.time=root.querySelector("#e-time").value||e.time;
      persistDay(curDate);
      closeSheet(); render(); toast("已更新");
    };
  }});
}

/* ============ 運動 ============ */
var MOVE_PRESETS=[
  {name:"快走 30 分", kcal:120}, {name:"慢跑 30 分", kcal:300},
  {name:"重訓 60 分", kcal:300}, {name:"游泳 30 分", kcal:280},
  {name:"單車 60 分", kcal:400}, {name:"爬山 60 分", kcal:450}
];
function openMoveSheet(id){
  var d=dayOf(curDate);
  var mv=id ? d.moves.filter(function(x){ return x.id===id; })[0] : null;
  var body='<form id="f-move">'+
    (mv?'':'<div class="field" style="margin-top:0"><label>快速選擇</label><div class="chips">'+
      MOVE_PRESETS.map(function(p,i){
        return '<button type="button" class="chip" data-mp="'+i+'">'+esc(p.name)+'</button>';
      }).join("")+'</div></div>')+
    '<div class="field"><label>項目</label>'+
      '<input type="text" id="mv-name" value="'+esc(mv?mv.name:"")+'" placeholder="例如：慢跑 30 分" autocomplete="off" required></div>'+
    '<div class="field"><label>消耗熱量 (大卡)</label>'+
      '<input type="number" inputmode="numeric" id="mv-kcal" value="'+(mv?mv.kcal:"")+'" placeholder="0" required>'+
      '<div class="hint">只記「額外」運動。日常走路已經算在活動係數裡了，重複記會高估。</div></div>'+
    '<button class="btn" type="submit">'+(mv?"儲存":"加入")+'</button>'+
    (mv?'<button class="btn danger" type="button" data-del="1">刪除這筆</button>':'')+
  '</form>';

  openSheet(mv?"編輯運動":"記一筆運動", body, { onDraw:function(root){
    root.querySelectorAll("[data-mp]").forEach(function(b){
      b.onclick=function(){
        var p=MOVE_PRESETS[+b.getAttribute("data-mp")];
        root.querySelector("#mv-name").value=p.name;
        root.querySelector("#mv-kcal").value=p.kcal;
      };
    });
    var del=root.querySelector("[data-del]");
    if(del) del.onclick=function(){
      if(!confirm("刪除「"+mv.name+"」？")) return;
      d.moves=d.moves.filter(function(x){ return x.id!==id; });
      persistDay(curDate);
      closeSheet(); render(); toast("已刪除");
    };
    root.querySelector("#f-move").onsubmit=function(ev){
      ev.preventDefault();
      var name=(root.querySelector("#mv-name").value||"").trim();
      var k=Math.max(0, Math.round(Number(root.querySelector("#mv-kcal").value)||0));
      if(!name){ toast("請填項目", true); return; }
      if(mv){ mv.name=name; mv.kcal=k; }
      else d.moves.push(cleanMove({ id:uid(), time:nowHM(), name:name, kcal:k }));
      persistDay(curDate);
      closeSheet(); render(); toast(mv?"已更新":"已記錄");
    };
  }});
}

/* ============ 備註 ============ */
function openNotesSheet(){
  var d=dayOf(curDate);
  var body='<form id="f-notes">'+
    '<div class="field" style="margin-top:0"><label>'+esc(fmtLong(curDate))+' 的備註</label>'+
      '<textarea id="n-text" style="min-height:180px" placeholder="今天的身體感覺、外食場合、想記住的事…">'+esc(d.notes)+'</textarea></div>'+
    '<button class="btn" type="submit">儲存</button>'+
  '</form>';
  openSheet("備註", body, { onDraw:function(root){
    root.querySelector("#f-notes").onsubmit=function(ev){
      ev.preventDefault();
      d.notes=root.querySelector("#n-text").value||"";
      persistDay(curDate);
      closeSheet(); render(); toast("已儲存");
    };
  }});
}

/* ============ 載入 ============ */
function ensureDays(keys){
  if(!me) return Promise.resolve();
  var u=me.id;
  var need=keys.filter(function(k){ return !db.days[k]; });
  if(!need.length) return Promise.resolve();
  need.forEach(function(k){ db.days[k]=emptyDay(k); }); /* 先放空的，避免重複請求 */
  return STORE.loadDays(u, need).then(function(days){
    if(!me || me.id!==u) return; /* 載入途中切了人：丟棄 */
    days.forEach(function(d){ db.days[d.date]=d; });
    if(booted && !picking) render();
  }).catch(function(e){
    toast(e.userMessage||"讀取紀錄失敗", true);
  });
}

function ensureHistory(){
  if(histLoaded || !me) return;
  var u=me.id;
  STORE.loadIndex(u).then(function(dates){
    if(!me || me.id!==u) return;
    histDates=dates;
    histLoaded=true;
    /* 最近 30 天的內容補進來，歷史頁才畫得出長條 */
    return ensureDays(dates.slice(-30));
  }).then(function(){
    if(view==="history" && !picking) render();
  }).catch(function(){
    histLoaded=true;
    if(view==="history" && !picking) render();
  });
}

function boot(){
  $app.innerHTML='<div class="spin" style="padding-top:140px"><div class="dots"><i></i><i></i><i></i></div>載入中…</div>';

  STORE.loadUsers().then(function(list){
    users=list||[];
    var saved=getCurUserId();
    var found=users.filter(function(u){ return u.id===saved; })[0];
    if(!users.length || !found){
      /* 沒有使用者（第一次用）或這台裝置還沒選過人 -> 停在選人畫面 */
      booted=true; picking=true; me=null; render();
      return;
    }
    me=found;
    return loadUserData().then(render);
  }).catch(function(e){
    booted=true; picking=true; me=null;
    render();
    toast(e.userMessage||"載入使用者失敗", true);
  });
}

/* 換日：PWA 常常整天不關，午夜過後要自己把 curDate 推到新的一天 */
var bootDay=dateKey();
document.addEventListener("visibilitychange", function(){
  if(document.hidden) return;
  var now=dateKey();
  if(now!==bootDay && curDate===bootDay){
    bootDay=now; curDate=now;
    if(me) ensureDays([now]).then(function(){ if(!picking) render(); });
  }
});

boot();

/* Service worker（相對路徑：Pages 子路徑也要對） */
if("serviceWorker" in navigator){
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("sw.js").catch(function(){ /* 沒 SW 也能用 */ });
  });
}
