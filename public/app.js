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
var showDetail=false;           /* 首頁熱量卡的明細（每日上限／TDEE／淨攝取）是否展開 */
var showMNote=false;            /* 營養頁「目標是怎麼算的」是否展開 */
var birthSaveTimer=null;        /* 生日欄延後落檔：滾一次年份就 change 一次，別每次都寫檔 */
var picking=false;              /* 是否停在「誰在用？」畫面 */
var curDate=dateKey();
var histDates=[];
var histLoaded=false;
var HIST_DAYS=60;               /* 歷史頁的天數：載入與繪製共用同一個窗口，兩邊分開寫過就對不上了 */
var booted=false;

function dayOf(key){ return db.days[key] || (db.days[key]=emptyDay(key)); }

/* ============ 持久化（樂觀更新：畫面先動，背景寫入） ============
 * 待同步佇列（別拿掉）：樂觀更新的代價是「畫面說已記錄，雲端其實還沒有」。
 * 以前寫入失敗只跳一個 3 秒的 toast 就放棄，使用者根本不知道資料沒上去，
 * 關掉 app 就真的沒了（2026-07-26 踩過，一整餐 6 筆消失）。
 * 現在失敗的寫入留在 pending 裡，回到前景／網路恢復／按重試時再送，
 * 並在畫面最上面掛一條橫幅，直到真的寫進去為止。 */
var persistChains={};
var pending={};                    /* key -> {job, label}，key 同時也是「哪一份檔案」 */
var pendingTimer=null, pendingFails=0;

function chainPersist(key, job, label){
  var run=function(){
    return job().then(function(r){
      if(pending[key]){ delete pending[key]; drawSyncBar(); }
      pendingFails=0;
      return r;
    }, function(e){
      pending[key]={ job:job, label:label||"資料" };
      toast((label||"資料")+"還沒同步到雲端，會自動重試", true);
      drawSyncBar();
      schedulePendingRetry();
    });
  };
  /* 手機版（GitHub Contents API）：一次 PUT ＝ 一個 commit，衝突發生在「分支」層級，
   * 不是檔案層級——不同檔案平行寫一樣會 409。所以手機版所有寫入共用一條佇列。
   * 本機版是直接寫檔案，沒有這個問題，維持 per-file 排隊（比較快）。 */
  var lane = STORE.local ? key : "gh";
  persistChains[lane]=(persistChains[lane]||Promise.resolve()).then(run);
  return persistChains[lane];
}

function schedulePendingRetry(){
  if(pendingTimer) return;
  pendingFails++;
  var delay=Math.min(60000, 6000*Math.pow(2, Math.min(3, pendingFails-1))); /* 6s→12s→24s→48s→60s */
  pendingTimer=setTimeout(function(){ pendingTimer=null; retryPending(); }, delay);
}
function retryPending(){
  var keys=Object.keys(pending);
  if(!keys.length){ pendingFails=0; return; }
  if(navigator.onLine===false){ schedulePendingRetry(); return; }
  keys.forEach(function(k){
    var it=pending[k];
    delete pending[k];              /* 重新入列；再失敗會被放回來 */
    chainPersist(k, it.job, it.label);
  });
  drawSyncBar();
}
function drawSyncBar(){
  var el=document.getElementById("sync-bar");
  if(!el) return;
  var keys=Object.keys(pending);
  if(!keys.length){
    el.hidden=true; el.innerHTML="";
    document.body.classList.remove("has-sync");
    return;
  }
  var names=keys.map(function(k){ return pending[k].label; });
  el.innerHTML='<span>'+esc(names.join("、"))+'還沒同步到雲端</span>'+
               '<button type="button" id="sync-retry">立即重試</button>';
  el.hidden=false;
  document.body.classList.add("has-sync");
  el.querySelector("#sync-retry").onclick=function(){
    clearTimeout(pendingTimer); pendingTimer=null; pendingFails=0;
    retryPending();
    toast("重新送出中…");
  };
}
window.addEventListener("online", function(){ retryPending(); });
document.addEventListener("visibilitychange", function(){ if(!document.hidden) retryPending(); });
/* chain key 一律帶 uid：切換使用者後不會跟前一個人的寫入排在同一條鏈上 */
function persistDay(key){
  var d=db.days[key];
  if(!d || !me) return Promise.resolve();
  var u=me.id;
  /* 歷史頁的日期清單只在開 app／第一次點歷史時抓一次，之後就鎖住了。
   * 這裡順手維護：今天剛記的第一筆要馬上出現在歷史，整天清空的要消失。 */
  var at=histDates.indexOf(key);
  if(dayHasData(d)){ if(at<0) histDates.push(key); }
  else if(at>=0) histDates.splice(at,1);
  /* 送快照不送 live 物件：失敗重送時 db 可能已經切成別人了，不能寫錯人的檔案 */
  var snap=JSON.parse(JSON.stringify(d));
  return chainPersist(u+":day:"+key, function(){ return STORE.saveDay(u, snap); }, fmtMD(key)+" 的紀錄");
}
/* 與 server.js 判斷「這天是不是空的、可以刪檔」的條件一致 */
function dayHasData(d){
  return !!(d && ((d.entries||[]).length || (d.moves||[]).length ||
                  String(d.notes||"").trim() || num(d.weight)));
}
function persistProfile(){
  if(!me) return Promise.resolve();
  /* 存過就不再顯示「還沒設定身體資料」。落檔的時間戳由 serializeProfile 蓋，
   * 這裡標記的是「這個 session 已經設定過了」。 */
  db.profile.updatedAt=new Date().toISOString();
  var u=me.id, snap=JSON.parse(JSON.stringify(db.profile));
  return chainPersist(u+":profile", function(){ return STORE.saveProfile(u, snap); }, "身體資料");
}
function persistFoods(){
  if(!me) return Promise.resolve();
  var u=me.id, snap=JSON.parse(JSON.stringify(db.foods));
  return chainPersist(u+":foods", function(){ return STORE.saveFoods(u, snap); }, "常吃清單");
}
function persistUsers(){
  var snap=JSON.parse(JSON.stringify(users));
  return chainPersist("users", function(){ return STORE.saveUsers(snap); }, "使用者名冊");
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
  /* 這裡刻意只動記憶體、不寫檔：一次記 6 筆會變成 6 次寫入，
   * 跟同時進行的「當天紀錄」寫入互撞（GitHub 回 409）。寫檔由呼叫端整批做一次。 */
}

/* ============ 畫面 ============ */
function render(){
  if(picking){ $app.innerHTML=viewPicker(); wire(); window.scrollTo(0,0); return; }
  if(view==="today") $app.innerHTML=viewToday();
  else if(view==="macros") $app.innerHTML=viewMacros();
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
  return '<nav class="nav">'+t("today","🍽","今天")+t("macros","🥗","營養")+
         t("history","📈","歷史")+t("settings","⚙","設定")+'</nav>';
}

/* ---------- 誰在用？（Netflix 式） ---------- */
function avatarHtml(u, cls){
  return '<span class="avatar '+(cls||"")+'" style="background:'+esc(u.color)+'">'+esc(u.emoji)+'</span>';
}
function viewPicker(){
  var first=!users.length;
  var ro=!STORE.canWrite();
  /* 唯讀又還沒有使用者時不要叫他「先建立第一位使用者」——他建不了，會以為 app 壞了 */
  var sub = first
    ? (ro ? "這支手機還沒設定金鑰，先貼上金鑰才能開始。"
          : "先建立第一位使用者。兩個人的紀錄、目標與常吃清單完全獨立。")
    : (ro ? "目前是唯讀模式，可以看但不能記錄。" : "每個人的紀錄與目標都是分開的。");
  var h='<div class="picker">';
  h+='<div class="picker-head">'+
      '<h1>'+(first?"歡迎使用減重助手":"誰在用？")+'</h1>'+
      '<p>'+sub+'</p>'+
     '</div>';
  h+='<div class="picker-grid">';
  users.forEach(function(u){
    h+='<button class="picker-tile" data-pick="'+esc(u.id)+'">'+
        '<span class="picker-face" style="background:'+esc(u.color)+'">'+esc(u.emoji)+'</span>'+
        '<b>'+esc(u.name)+'</b>'+
       '</button>';
  });
  if(STORE.canWrite()){
    h+='<button class="picker-tile add" data-act="new-user">'+
        '<span class="picker-face add">＋</span><b>新增使用者</b></button>';
  }
  h+='</div>';

  /* 唯讀（手機端還沒貼 GitHub 金鑰）時一定要給出口。
   * 少了這段，第一次在手機上開會卡死：沒有使用者 -> 只有「新增使用者」-> 被唯讀擋掉
   * -> 而「設定」要有使用者才進得去 -> 沒有任何地方能貼金鑰。 */
  if(!STORE.canWrite()){
    h+='<div class="picker-note">'+
        '<b>目前是唯讀模式</b>'+
        '<span>手機版要貼上 GitHub 金鑰才能建立使用者與記錄。金鑰只存在這支手機裡。</span>'+
        '<button class="btn" data-act="open-keys">貼上金鑰</button>'+
       '</div>';
  }else{
    h+='<button class="picker-manage" data-act="open-keys">金鑰設定</button>';
  }
  h+='</div>';
  return h;
}

/* ---------- 熱量環 ---------- */
/* 三段（定案）：
 *   綠 = 還在減脂上限內
 *   黃 = 超過減脂上限，但還沒超過 TDEE ← 今天不會胖，只是沒有減脂進度
 *   紅 = 超過 TDEE ← 這才是真的會變胖的量
 * 中間那段以前跟「真的吃過頭」畫成同一種紅色，會讓人以為自己爆了。 */
function ringHtml(net, target, tdee){
  var pct = target>0 ? net/target : 0;
  var shown = Math.max(0, Math.min(1, pct));
  var R=58, C=2*Math.PI*R;
  var over = net>target;
  var hardOver = over && (!(tdee>0) || net>tdee);
  var color = hardOver ? "var(--bad)" : ((over||pct>=0.85) ? "var(--warn)" : "var(--acc)");
  var left = target-net;
  return ''+
  '<div class="ring">'+
    '<svg width="132" height="132" viewBox="0 0 132 132">'+
      '<circle cx="66" cy="66" r="'+R+'" fill="none" stroke="#eef1ea" stroke-width="12"/>'+
      /* shown=0 時完全不畫：round linecap 會在 dasharray 0 的地方留一個小圓點 */
      (shown>0 ? '<circle cx="66" cy="66" r="'+R+'" fill="none" stroke="'+color+'" stroke-width="12" stroke-linecap="round"'+
        ' stroke-dasharray="'+(C*shown).toFixed(1)+' '+C.toFixed(1)+'"/>' : '')+
    '</svg>'+
    '<div class="mid">'+
      '<b class="num" style="color:'+(hardOver?"var(--bad)":(over?"#a86d12":"var(--ink)"))+'">'+kcal(Math.abs(left))+'</b>'+
      '<span>'+(over?"超過上限":"還可以吃")+'</span>'+
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
  var mt=macroTargets(db.profile);
  var isToday=curDate===dateKey();

  var bmr=bmrOf(db.profile), tdee=tdeeOf(db.profile);
  var lateEnough = !isToday || new Date().getHours()>=20; /* 一天還沒過完就講「吃太少」很煩 */
  var tag;
  if(net>target){
    if(tdee>0 && net<=tdee){
      /* 超過減脂上限、但還在 TDEE 以內：今天不會胖，只是這天沒有減脂進度。
       * 「每日上限」是 TDEE 扣掉缺口之後的數字，很容易被誤讀成「超過就是吃太多」。 */
      tag='<div class="over-tag mid">超過上限 '+kcal(net-target)+' 大卡 · 距離 TDEE 還有 '+kcal(tdee-net)+
          '<span>今天大致是維持體重，不會胖，但也幾乎沒有減脂進度</span></div>';
    }else{
      tag='<div class="over-tag over">超過上限 '+kcal(net-target)+' 大卡'+
          (tdee>0?' · 已超出 TDEE '+kcal(net-tdee):'')+
          '<span>超出 TDEE 的部分才是真正會變胖的量</span></div>';
    }
  }else if(net>0 && net<bmr && lateEnough){
    /* 低於基礎代謝：掉的會有一大部分是肌肉，代謝也會往下適應 */
    tag='<div class="over-tag low">只吃了 '+kcal(net)+'，低於基礎代謝 '+kcal(bmr)+
        '<span>長期這樣掉的會有一大部分是肌肉</span></div>';
  }else if(target>0 && net/target>=0.85){
    tag='<div class="over-tag near">快到上限了，剩 '+kcal(target-net)+' 大卡</div>';
  }else{
    /* 一切正常時刻意不顯示：「還在額度內，剩 X」跟圓環中央是同一句話，講兩次只是佔版面 */
    tag='';
  }

  var h=headHtml(me.name);

  h+='<div class="daynav">'+
      '<button data-act="prev-day" aria-label="前一天">‹</button>'+
      '<div class="date">'+esc(fmtLong(curDate))+
        '<small>'+(isToday?"今天":(curDate>dateKey()?"未來":""))+'</small></div>'+
      '<button data-act="next-day" aria-label="後一天" '+(curDate>=dateKey()?"disabled":"")+'>›</button>'+
      (isToday?"":'<button class="today-btn" data-act="go-today">今天</button>')+
     '</div>';

  /* 熱量卡分兩層（定案）：
   * 收合＝每天真的要看的三件事（還能吃多少／已經吃多少／營養素有沒有歪掉）；
   * 展開＝解釋用的數字（每日上限、TDEE、淨攝取、營養素公克數）。
   * 全部攤開的話一張卡上有九個數字，反而看不出重點。 */
  var goalLb=(num(db.profile.goal)<0?"每日上限":"每日目標");
  h+='<section class="ring-card">'+
      '<button class="ring-wrap" data-act="toggle-detail" aria-expanded="'+(showDetail?"true":"false")+'">'+
        ringHtml(net, target, tdee)+
        '<div class="ring-side">'+
          '<div class="kv eat"><span>已攝取</span><b class="num">'+kcal(eaten)+'</b></div>'+
          (burn?'<div class="kv burn"><span>運動消耗</span><b class="num">−'+kcal(burn)+'</b></div>':'')+
          '<div class="kv more"><span>'+(showDetail?"收起明細":"看明細")+'</span>'+
            '<b>'+(showDetail?"⌃":"⌄")+'</b></div>'+
        '</div>'+
      '</button>'+
      (showDetail
        ? '<div class="detail">'+
            '<div class="kv goal"><span>'+goalLb+'</span><b class="num">'+kcal(target)+'</b></div>'+
            (num(db.profile.goal)<0
              ? '<div class="kv tdee"><span>維持體重（TDEE）</span><b class="num">'+kcal(tdee)+'</b></div>'
              : '')+
            (burn?'<div class="kv net"><span>淨攝取（已扣運動）</span><b class="num">'+kcal(net)+'</b></div>':'')+
          '</div>'
        : '')+
      tag+
      macroRowHtml(m, mt)+
     '</section>';

  /* 沒設過身體資料 -> TDEE 是用預設值算的，等於假的，一定要先講 */
  if(!db.profile.updatedAt){
    h+='<section class="sec"><button class="nudge" data-act="setup-profile">'+
        '<b>⚠️ 先設定身體資料</b>'+
        '<span>現在的目標是用預設值算的。填了身高體重活動量，TDEE 才會是你的。</span>'+
       '</button></section>';
  }

  /* 體重（減重 app 的主角，放在熱量環正下方） */
  h+=weighHtml(d);

  /* 餐段：只列「有記東西」的。
   * 以前四個餐段＋運動不管有沒有東西都各佔一張卡，一天有一半是空卡，
   * 光滑過那些「＋ 記一筆晚餐」就要滑半頁。空的收成下面一列快速新增。 */
  var empties=[];
  MEALS.forEach(function(mk){
    var list=(d.entries||[]).filter(function(e){ return e.meal===mk; });
    var info=MEAL_INFO[mk];
    if(!list.length){ empties.push({ act:'data-act="add" data-meal="'+mk+'"', label:info.emoji+' '+info.label }); return; }
    h+='<section class="sec">'+
        '<div class="sec-head"><h2>'+info.emoji+' '+info.label+'</h2>'+
          '<span class="n">'+kcal(sumKcal(list))+' 大卡</span></div>'+
        '<div class="list">';
    list.forEach(function(e){
      h+='<button class="row" data-act="edit-entry" data-id="'+esc(e.id)+'">'+
          '<div class="row-mid"><b>'+esc(e.name)+'</b>'+
            (e.portion||e.time ? '<span>'+esc([e.time,e.portion].filter(Boolean).join(" · "))+'</span>' : '')+
          '</div>'+
          '<div class="row-kcal num">'+kcal(e.kcal)+'<i>大卡</i></div>'+
         '</button>';
    });
    h+='</div></section>';
  });

  /* 運動 */
  if(!d.moves.length){
    empties.push({ act:'data-act="add-move"', label:"🏃 運動" });
  }else{
    h+='<section class="sec">'+
        '<div class="sec-head"><h2>🏃 運動</h2><span class="n">−'+kcal(burn)+' 大卡</span></div>'+
        '<div class="list">';
    d.moves.forEach(function(mv){
      h+='<button class="row" data-act="edit-move" data-id="'+esc(mv.id)+'">'+
          '<div class="row-mid"><b>'+esc(mv.name)+'</b>'+(mv.time?'<span>'+esc(mv.time)+'</span>':'')+'</div>'+
          '<div class="row-kcal burn num">−'+kcal(mv.kcal)+'<i>大卡</i></div>'+
         '</button>';
    });
    h+='<button class="row" data-act="add-move"><div class="row-mid">'+
       '<b style="color:var(--muted);font-weight:600">＋ 再記一筆</b></div></button>'+
      '</div></section>';
  }

  if(empties.length){
    h+='<section class="sec"><div class="sec-head"><h2>還沒記</h2></div>'+
        '<div class="chips addchips">'+
          empties.map(function(x){ return '<button class="chip" '+x.act+'>＋ '+x.label+'</button>'; }).join("")+
        '</div></section>';
  }

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
/* 找 curDate 之前最近一筆有量的體重（只在已載入的日子裡找，夠用且不多打 API） */
function prevWeight(){
  var keys=Object.keys(db.days).filter(function(k){
    return k<curDate && num(db.days[k].weight)>0;
  }).sort();
  return keys.length ? num(db.days[keys[keys.length-1]].weight) : 0;
}
function weighHtml(d){
  var w=num(d.weight);
  var sub;
  if(!w){
    sub='<span>還沒量 · 早上起床空腹最準</span>';
  }else{
    var pv=prevWeight();
    if(pv){
      var diff=w-pv;
      var cls=diff<0?"down":(diff>0?"up":"");
      sub='<span class="'+cls+'">'+(diff===0?"和上次一樣"
        :(diff<0?"↓ ":"↑ ")+Math.abs(diff).toFixed(1)+" kg（比上次）")+'</span>';
    }else{
      sub='<span>第一筆紀錄</span>';
    }
  }
  return '<section class="sec"><button class="weigh" data-act="edit-weight">'+
      '<span class="weigh-ico">⚖️</span>'+
      '<div class="weigh-mid">'+
        (w?'<b class="num">'+w.toFixed(1)+'<i>kg</i></b>':'<b class="none">記錄今天的體重</b>')+
        sub+
      '</div>'+
      '<span class="chev">›</span>'+
     '</button></section>';
}

/* 三大營養素：一格一個，直接寫「目前／目標」。
 * 曾經換成「熱量來自哪裡」的三色比例條，但那回答的是另一個問題——
 * 每天想知道的是「夠不夠、超了沒」，不是「熱量的組成」。（Benson 反映看不懂，改回來）
 * 原本的方塊唯一的問題是 bar 卡在 100%、超標看不出來，所以補上超標狀態。 */
function macroRowHtml(m, mt){
  return '<button class="macros" data-nav2="macros">'+
    macroBox("蛋白","var(--p)",m.p,mt.p,1.2)+   /* 蛋白質吃多一點不是問題，門檻放寬 */
    macroBox("碳水","var(--c)",m.c,mt.c,1.05)+
    macroBox("脂肪","var(--f)",m.f,mt.f,1.05)+
  '</button>';
}
function macroBox(label,color,v,target,overAt){
  var pct = target>0 ? v/target : 0;
  var over = target>0 && pct>(overAt||1.05);
  return '<div class="macro'+(over?" over":"")+'">'+
         '<div class="lb"><span class="dot" style="background:'+(over?"var(--warn)":color)+'"></span>'+label+
           (over?'<em>超標</em>':'')+'</div>'+
         '<b class="num">'+kcal(v)+'<i>/'+kcal(target)+'g</i></b>'+
         '<div class="mbar"><i style="width:'+(Math.min(1,pct)*100).toFixed(0)+'%;'+
           'background:'+(over?"var(--warn)":color)+'"></i></div></div>';
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

/* ---------- 營養 ---------- */
/* 蛋白質換算成食物：差多少克時，給一兩個「等一下可以吃什麼」的具體建議。
 * 只給常見、好取得的。數字是每份的粗略蛋白質含量。 */
/* 名稱都寫成「單份」，需要多份時後面接 ×N 才讀得順 */
var PROTEIN_FOODS = [
  { name:"高蛋白飲",        g:24 },
  { name:"雞胸肉 100g",     g:23 },
  { name:"鮭魚 100g",       g:20 },
  { name:"希臘優格 150g",   g:15 },
  { name:"板豆腐半盒",      g:14 },
  { name:"無糖豆漿 400ml",  g:14 },
  { name:"雞蛋",            g:6  }
];
/* 每種食物最多出現一次，需要多份就寫「×2」。
 * 缺口大到接近整天的目標時不給零食建議——那不是「補一下」的量，
 * 講「等於 5 份高蛋白飲」只會讓人放棄。 */
function proteinAdvice(gap, target){
  gap=Math.round(gap);
  if(gap<=5) return "";
  if(target>0 && gap>target*0.6) return "";
  var picks=[], left=gap;
  for(var i=0;i<PROTEIN_FOODS.length && picks.length<3 && left>5;i++){
    var f=PROTEIN_FOODS[i];
    if(left < f.g*0.7) continue;
    var n=Math.max(1, Math.min(2, Math.round(left/f.g)));
    picks.push(f.name + (n>1 ? " ×"+n : ""));
    left-=f.g*n;
  }
  return picks.length ? picks.join("＋") : "";
}

function viewMacros(){
  var d=dayOf(curDate);
  var m=macrosOf(d);
  var mt=macroTargets(db.profile);
  var eaten=sumKcal(d.entries);
  var isToday=curDate===dateKey();

  var h=headHtml("營養");
  h+='<div class="daynav">'+
      '<button data-act="prev-day" aria-label="前一天">‹</button>'+
      '<div class="date">'+esc(fmtLong(curDate))+
        '<small>'+(isToday?"今天":"")+'</small></div>'+
      '<button data-act="next-day" aria-label="後一天" '+(curDate>=dateKey()?"disabled":"")+'>›</button>'+
      (isToday?"":'<button class="today-btn" data-act="go-today">今天</button>')+
     '</div>';

  if(!eaten && !m.p && !m.c && !m.f){
    h+='<div class="card"><p class="desc" style="margin:0">今天還沒有紀錄。回「今天」記一筆，這裡就會出現營養分析。</p></div>';
    return h;
  }

  /* 三大營養素合成一張卡（本來三張各佔 270px，光這裡就要滑一屏半）。
   * 語意不同：蛋白質是「至少要吃到」，脂肪碳水是「不要超過」。
   * 每一列底下的「目標＝…」公式收進最下面的展開——那是看一次就懂的東西，
   * 天天佔版面只是雜訊（設定頁也寫過一次）。 */
  var rows=[
    { label:"蛋白質", color:"var(--p)", v:m.p, target:mt.p, mode:"atleast",
      note:"體重 "+Math.round(num(db.profile.weight))+"kg × "+num(db.profile.proteinPerKg)+" g/kg。減脂期至少吃到，這是保住肌肉的關鍵。" },
    { label:"脂肪", color:"var(--f)", v:m.f, target:mt.f, mode:"cap", min:mt.fMin,
      note:"每日熱量的 "+Math.round(num(db.profile.fatPct))+"%。別超過，但也別低於 "+mt.fMin+" g（體重×0.6），長期太低會影響荷爾蒙。" },
    { label:"碳水", color:"var(--c)", v:m.c, target:mt.c, mode:"cap",
      note:"熱量扣掉蛋白質與脂肪之後剩下的額度。" }
  ];
  /* 蛋白質不夠時，建議直接接在那一列後面（以前另外開一張黃卡，等於同一件事講兩次） */
  var gap=mt.p-m.p;
  if(gap>5){
    var advice=proteinAdvice(gap, mt.p);
    rows[0].adv = advice ? "補一份："+advice
                         : (gap>mt.p*0.6 ? "接下來的正餐記得配一份肉、魚、蛋或豆製品" : "");
  }else if(m.p>0){
    rows[0].adv = "達標了 👍 減脂期最重要的一項守住了";
  }

  h+='<div class="sec"><div class="mcard">'+rows.map(macroRow).join("")+'</div>';

  /* 資料品質提醒：三大加起來的熱量跟記錄的熱量差太多，代表有幾筆只填了熱量 */
  var tot=m.p*4+m.c*4+m.f*9;
  if(eaten>0 && tot>0 && Math.abs(tot-eaten)>eaten*0.15){
    h+='<p class="hint" style="padding:10px 4px 0">三大營養素加起來 '+kcal(tot)+' 大卡，'+
       '但記錄的熱量是 '+kcal(eaten)+' 大卡。差距通常是某幾筆只填了熱量、沒填營養素。</p>';
  }

  h+='<button class="mnote-btn" data-act="toggle-mnote">目標是怎麼算的 '+(showMNote?"⌃":"⌄")+'</button>'+
     (showMNote
       ? '<div class="mnotes">'+rows.map(function(o){
           return '<p><b>'+esc(o.label)+'</b>'+esc(o.note)+'</p>';
         }).join("")+'</div>'
       : '')+
     '</div>';

  /* 7 日蛋白質：單日會波動，看趨勢才有意義 */
  h+=proteinWeekHtml(mt.p);

  return h;
}

function macroRow(o){
  var v=Math.round(o.v), target=Math.round(o.target);
  var pct = target>0 ? v/target : 0;
  var state, msg;
  if(o.mode==="atleast"){
    /* 蛋白質：吃不夠才是問題，超過不算壞事 */
    if(pct>=1){ state="ok"; msg="達標"; }
    else if(pct>=0.8){ state="near"; msg="差 "+(target-v)+" g"; }
    else { state="under"; msg="差 "+(target-v)+" g"; }
  }else{
    if(o.min && v>0 && v<o.min){ state="under"; msg="低於下限 "+o.min+" g"; }
    else if(pct>1.1){ state="over"; msg="超過 "+(v-target)+" g"; }
    else if(pct>1){ state="near"; msg="接近上限"; }
    else { state="ok"; msg="還有 "+(target-v)+" g"; }
  }
  return '<div class="mrow '+state+'">'+
      '<div class="mrow-top">'+
        '<b>'+esc(o.label)+'</b>'+
        '<span class="mrow-num num">'+v+'<i>/'+target+' g</i></span>'+
      '</div>'+
      '<div class="mbar big"><i style="width:'+Math.min(100,pct*100).toFixed(0)+'%;background:'+o.color+'"></i>'+
        (o.mode==="atleast"?'':'<u style="left:100%"></u>')+
      '</div>'+
      '<div class="mrow-foot"><span class="tag">'+esc(msg)+'</span>'+
        (o.adv?'<span>'+esc(o.adv)+'</span>':'')+
      '</div>'+
    '</div>';
}

function proteinWeekHtml(target){
  var keys=[], i;
  for(i=6;i>=0;i--) keys.push(shiftDate(curDate,-i));
  var days=keys.map(function(k){ return db.days[k]; });
  var vals=days.map(function(d){ return d?macrosOf(d).p:0; });
  var logged=days.filter(function(d){ return d && (d.entries||[]).length; }).length;
  if(!logged) return "";
  var hit=vals.filter(function(v){ return v>=target; }).length;
  var avg=Math.round(vals.reduce(function(a,b){return a+b;},0)/Math.max(1,logged));
  var max=Math.max(target, Math.max.apply(null, vals), 1);
  /* 主標放「平均 vs 目標」：每天都差一點時「0/7 天達標」看起來很打擊人，
   * 但平均 112 / 目標 128 才是真正該看的距離 */
  var h='<div class="sec"><div class="sec-head"><h2>最近 7 天的蛋白質</h2>'+
        '<span class="n">平均 '+avg+' g／目標 '+target+'</span></div>'+
        '<div class="spark">';
  keys.forEach(function(k,idx){
    var v=vals[idx];
    var pct=Math.max(0, Math.min(1, v/max));
    var cls=v<=0 ? "none" : (v>=target ? "" : "under");
    h+='<div class="col'+(k===curDate?" today":"")+'">'+
        '<div class="bar '+cls+'" style="height:'+(v<=0?3:Math.max(6, pct*72))+'px" title="'+v+' g"></div>'+
        '<div class="lb">'+WD[parseDateKey(k).getDay()]+'</div>'+
       '</div>';
  });
  h+='</div><p class="hint" style="padding:8px 4px 0">有記錄的 '+logged+' 天裡有 '+hit+' 天達標。'+
     '單日會波動，看一週的平均比較準。</p></div>';
  return h;
}

/* ---------- 歷史 ---------- */
function viewHistory(){
  var target=targetOf(db.profile);
  var keys=histDates.slice().sort().reverse().slice(0,HIST_DAYS);
  var h=headHtml("歷史");

  var loaded=keys.filter(function(k){ return db.days[k]; });
  var vals=loaded.map(function(k){ return netOf(db.days[k]); }).filter(function(v){ return v>0; });
  var avg7=avgOf(vals.slice(0,7)), avg30=avgOf(vals.slice(0,30));
  h+='<div class="hist-sum">'+
      '<div><span>7 日平均</span><b class="num">'+(avg7?kcal(avg7):"—")+'</b></div>'+
      '<div><span>30 日平均</span><b class="num">'+(avg30?kcal(avg30):"—")+'</b></div>'+
      '<div><span>每日目標</span><b class="num">'+kcal(target)+'</b></div>'+
     '</div>';

  h+=weightTrendHtml(keys);

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
    /* 只量體重、沒記飲食的日子顯示「—」而不是 0（0 會被誤讀成「今天沒吃」） */
    var v=(d && (d.entries||[]).length) ? netOf(d) : null;
    var pct=v!=null&&target>0 ? Math.max(0,Math.min(1,v/target)) : 0;
    var over=v!=null&&v>target;
    h+='<button class="hrow" data-act="open-day" data-date="'+esc(k)+'">'+
        '<div class="d">'+esc(fmtMD(k))+'<small>'+(d&&num(d.weight)?num(d.weight).toFixed(1)+' kg':'週'+WD[parseDateKey(k).getDay()])+'</small></div>'+
        '<div class="hbar"><i class="'+(over?"over":"")+'" style="width:'+(pct*100).toFixed(0)+'%"></i></div>'+
        '<div class="v num '+(v==null?"none":(over?"over":""))+'">'+(v==null?"—":kcal(v))+'</div>'+
       '</button>';
  });
  h+='</div></div>';
  return h;
}
/* 體重趨勢：只畫有量到的日子，用折線連起來（沒量的日子不補值、不畫假的平滑曲線） */
function weightTrendHtml(keys){
  var pts=keys.slice().sort().map(function(k){
    var d=db.days[k];
    return d && num(d.weight)>0 ? {k:k, w:num(d.weight)} : null;
  }).filter(Boolean);
  if(pts.length<1) return '';
  var first=pts[0], last=pts[pts.length-1];
  var diff=last.w-first.w;
  var W=300, H=56;
  var chart='';
  if(pts.length>=2){
    var min=Math.min.apply(null, pts.map(function(p){return p.w;}));
    var max=Math.max.apply(null, pts.map(function(p){return p.w;}));
    var span=Math.max(0.6, max-min); /* 全部一樣重時不要變成一條貼邊的線 */
    var mid=(max+min)/2;
    var lo=mid-span/2, hi=mid+span/2;
    var coords=pts.map(function(p,i){
      var x=pts.length===1?W/2:(i/(pts.length-1))*(W-8)+4;
      var y=H-4-((p.w-lo)/(hi-lo))*(H-12);
      return x.toFixed(1)+','+y.toFixed(1);
    }).join(' ');
    chart='<svg class="wchart" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+
      '<polyline points="'+coords+'" fill="none" stroke="'+(diff<=0?"var(--acc)":"var(--warn)")+
        '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'+
    '</svg>';
  }
  return '<div class="sec"><div class="wcard">'+
      '<div class="wtop">'+
        '<div><span>目前體重</span><b class="num">'+last.w.toFixed(1)+'<i>kg</i></b></div>'+
        (pts.length>=2
          ? '<div class="wdiff '+(diff<0?"down":(diff>0?"up":""))+'"><span>'+esc(fmtMD(first.k))+' 以來</span>'+
            '<b class="num">'+(diff>0?"+":"")+diff.toFixed(1)+'<i>kg</i></b></div>'
          : '<div><span>紀錄</span><b class="num">1<i>筆</i></b></div>')+
      '</div>'+
      chart+
     '</div></div>';
}

function avgOf(list){
  if(!list.length) return 0;
  var s=0; list.forEach(function(v){ s+=v; });
  return Math.round(s/list.length);
}

/* ---------- 設定 ---------- */
/* 活動係數＝「不含運動」的日常生活強度。
 * 教科書的定義（輕度＝每週運動 1-3 次）把運動算進係數裡，
 * 但本 app 另外有「運動」欄位；照教科書選就會把健身房算兩遍、目標虛高。
 * 所以這裡的說明刻意改成描述「工作型態與走路量」，不提運動次數。 */
var ACTIVITIES=[
  {v:1.2,   label:"久坐", hint:"整天坐著，通勤開車或捷運，一天走不到 5,000 步"},
  {v:1.375, label:"輕度", hint:"以坐著為主，但有走路通勤或做家事，一天約 5,000–8,000 步"},
  {v:1.55,  label:"中度", hint:"工作要常走動（店員、外勤、帶小孩），一天約 8,000–12,000 步"},
  {v:1.725, label:"高度", hint:"體力工作（工地、搬運、餐飲內場），整天都在動"},
  {v:1.9,   label:"極高", hint:"重度體力工作，或一天兩練的運動員"}
];
var GOALS=[
  {v:-500, label:"減脂 快", hint:"約每週 −0.45kg"},
  {v:-300, label:"減脂 緩", hint:"約每週 −0.27kg"},
  {v:0,    label:"維持",    hint:"吃到 TDEE"},
  {v:300,  label:"增肌",    hint:"小幅盈餘"}
];

/* 蛋白質係數的選項與說明（抽出來當常數，別再塞回字串拼接裡） */
var PROTEIN_LEVELS = [
  { v:1.2, label:"1.2 g", hint:"一般維持體重的量" },
  { v:1.6, label:"1.6 g", hint:"減脂期的基本盤，保留肌肉的效果明顯" },
  { v:2.0, label:"2.0 g", hint:"有在重訓、又處在熱量赤字時的常見設定" },
  { v:2.2, label:"2.2 g", hint:"赤字很大或體脂已經很低時才需要" }
];
function proteinHint(v){
  for(var i=0;i<PROTEIN_LEVELS.length;i++){
    if(Math.abs(num(v)-PROTEIN_LEVELS[i].v)<0.01) return PROTEIN_LEVELS[i].hint;
  }
  return "自訂設定";
}

/* 缺口佔 TDEE 的百分比才是該看的指標——跟 BMR 比只是常見的經驗法則。
 * 20% 以內較好維持、也較保得住肌肉；超過 25% 就偏激進。 */
function deficitPct(p){
  var tdee=tdeeOf(p), gap=-round(p.goal);
  if(gap<=0 || tdee<=0) return 0;
  return Math.round(gap/tdee*100);
}
/* 1 公斤脂肪約 7700 大卡。這是理論值，實際會被水分與肝醣蓋過去，要看兩週以上的趨勢。 */
function weeklyLoss(p){
  var gap=-round(p.goal);
  if(gap<=0) return "0";
  return (gap*7/7700).toFixed(2);
}
function deficitAdvice(p){
  var bmr=bmrOf(p), tdee=tdeeOf(p), target=targetOf(p), pct=deficitPct(p);
  if(num(p.goal)>=0) return "";
  if(target<bmr){
    return '<div class="warn-box">'+
      '<b>⚠️ 上限 '+kcal(target)+' 低於基礎代謝 '+kcal(bmr)+'</b>'+
      '<span>「不能吃低於基礎代謝」是常見的經驗法則，不是硬性禁令——真正該看的是'+
      '<b>缺口佔 TDEE 的比例</b>，你目前是 <b>'+pct+'%</b>。<br><br>'+
      '會掉到 BMR 以下，通常是活動量選得太低。「久坐」是給臥床或幾乎不出門的人用的；'+
      '有正常上班走動的話「輕度」才符合實際。<br><br>'+
      '建議二選一：<b>活動量調成符合實際的等級</b>，或把缺口縮到 '+
      kcal(Math.max(0, tdee-bmr))+' 大卡以內。</span></div>';
  }
  if(pct>25){
    return '<div class="warn-box amber">'+
      '<b>缺口偏大：佔 TDEE 的 '+pct+'%</b>'+
      '<span>一般建議控制在 20% 以內，比較能長期維持，也比較保得住肌肉。'+
      '如果兩週後體重掉得比預期快很多、或一直很沒力，把缺口縮小一點。</span></div>';
  }
  return '<p class="hint" style="margin-top:12px">缺口佔 TDEE 的 '+pct+'%，'+
    (pct<=20?'在一般建議的 20% 以內。':'略高於一般建議的 20%。')+
    '每週減重是理論值，實際會被水分與肝醣蓋過去，看兩週以上的趨勢比較準。</p>';
}

/* ---------- 設定 ----------
 * 原本一頁六張大卡、所有控制項全攤開，在手機上要滑很久才找得到東西。
 * 改成索引式：一列一個主題、右邊直接寫目前值，點進去才是完整控制項與說明。
 * 刻意留在索引上的例外是「上限低於 BMR／缺口偏大」的警告——
 * 那是不該要他自己翻進去才看得到的資訊。 */

function activityInfo(p){
  return ACTIVITIES.filter(function(a){ return Math.abs(num(p.activity)-a.v)<0.01; })[0]
         || { label:"自訂 ×"+num(p.activity), hint:"" };
}
function goalInfo(p){
  return GOALS.filter(function(g){ return round(p.goal)===g.v; })[0]
         || { label:(num(p.goal)<0 ? "缺口 "+kcal(-round(p.goal)) : "盈餘 "+kcal(round(p.goal))) };
}
/* 索引上要不要亮警示：red = 上限低於基礎代謝，amber = 缺口佔 TDEE 超過 25% */
function goalWarnLevel(p){
  if(num(p.goal)>=0) return "";
  if(targetOf(p)<bmrOf(p)) return "red";
  if(deficitPct(p)>25) return "amber";
  return "";
}

function setSections(){
  var p=db.profile, mt=macroTargets(p), key=getAiKey();
  var list=[
    { g:"身體與目標", id:"body",     icon:"\u2696\uFE0F", label:"身體資料",
      sum:(p.sex==="female"?"女":"男")+" · "+round(p.age)+" 歲 · "+round(p.height)+" cm · "+num(p.weight).toFixed(1)+" kg" },
    { g:"身體與目標", id:"activity", icon:"\uD83D\uDEB6", label:"活動量與 TDEE",
      sum:activityInfo(p).label+" · TDEE "+kcal(tdeeOf(p))+" 大卡" },
    { g:"身體與目標", id:"goal",     icon:"\uD83C\uDFAF", label:"每日目標",
      sum:goalInfo(p).label+" · "+(num(p.goal)<0?"上限 ":"目標 ")+kcal(targetOf(p))+" 大卡",
      warn:goalWarnLevel(p) },
    { g:"身體與目標", id:"macros",   icon:"\uD83E\uDD57", label:"營養目標",
      sum:"蛋白 "+mt.p+" · 脂肪 "+mt.f+" · 碳水 "+mt.c+" g" },
    { g:"AI 與同步",  id:"ai",       icon:"\uD83E\uDD16", label:"AI 熱量判讀",
      sum:key ? aiModelInfo(p.model).label+" · "+usageText() : "未設定 · 只能手動記" }
  ];
  if(!STORE.local){
    var tok=getToken();
    list.push({ g:"AI 與同步", id:"gh", icon:"\uD83D\uDD11", label:"GitHub 同步",
      sum:tok?"已連線，可記錄":"唯讀 · 貼上金鑰才能記錄", warn:tok?"":"amber" });
  }
  list.push({ g:"其他", id:"users", icon:"\uD83D\uDC65", label:"使用者",
    sum:users.length+" 人 · 資料各自獨立" });
  list.push({ g:"其他", id:"data", icon:"\uD83D\uDDC2\uFE0F", label:"資料與常吃清單",
    sum:"常吃 "+db.foods.length+" 筆" });
  return list;
}

function viewSettings(){
  var p=db.profile;
  var h=headHtml("設定");

  /* 最常來設定頁看的兩個數字放最上面，不用點進去 */
  h+='<div class="set-me">'+
      avatarHtml(me)+
      '<div class="set-me-t"><b>'+esc(me.name)+'</b>'+
        '<span>TDEE '+kcal(tdeeOf(p))+' · 每日'+(num(p.goal)<0?"上限":"目標")+' '+kcal(targetOf(p))+'</span></div>'+
      '<button class="set-me-sw" data-act="switch-user">切換</button>'+
     '</div>';

  var wl=goalWarnLevel(p);
  if(wl){
    h+='<button class="set-alert'+(wl==="amber"?" amber":"")+'" data-act="open-set" data-sec="goal">'+
        '<b>'+(wl==="amber"
          ? "缺口偏大：佔 TDEE 的 "+deficitPct(p)+"%"
          : "每日上限 "+kcal(targetOf(p))+" 低於基礎代謝 "+kcal(bmrOf(p)))+'</b>'+
        '<span>點開看說明與建議 ›</span></button>';
  }

  var secs=setSections(), grp="";
  secs.forEach(function(x){
    if(x.g!==grp){
      if(grp) h+='</div>';
      grp=x.g;
      h+='<h3 class="set-grp">'+esc(grp)+'</h3><div class="set-list">';
    }
    h+='<button class="set-row" data-act="open-set" data-sec="'+x.id+'">'+
        '<i>'+x.icon+'</i>'+
        '<b>'+esc(x.label)+'<span>'+esc(x.sum)+'</span></b>'+
        (x.warn?'<u class="wdot'+(x.warn==="amber"?" amber":"")+'"></u>':'')+
        '<span class="chev">›</span></button>';
  });
  if(grp) h+='</div>';

  h+='<p style="text-align:center;color:#b0b8ac;font-size:12px;padding:16px 16px 30px">減重助手 v3.1</p>';
  return h;
}

/* ---- 設定的分頁 sheet ---- */
var SET_TITLES={ body:"身體資料", activity:"活動量與 TDEE", goal:"每日目標", macros:"營養目標",
                 ai:"AI 熱量判讀", gh:"GitHub 同步", users:"使用者", data:"資料與常吃清單" };

/* 會被數字欄位影響的計算結果單獨包一塊：改數字時只換這一塊，
 * 不整份重畫——重畫會把正在編輯的 input 換掉，手機上鍵盤會跳掉。 */
function setLive(sec){
  var p=db.profile;
  if(sec==="body" || sec==="activity"){
    return '<div class="tdee-box">'+
        '<div class="r"><span>基礎代謝 BMR</span><b class="num">'+kcal(bmrOf(p))+'</b></div>'+
        '<div class="r"><span>每日總消耗 TDEE</span><b class="num">'+kcal(tdeeOf(p))+'</b></div>'+
      '</div>';
  }
  if(sec==="goal"){
    return '<div class="tdee-box">'+
        '<div class="r"><span>每日'+(num(p.goal)<0?"上限":"目標")+'攝取</span><b class="num">'+kcal(targetOf(p))+'</b></div>'+
        (num(p.goal)<0
          ? '<div class="r"><span>缺口佔 TDEE</span><b class="num">'+deficitPct(p)+'%</b></div>'+
            '<div class="r"><span>理論每週減重</span><b class="num">'+weeklyLoss(p)+' kg</b></div>'
          : '')+
      '</div>'+deficitAdvice(p);
  }
  return "";
}

function setBody(sec){
  var p=db.profile;

  if(sec==="body"){
    return '<p class="desc" style="margin-top:0">用 Mifflin-St Jeor 公式算基礎代謝。體重在首頁「量體重」記錄時也會同步更新。</p>'+
      '<div class="field"><label>性別</label><div class="chips">'+
        '<button class="chip '+(p.sex==="male"?"on":"")+'" data-set="sex" data-val="male">男</button>'+
        '<button class="chip '+(p.sex==="female"?"on":"")+'" data-set="sex" data-val="female">女</button>'+
      '</div></div>'+
      '<div class="grid2">'+
        '<div class="field" id="age-field">'+ageFieldHtml(p)+'</div>'+
        '<div class="field"><label>身高 (cm)</label><input type="number" inputmode="decimal" data-num="height" value="'+p.height+'"></div>'+
      '</div>'+
      '<div class="field"><label>生日（選填）</label>'+
        '<input type="date" id="s-birth" data-birth="1" value="'+esc(p.birth)+'" max="'+esc(dateKey())+'">'+
        '<div class="hint" id="birth-hint">'+birthHintText(p)+'</div></div>'+
      '<div class="field"><label>體重 (kg)</label><input type="number" inputmode="decimal" step="0.1" data-num="weight" value="'+p.weight+'"></div>'+
      '<div id="set-live">'+setLive(sec)+'</div>';
  }

  if(sec==="activity"){
    return '<p class="desc" style="margin-top:0">BMR 乘上活動係數就是 TDEE（每日總消耗）。</p>'+
      '<div class="field"><label>活動量</label><div class="chips">'+
        ACTIVITIES.map(function(a){
          return '<button class="chip '+(Math.abs(num(p.activity)-a.v)<0.01?"on":"")+'" data-set="activity" data-val="'+a.v+'">'+
                 a.label+'</button>';
        }).join("")+
      '</div><div class="hint">'+esc(activityInfo(p).hint)+
        '<br><b>這裡只算「不含運動」的日常活動。</b>健身房、跑步那些記在首頁的「運動」就好，'+
        '兩邊都算會重複扣，目標會虛高。</div></div>'+
      '<div id="set-live">'+setLive(sec)+'</div>'+
      '<div class="field"><label>手動覆寫 TDEE（0 = 用上面算的）</label>'+
        '<input type="number" inputmode="numeric" data-num="tdee" value="'+p.tdee+'">'+
        '<div class="hint">有做過體檢代謝測量的話填進來，會蓋掉公式估算值。</div></div>';
  }

  if(sec==="goal"){
    return '<p class="desc" style="margin-top:0">在 TDEE 上加減，決定「今天還可以吃多少」。</p>'+
      '<div class="chips">'+
        GOALS.map(function(g){
          return '<button class="chip '+(round(p.goal)===g.v?"on":"")+'" data-set="goal" data-val="'+g.v+'">'+g.label+'</button>';
        }).join("")+
      '</div>'+
      '<div class="field"><label>自訂調整 (大卡)</label>'+
        '<input type="number" inputmode="numeric" data-num="goal" value="'+p.goal+'">'+
        '<div class="hint">負數 = 減脂缺口，正數 = 增肌盈餘。</div></div>'+
      '<div id="set-live">'+setLive(sec)+'</div>';
  }

  if(sec==="macros"){
    var mt=macroTargets(p);
    return '<p class="desc" style="margin-top:0">減脂期先守蛋白質，再定脂肪，碳水拿剩下的額度。</p>'+
      '<div class="field"><label>蛋白質（每公斤體重）</label><div class="chips">'+
        PROTEIN_LEVELS.map(function(o){
          return '<button class="chip '+(Math.abs(num(p.proteinPerKg)-o.v)<0.01?"on":"")+'" '+
                 'data-set="proteinPerKg" data-val="'+o.v+'">'+o.label+'</button>';
        }).join("")+
      '</div><div class="hint">'+esc(proteinHint(p.proteinPerKg))+
        '<br>目前目標：<b>'+mt.p+' g／天</b>（'+Math.round(num(p.weight))+'kg × '+num(p.proteinPerKg)+'）</div></div>'+
      '<div class="field"><label>脂肪（佔每日熱量）</label><div class="chips">'+
        [20,25,30,35].map(function(v){
          return '<button class="chip '+(Math.abs(num(p.fatPct)-v)<0.01?"on":"")+'" '+
                 'data-set="fatPct" data-val="'+v+'">'+v+'%</button>';
        }).join("")+
      '</div><div class="hint">低於 '+mt.fMin+' g（體重×0.6）長期會影響荷爾蒙，別為了壓熱量把脂肪砍太兇。</div></div>'+
      '<div class="tdee-box">'+
        '<div class="r"><span>蛋白質</span><b class="num">'+mt.p+' g</b></div>'+
        '<div class="r"><span>脂肪</span><b class="num">'+mt.f+' g</b></div>'+
        '<div class="r"><span>碳水（剩下的）</span><b class="num">'+mt.c+' g</b></div>'+
      '</div>';
  }

  if(sec==="ai"){
    var key=getAiKey();
    return '<p class="desc" style="margin-top:0">用你自己的 Anthropic API key，從這台裝置直接呼叫 Claude。'+
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
      (key?'<button class="btn ghost" data-act="clear-key">移除這台裝置的 key</button>':'');
  }

  if(sec==="gh"){
    var tok=getToken();
    return '<p class="desc" style="margin-top:0">手機版直接讀寫 GitHub 上的資料檔。沒有金鑰只能看，不能記錄。'+
        '請用 fine-grained PAT，只授權 lose-weight-helper 這一個 repo，Contents 設為 Read and write。</p>'+
      '<div class="field"><label>Personal access token</label>'+
        '<input type="password" id="gh-key" placeholder="github_pat_..." value="'+esc(tok)+'" autocomplete="off"></div>'+
      '<button class="btn" data-act="save-gh">儲存金鑰</button>'+
      (tok?'<button class="btn ghost" data-act="clear-gh">移除金鑰</button>':'');
  }

  if(sec==="users"){
    return '<p class="desc" style="margin-top:0">每個人的紀錄、TDEE、目標與常吃清單完全獨立，互不干擾。</p>'+
      '<div class="user-list">'+
        users.map(function(u){
          return '<button class="user-row" data-edit-user="'+esc(u.id)+'">'+
            avatarHtml(u,"sm")+
            '<b>'+esc(u.name)+(u.id===me.id?'<span class="tag-me">目前</span>':'')+'</b>'+
            '<span class="chev">›</span></button>';
        }).join("")+
      '</div>'+
      '<button class="btn ghost" data-act="new-user">＋ 新增使用者</button>'+
      '<button class="btn ghost" data-act="switch-user">切換使用者</button>';
  }

  if(sec==="data"){
    return '<p class="desc" style="margin-top:0">紀錄存成 markdown：<br>'+
        '<code style="font-size:12px">data/users/'+esc(me.id)+'/days/YYYY-MM-DD.md</code><br>'+
        esc(me.name)+' 的常吃清單目前 '+db.foods.length+' 筆。單筆要刪，到「記一筆 → 常吃」點右邊的 ✕。</p>'+
      (db.foods.length?'<button class="btn ghost" data-act="clear-foods">清空常吃清單</button>':'');
  }
  return "";
}

/* 生日是選填，但填了就以它為準：年齡改成唯讀顯示，生日過了自己 +1。
 * 沒填生日的人維持原本自己輸入年齡的方式（不強迫交出生日）。
 * 抽成獨立一塊是為了「只換這一小塊」——見 wireSetSheet 裡的 data-birth。 */
function ageFieldHtml(p){
  return '<label>年齡</label>'+(p.birth
    ? '<div class="static-val">'+p.age+' 歲<span>生日到了會自動加</span></div>'
    : '<input type="number" inputmode="numeric" data-num="age" value="'+p.age+'">');
}
function birthHintText(p){
  return p.birth
    ? '年齡由生日推算，生日過了會自動 +1，TDEE 跟著更新。清空就改回自己填年齡。'
    : '填了之後年齡會自動更新，不用每年自己改。';
}

function openSettingsSheet(sec){
  if(!SET_TITLES[sec]) return;
  function draw(isNew){
    var opts={ onDraw:function(root){ wireSetSheet(root, sec, draw); } };
    if(isNew) openSheet(SET_TITLES[sec], setBody(sec), opts);
    else replaceSheet(SET_TITLES[sec], setBody(sec), opts);
  }
  draw(true);
}

function wireSetSheet(root, sec, redraw){
  /* 重畫前先把已經敲進去、還沒 change 的數字收起來，不然會被吃掉 */
  function readNums(){
    root.querySelectorAll("[data-num]").forEach(function(inp){
      if(inp.value!=="") db.profile[inp.getAttribute("data-num")]=Number(inp.value)||0;
    });
    db.profile=cleanProfile(db.profile);
  }
  root.querySelectorAll("[data-set]").forEach(function(b){
    b.onclick=function(){
      readNums();
      var k=b.getAttribute("data-set"), v=b.getAttribute("data-val");
      db.profile[k]=(k==="sex"||k==="model") ? v : Number(v);
      db.profile=cleanProfile(db.profile);
      persistProfile();
      render();          /* 底下的索引摘要跟著更新 */
      redraw(false);     /* chip 的選中狀態要重畫 */
    };
  });
  function wireNums(){
    root.querySelectorAll("[data-num]").forEach(function(inp){
      inp.onchange=function(){
        readNums();
        persistProfile();
        render();
        var live=root.querySelector("#set-live");
        if(live) live.innerHTML=setLive(sec);   /* 只換計算結果，別動到 input */
      };
    });
  }
  wireNums();

  /* 生日：絕對不能在這裡整份重畫。
   * iOS 的原生日期選單只要那個 <input> 被換掉就會立刻關閉——使用者才滾完「年」
   * 就被關掉、而且值已經被套用（踩過）。所以這裡只換衍生出來的三小塊：
   * 年齡欄、生日下面的說明、BMR/TDEE，日期欄本身完全不動，選單就會留著。
   * 落檔也要延後：滾一次年份就 change 一次，手機上每次寫入＝一個 commit。 */
  root.querySelectorAll("[data-birth]").forEach(function(inp){
    var apply=function(){
      readNums();
      db.profile.birth=inp.value;
      db.profile=cleanProfile(db.profile);   /* 這裡會依生日重算 age */
      /* 年齡欄只在「可輸入 <-> 唯讀」真的要換型態時才重建；
       * 其餘情況只改裡面的數字。少動 DOM 一次，就少一次把使用者
       * 正要點的元素抽掉的機會。 */
      var af=root.querySelector("#age-field");
      if(af){
        var wantStatic=!!db.profile.birth, isStatic=!!af.querySelector(".static-val");
        if(wantStatic!==isStatic) af.innerHTML=ageFieldHtml(db.profile);
        else if(wantStatic) af.querySelector(".static-val").innerHTML=
          db.profile.age+' 歲<span>生日到了會自動加</span>';
      }
      var bh=root.querySelector("#birth-hint");
      if(bh) bh.innerHTML=birthHintText(db.profile);
      var live=root.querySelector("#set-live");
      if(live) live.innerHTML=setLive(sec);
      wireNums();                                     /* 年齡欄可能剛被換掉 */
      render();                                        /* 底下索引的摘要跟著更新 */
    };
    inp.onchange=function(){
      apply();
      clearTimeout(birthSaveTimer);
      birthSaveTimer=setTimeout(function(){ persistProfile(); }, 900);
    };
    /* 選完關掉選單（或跳去別的欄位）就立刻落檔，不用等那 0.9 秒。
     * 這裡刻意「只落檔、不重畫」：blur 發生在焦點移到下一個欄位的當下，
     * 這時候動 DOM 會把使用者正要輸入的那個欄位抽掉。畫面在 change 時就已經更新過了。 */
    inp.onblur=function(){
      clearTimeout(birthSaveTimer);
      if(inp.value!==db.profile.birth) apply();   /* 保險：真的還沒同步才補一次 */
      if(inp.value && !db.profile.birth) toast("這個生日不能用（格式不對或還沒到）", true);
      persistProfile();
    };
  });
  root.querySelectorAll("[data-edit-user]").forEach(function(b){
    b.onclick=function(){ var id=b.getAttribute("data-edit-user"); closeAllSheets(); openUserSheet(id); };
  });
  root.querySelectorAll("[data-act]").forEach(function(b){
    b.onclick=function(){
      var act=b.getAttribute("data-act");
      doAct(act, b);
      /* 這幾個動作會改到這頁自己顯示的東西，重畫一次才不會停在舊畫面 */
      if(act==="save-key"||act==="clear-key"||act==="clear-foods") redraw(false);
    };
  });
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

  $app.querySelectorAll("[data-nav2]").forEach(function(b){
    b.onclick=function(){ view=b.getAttribute("data-nav2"); render(); window.scrollTo(0,0); };
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
  if(act==="switch-user"){ closeAllSheets(); picking=true; render(); return; }
  if(act==="open-set"){ openSettingsSheet(el.getAttribute("data-sec")); return; }
  if(act==="manage-users"){
    /* 從選人畫面進管理：先進去目前這位（或第一位）的設定頁 */
    if(!me && users.length) return switchUser(users[0].id, function(){ view="settings"; picking=false; render(); });
    picking=false; view="settings"; render(); return;
  }
  if(act==="new-user"){ closeAllSheets(); openUserSheet(null); return; }
  if(act==="open-keys"){ openKeysSheet(); return; }
  if(act==="prev-day"){ curDate=shiftDate(curDate,-1); ensureDays([curDate]); render(); return; }
  if(act==="next-day"){ if(curDate<dateKey()){ curDate=shiftDate(curDate,1); ensureDays([curDate]); render(); } return; }
  if(act==="go-today"){ curDate=dateKey(); ensureDays([curDate]); render(); return; }
  if(act==="toggle-detail"){ showDetail=!showDetail; render(); return; }
  if(act==="toggle-mnote"){ showMNote=!showMNote; render(); return; }
  if(act==="open-day"){ curDate=el.getAttribute("data-date"); view="today"; ensureDays([curDate]); render(); window.scrollTo(0,0); return; }
  if(act==="add"){ if(requireWrite()) openAddSheet(el.getAttribute("data-meal")); return; }
  if(act==="add-move"){ if(requireWrite()) openMoveSheet(null); return; }
  if(act==="edit-entry"){ if(requireWrite()) openEntrySheet(el.getAttribute("data-id")); return; }
  if(act==="edit-move"){ if(requireWrite()) openMoveSheet(el.getAttribute("data-id")); return; }
  if(act==="edit-notes"){ if(requireWrite()) openNotesSheet(); return; }
  if(act==="edit-weight"){ if(requireWrite()) openWeightSheet(); return; }
  if(act==="setup-profile"){ openSetupSheet(); return; }
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
    /* 直接接著設定身體資料：不設的話首頁的目標是預設值算的，等於假的 */
    switchUser(clean.id, function(){ render(); openSetupSheet(); });
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
    histDates=Object.keys(db.days).filter(function(k){ return dayHasData(db.days[k]); });
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
    /* 兩個 input 是刻意的：capture="environment" 會「強制」開相機，
     * 手機上就看不到相簿；不帶 capture 才會讓系統給選單。
     * 與其靠系統選單，不如直接給兩顆按鈕，使用者一眼就知道有相簿這個選項。 */
    return '<form id="f-photo">'+
      '<div id="photo-slot">'+photoPickHtml()+'</div>'+
      '<input type="file" id="i-cam" accept="image/*" capture="environment" hidden>'+
      '<input type="file" id="i-lib" accept="image/*" hidden>'+
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
      '<div id="fav-list">'+favListHtml("")+'</div>'+
      '<p class="hint" style="padding:2px 4px 0">點項目直接加入今天；右邊的 ✕ 可以把估錯的項目從常吃移除。</p>';
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

function photoPickHtml(){
  return '<div class="photo-pick">'+
      '<i>🍱</i>'+
      '<b>加一張餐點照片</b>'+
      '<span>整桌、便當盒都可以，會自動拆成多筆</span>'+
      '<div class="photo-btns">'+
        '<label class="pbtn" for="i-cam">📷 拍照</label>'+
        '<label class="pbtn" for="i-lib">🖼️ 從相簿選</label>'+
      '</div>'+
    '</div>';
}

function favListHtml(q){
  q=String(q||"").trim().toLowerCase();
  var list=db.foods.filter(function(f){ return !q || f.name.toLowerCase().indexOf(q)>=0; }).slice(0,60);
  if(!list.length) return '<p class="empty">找不到符合的項目</p>';
  /* 刪除鈕跟加入鈕是兩個獨立的 button（不能互相巢狀），外面用 .food-item 包成一列 */
  return list.map(function(f){
    return '<div class="food-item">'+
      '<button class="food-row" data-fav="'+esc(f.id)+'">'+
        '<b>'+esc(f.name)+(f.portion?'<span style="display:block;font-size:11.5px;color:var(--muted);font-weight:600">'+esc(f.portion)+'</span>':'')+'</b>'+
        '<span class="k num">'+kcal(f.kcal)+'</span>'+
        '<span style="color:var(--acc);font-size:20px">＋</span>'+
      '</button>'+
      '<button class="food-del" data-fav-del="'+esc(f.id)+'" aria-label="從常吃移除 '+esc(f.name)+'">✕</button>'+
    '</div>';
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
    var btn=root.querySelector("#b-photo");
    var slot=root.querySelector("#photo-slot");
    var onPick=function(input){
      return function(){
        var file=input.files&&input.files[0];
        /* 同一張照片連選兩次時 change 不會再觸發，所以每次處理完把 value 清掉 */
        input.value="";
        if(!file) return;
        btn.disabled=true;
        btn.textContent="處理照片中…";
        compressImage(file).then(function(dataUrl){
          pendingPhoto=dataUrl;
          slot.innerHTML='<img class="photo-prev" src="'+dataUrl+'" alt="餐點照片">'+
            '<div class="photo-btns after">'+
              '<label class="pbtn" for="i-cam">📷 重拍</label>'+
              '<label class="pbtn" for="i-lib">🖼️ 換一張</label>'+
            '</div>';
          btn.disabled=false;
          btn.textContent="交給 AI 估算";
        }).catch(function(e){
          toast(e.userMessage||"照片處理失敗", true);
          btn.disabled=!pendingPhoto;
          btn.textContent="交給 AI 估算";
        });
      };
    };
    ["#i-cam","#i-lib"].forEach(function(sel){
      var el=root.querySelector(sel);
      if(el) el.onchange=onPick(el);
    });
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
  /* AI 偶爾會把配料拆成「甜椒配料 3 大卡」這種沒用的項目，之前只能整份清空 */
  root.querySelectorAll("[data-fav-del]").forEach(function(b){
    b.onclick=function(){
      if(!requireWrite()) return;
      var id=b.getAttribute("data-fav-del");
      var f=db.foods.filter(function(x){ return x.id===id; })[0];
      if(!f) return;
      if(!confirm("把「"+f.name+"」從常吃清單移除？（已經記進去的飲食不受影響）")) return;
      db.foods=db.foods.filter(function(x){ return x.id!==id; });
      persistFoods();
      toast("已移除「"+f.name+"」");
      var qEl=root.querySelector("#i-fav-q"), listEl=root.querySelector("#fav-list");
      if(db.foods.length && listEl){ listEl.innerHTML=favListHtml(qEl?qEl.value:""); wireFav(root); }
      else drawAddSheet(false);   /* 全刪光了 -> 換成空狀態說明 */
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
  persistFoods();      /* 整批只寫一次（rememberFood 不自己寫檔） */
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
/* 快速選擇＝你做過的運動（從已載入的日子撈）＋內建幾個常見的。
 * 不另外開一個檔案存：這些資料本來就在 days 裡，撈出來就好。 */
function moveChoices(){
  var seen={}, out=[];
  Object.keys(db.days).sort().reverse().forEach(function(k){
    (db.days[k].moves||[]).forEach(function(m){
      var name=String(m.name||"").trim();
      if(!name || seen[name]) return;
      seen[name]=true;
      out.push({ name:name, kcal:num(m.kcal), mine:true });
    });
  });
  MOVE_PRESETS.forEach(function(p){
    if(seen[p.name]) return;
    seen[p.name]=true;
    out.push({ name:p.name, kcal:p.kcal, mine:false });
  });
  return out.slice(0,12);
}

function openMoveSheet(id){
  var d=dayOf(curDate);
  var mv=id ? d.moves.filter(function(x){ return x.id===id; })[0] : null;
  var choices=moveChoices();
  var body='<form id="f-move">'+
    (mv?'':'<div class="field" style="margin-top:0"><label>做過的／常見的</label><div class="chips">'+
      choices.map(function(p,i){
        return '<button type="button" class="chip'+(p.mine?" mine":"")+'" data-mp="'+i+'">'+esc(p.name)+'</button>';
      }).join("")+'</div></div>')+
    '<div class="field"><label>項目</label>'+
      '<input type="text" id="mv-name" value="'+esc(mv?mv.name:"")+'" placeholder="例如：飛輪 45 分、爬象山來回" autocomplete="off" required></div>'+
    (hasAiKey()
      ? '<button class="btn ghost ai-move" type="button" data-ai-move="1">🤖 讓 AI 估消耗</button>'+
        '<div class="hint" style="margin-top:6px">清單裡沒有的運動，打上去讓 AI 算。會依你的體重估，'+
        '而且是<b>淨消耗</b>（扣掉那段時間本來就會燒的基礎代謝）。</div>'
      : '')+
    '<div id="mv-detail"></div>'+
    '<div class="field"><label>消耗熱量 (大卡)</label>'+
      '<input type="number" inputmode="numeric" id="mv-kcal" value="'+(mv?mv.kcal:"")+'" placeholder="0" required>'+
      '<div class="hint">只記「額外」運動。日常走路已經算在活動係數裡了，重複記會高估。</div></div>'+
    '<button class="btn" type="submit">'+(mv?"儲存":"加入")+'</button>'+
    (mv?'<button class="btn danger" type="button" data-del="1">刪除這筆</button>':'')+
  '</form>';

  openSheet(mv?"編輯運動":"記一筆運動", body, { onDraw:function(root){
    root.querySelectorAll("[data-mp]").forEach(function(b){
      b.onclick=function(){
        var p=choices[+b.getAttribute("data-mp")];
        root.querySelector("#mv-name").value=p.name;
        root.querySelector("#mv-kcal").value=p.kcal;
        root.querySelector("#mv-detail").innerHTML="";
      };
    });

    var aiBtn=root.querySelector("[data-ai-move]");
    if(aiBtn) aiBtn.onclick=function(){
      var nameEl=root.querySelector("#mv-name");
      var txt=(nameEl.value||"").trim();
      if(!txt){ toast("先打上做了什麼運動", true); nameEl.focus(); return; }
      aiBtn.disabled=true;
      aiBtn.textContent="AI 估算中…";
      aiAnalyzeMove(db.profile.model, txt, db.profile).then(function(r){
        nameEl.value=r.name;
        root.querySelector("#mv-kcal").value=r.kcal;
        var cf = r.confidence==="high" ? "" :
          '<span class="conf '+r.confidence+'">'+(r.confidence==="low"?"不太確定":"約略")+'</span>';
        root.querySelector("#mv-detail").innerHTML=
          '<div class="ai-note" style="margin:10px 0 0">💡 '+esc(r.detail)+cf+
          '<br><span style="opacity:.8;font-size:11.5px">數字可以直接改，改完再按加入。</span></div>';
        aiBtn.disabled=false;
        aiBtn.textContent="🤖 重新估一次";
      }).catch(function(e){
        toast(e.userMessage||"AI 估算失敗", true);
        aiBtn.disabled=false;
        aiBtn.textContent="🤖 讓 AI 估消耗";
      });
    };
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

/* ============ 金鑰設定（不依賴 me，選人畫面也叫得動） ============ */
function openKeysSheet(){
  var body='';
  if(!STORE.local){
    body+='<div class="field" style="margin-top:0"><label>GitHub 金鑰（記錄用，必填）</label>'+
      '<input type="password" id="k-gh" placeholder="github_pat_..." value="'+esc(getToken())+'" autocomplete="off">'+
      '<div class="hint">GitHub → Settings → Developer settings → Fine-grained tokens，'+
      '只授權 lose-weight-helper 這一個 repo，Contents 設為 <b>Read and write</b>。<br>'+
      '沒有這把金鑰只能看，不能記錄。</div></div>';
  }
  body+='<div class="field"><label>Anthropic API key（AI 判讀用，選填）</label>'+
    '<input type="password" id="k-ai" placeholder="sk-ant-..." value="'+esc(getAiKey())+'" autocomplete="off">'+
    '<div class="hint">到 console.anthropic.com → API keys 申請，記得在 Billing 設每月上限。<br>'+
    '不填也能用，只是沒有 AI 判讀（手動輸入與常吃清單照常）。</div></div>'+
    '<p class="desc" style="margin:14px 0 0">兩把金鑰都只存在這支手機的瀏覽器裡，'+
    '不會上傳、也不會進 GitHub。換手機要重貼。</p>'+
    '<button class="btn" data-keys="save">儲存</button>';

  openSheet("金鑰設定", body, { onDraw:function(root){
    root.querySelector('[data-keys="save"]').onclick=function(){
      var ai=(root.querySelector("#k-ai")||{}).value||"";
      ai=ai.trim();
      if(ai) setAiKey(ai); else clearAiKey();

      var ghEl=root.querySelector("#k-gh");
      if(ghEl){
        var gh=(ghEl.value||"").trim();
        var changed = gh!==getToken();
        if(gh) setToken(gh); else clearToken();
        if(changed){
          /* 換了 GitHub 金鑰＝整個資料層的讀寫權限變了，重載最乾淨 */
          toast("金鑰已儲存，重新載入…");
          setTimeout(function(){ location.reload(); }, 700);
          return;
        }
      }
      closeSheet(); render(); toast("已儲存");
    };
  }});
}

/* ============ 體重 ============ */
function openWeightSheet(){
  var d=dayOf(curDate);
  var cur=num(d.weight);
  var isToday=curDate===dateKey();
  var body='<form id="f-weigh">'+
    '<div class="field" style="margin-top:0"><label>'+esc(fmtLong(curDate))+' 的體重 (kg)</label>'+
      '<input type="number" inputmode="decimal" step="0.1" id="w-val" value="'+(cur?cur:"")+'" '+
        'placeholder="'+(prevWeight()||db.profile.weight||70)+'" autofocus>'+
      '<div class="hint">早上起床、上完廁所、空腹量最準。同一個時間點量才有可比性。</div></div>'+
    (isToday?'<div class="tdee-box" style="margin-top:12px"><div class="r">'+
      '<span style="font-weight:600">存檔時會一併更新身體資料的體重</span></div>'+
      '<div class="r"><span style="font-size:11.5px;font-weight:600;opacity:.85">'+
      'TDEE 是用體重算的，不同步更新目標就會越來越不準</span></div></div>':'')+
    '<button class="btn" type="submit">儲存</button>'+
    (cur?'<button class="btn danger" type="button" data-del="1">清除這天的體重</button>':'')+
  '</form>';

  openSheet("體重", body, { onDraw:function(root){
    var del=root.querySelector("[data-del]");
    if(del) del.onclick=function(){
      d.weight=0;
      persistDay(curDate);
      closeSheet(); render(); toast("已清除");
    };
    root.querySelector("#f-weigh").onsubmit=function(ev){
      ev.preventDefault();
      var v=Number(root.querySelector("#w-val").value)||0;
      if(v<0 || v>400){ toast("這個體重看起來怪怪的", true); return; }
      d.weight=v;
      persistDay(curDate);
      /* 今天的體重同步進 profile：TDEE 是用體重算的，不同步會越來越不準 */
      if(isToday && v>0){
        db.profile.weight=v;
        db.profile=cleanProfile(db.profile);
        persistProfile();
      }
      closeSheet(); render(); toast(v?"已記錄 "+v.toFixed(1)+" kg":"已清除");
    };
  }});
}

/* ============ 首次身體資料設定（建完使用者馬上跳出來） ============ */
function openSetupSheet(){
  var p=Object.assign({}, db.profile);
  function body(){
    var bmr=bmrOf(p), tdee=tdeeOf(p), target=targetOf(p);
    return '<form id="f-setup">'+
      '<p class="desc" style="margin:0 0 4px">TDEE 要用這些算，填完才知道「今天還能吃多少」。之後在設定裡隨時可改。</p>'+
      '<div class="field"><label>性別</label><div class="chips">'+
        '<button type="button" class="chip '+(p.sex==="male"?"on":"")+'" data-s="sex" data-v="male">男</button>'+
        '<button type="button" class="chip '+(p.sex==="female"?"on":"")+'" data-s="sex" data-v="female">女</button>'+
      '</div></div>'+
      '<div class="grid2">'+
        '<div class="field"><label>年齡</label><input type="number" inputmode="numeric" id="s-age" value="'+p.age+'"></div>'+
        '<div class="field"><label>身高 (cm)</label><input type="number" inputmode="decimal" id="s-height" value="'+p.height+'"></div>'+
      '</div>'+
      '<div class="field"><label>體重 (kg)</label><input type="number" inputmode="decimal" step="0.1" id="s-weight" value="'+p.weight+'"></div>'+
      '<div class="field"><label>活動量</label><div class="chips">'+
        ACTIVITIES.map(function(a){
          return '<button type="button" class="chip '+(Math.abs(p.activity-a.v)<0.01?"on":"")+'" data-s="activity" data-v="'+a.v+'">'+a.label+'</button>';
        }).join("")+'</div>'+
        '<div class="hint">'+esc((ACTIVITIES.filter(function(a){return Math.abs(p.activity-a.v)<0.01;})[0]||{}).hint||"")+
          '<br><b>只算不含運動的日常活動</b>，運動另外記，不然會重複扣。</div></div>'+
      '<div class="field"><label>目標</label><div class="chips">'+
        GOALS.map(function(g){
          return '<button type="button" class="chip '+(p.goal===g.v?"on":"")+'" data-s="goal" data-v="'+g.v+'">'+g.label+'</button>';
        }).join("")+'</div></div>'+
      '<div class="tdee-box">'+
        '<div class="r"><span>基礎代謝 BMR</span><b class="num">'+kcal(bmr)+'</b></div>'+
        '<div class="r"><span>每日總消耗 TDEE</span><b class="num">'+kcal(tdee)+'</b></div>'+
        '<div class="r"><span>每日目標攝取</span><b class="num">'+kcal(target)+'</b></div>'+
      '</div>'+
      '<button class="btn" type="submit">完成設定</button>'+
    '</form>';
  }
  function readInputs(root){
    p.age=Number((root.querySelector("#s-age")||{}).value)||p.age;
    p.height=Number((root.querySelector("#s-height")||{}).value)||p.height;
    p.weight=Number((root.querySelector("#s-weight")||{}).value)||p.weight;
  }
  function draw(isNew){
    var opts={ onDraw:function(root){
      /* 改 chip 之前先把已輸入的數字收起來，重畫才不會被吃掉 */
      root.querySelectorAll("[data-s]").forEach(function(b){
        b.onclick=function(){
          readInputs(root);
          var k=b.getAttribute("data-s"), v=b.getAttribute("data-v");
          p[k]=(k==="sex")?v:Number(v);
          draw(false);
        };
      });
      /* 數字改完即時更新下面的 TDEE 預覽 */
      ["#s-age","#s-height","#s-weight"].forEach(function(sel){
        var el=root.querySelector(sel);
        if(el) el.onchange=function(){ readInputs(root); draw(false); };
      });
      root.querySelector("#f-setup").onsubmit=function(ev){
        ev.preventDefault();
        readInputs(root);
        db.profile=cleanProfile(p);
        persistProfile();
        closeSheet(); render(); toast("設定完成，目標是 "+kcal(targetOf(db.profile))+" 大卡");
      };
    }};
    if(isNew) openSheet(esc(me.name)+" 的身體資料", body(), opts);
    else replaceSheet(esc(me.name)+" 的身體資料", body(), opts);
  }
  draw(true);
}

/* ============ 載入 ============ */
function ensureDays(keys){
  if(!me) return Promise.resolve();
  var u=me.id;
  var need=keys.filter(function(k){ return !db.days[k]; });
  if(!need.length) return Promise.resolve();
  var holds={};
  need.forEach(function(k){ holds[k]=db.days[k]=emptyDay(k); }); /* 先放空的，避免重複請求 */
  return STORE.loadDays(u, need).then(function(days){
    if(!me || me.id!==u) return; /* 載入途中切了人：丟棄 */
    days.forEach(function(d){ db.days[d.date]=d; });
    if(booted && !picking) render();
  }).catch(function(e){
    /* 讀失敗一定要把空殼收回來：留著的話 db.days[k] 已經有值，
     * ensureDays 永遠不會再重試那一天，而那個空白的一天只要被存回去，
     * 就會把伺服器上真正的紀錄蓋掉。只收回「還是原本那個空殼」的，
     * 使用者在載入途中記的東西不能弄丟。 */
    if(me && me.id===u){
      need.forEach(function(k){
        if(db.days[k]===holds[k] && !dayHasData(db.days[k])) delete db.days[k];
      });
    }
    toast(e.userMessage||"讀取紀錄失敗", true);
    if(booted && !picking) render();
  });
}

function ensureHistory(){
  if(histLoaded || !me) return;
  var u=me.id;
  STORE.loadIndex(u).then(function(dates){
    if(!me || me.id!==u) return;
    histDates=dates;
    histLoaded=true;
    /* 內容補進來，歷史頁才畫得出長條（窗口跟 viewHistory 綁同一個常數） */
    return ensureDays(dates.slice(-HIST_DAYS));
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
