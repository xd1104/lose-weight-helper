"use strict";

/* 版本號。改前端時跟 sw.js 的 cache 版本號一起 +1。 */
var APP_VER="5.6";
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
/* ============ 鍵盤不要蓋住正在打的東西 ============
 * iOS 的鍵盤「不會」把版面推上去——layout viewport 不變，只有 visual viewport 變小。
 * 所以 position:fixed 的 sheet 仍然是整個螢幕高，下半部就躲在鍵盤底下，
 * 使用者看不到自己打了什麼（Benson：加了照片之後補充說明被擠到下面，打字看不見）。
 * 兩件事一起做才有用：
 *   (1) 用 visualViewport 把 sheet 那一層縮成「看得見的那一塊」，版面才會重排；
 *   (2) 欄位取得焦點時把它捲到中間（鍵盤有動畫，要等一下再捲）。 */
function fitViewport(){
  var vv=window.visualViewport;
  if(!vv) return;
  var st=document.documentElement.style;
  st.setProperty("--vvh", vv.height+"px");
  st.setProperty("--vvtop", vv.offsetTop+"px");
}
if(window.visualViewport){
  window.visualViewport.addEventListener("resize", fitViewport);
  window.visualViewport.addEventListener("scroll", fitViewport);
  fitViewport();
}
document.addEventListener("focusin", function(ev){
  var el=ev.target;
  if(!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName||"")) return;
  if(el.type==="file") return;
  setTimeout(function(){
    try{ el.scrollIntoView({ block:"center", behavior:"smooth" }); }catch(e){}
  }, 320);
});

/* 會自己長高的文字框。
 * 單行的 <input> 一旦打超過一行，前面打的就被推出視窗外看不到了（Benson 反映）。
 * 凡是「會寫成一句話」的欄位都改用這個：textarea + 依內容長高，一眼看得到全部。
 * enter="submit" 的欄位（名稱、份量那類）維持「Enter 直接送出」，
 * 跟原本 <input> 的行為一樣——那些欄位本來就不該有換行。 */
function taHtml(id, value, ph, opts){
  opts=opts||{};
  return '<textarea class="ta" id="'+id+'" rows="1" placeholder="'+esc(ph||"")+'"'+
    (opts.enter==="submit" ? ' data-enter="submit"' : '')+
    (opts.required ? ' required' : '')+
    (opts.attrs || '')+'>'+esc(value||"")+'</textarea>';
}
function fitTa(el){
  el.style.height="auto";
  el.style.height=(el.scrollHeight+2)+"px";
}
function wireTa(root){
  (root||document).querySelectorAll("textarea.ta").forEach(function(el){
    fitTa(el);
    el.oninput=function(){ fitTa(el); };
    if(el.getAttribute("data-enter")==="submit"){
      el.onkeydown=function(ev){
        if(ev.key!=="Enter" || ev.shiftKey) return;
        ev.preventDefault();
        /* 名稱類欄位貼到換行時一併清掉，不然會被存進資料裡 */
        el.value=el.value.replace(/[\r\n]+/g," ").trim();
        var f=el.closest("form");
        if(f){ if(f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event("submit",{cancelable:true})); }
      };
    }
  });
}

/* 體重的顯示：59.4 就寫 59.4，59.45 要看得到，59 寫成 59.0（體重習慣帶一位小數）。
 * 有些體重計是 0.05 kg 一格，硬是砍到一位小數會跟他看到的數字對不起來。 */
function kgTxt(v){
  var n=Math.round(num(v)*100)/100;
  return (Math.abs(n*10-Math.round(n*10))<0.001) ? n.toFixed(1) : n.toFixed(2);
}
/* 營養素的顯示：2.5 要看得到，25 不要變成 25.0 */
function gram(n){
  var v=Math.round(num(n)*10)/10;
  return (Math.abs(v-Math.round(v))<0.05 ? String(Math.round(v)) : v.toFixed(1));
}

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
/* 釘選的排最上面，其餘按吃過的次數 */
function sortFoods(a,b){
  return ((b.star?1:0)-(a.star?1:0)) ||
         (num(b.n)-num(a.n)) ||
         String(a.name).localeCompare(String(b.name),"zh-Hant");
}

/* 食物名稱的比對用 key。
 * AI 每次寫的名字會有小差異（「白飯」／「白飯（便當盒）」／「白飯 1.5 碗」），
 * 用原字串比對就會在常吃清單裡長出一堆近似重複，而且「上次記多少」永遠對不上。
 * 括號註解與標點空白一律拿掉；刻意「不」做同義詞對應（珍奶≠珍珠奶茶），
 * 猜太多會把不同的東西合在一起，那比多一筆更糟。 */
function foodKey(name){
  return String(name||"").trim().toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/[\s·・、,，.。!！?？~～\-—_]/g, "");
}
/* 找出常吃清單裡對應的那一筆（先原字串、再正規化）。找不到回 null。 */
function findFood(name){
  var raw=String(name||"").trim();
  if(!raw) return null;
  var i;
  for(i=0;i<db.foods.length;i++) if(db.foods[i].name===raw) return db.foods[i];
  var k=foodKey(raw);
  if(!k) return null;
  for(i=0;i<db.foods.length;i++) if(foodKey(db.foods[i].name)===k) return db.foods[i];
  return null;
}

function rememberFood(item){
  var key=String(item.name||"").trim();
  if(!key) return;
  var hit=findFood(key);
  if(hit){
    hit.n=(num(hit.n)||1)+1;
    /* 加了星的是「他自己認定的固定值」（可能還手動改過數字），AI 不准蓋掉——
     * 不然每吃一次就被新的估算覆寫，常吃清單永遠不會變成穩定的常數。
     * 沒加星的只是「最近吃過」的快照，照舊更新。 */
    if(!hit.star){
      hit.kcal=round(item.kcal); hit.p=round1(item.p); hit.c=round1(item.c); hit.f=round1(item.f);
      if(item.portion) hit.portion=item.portion;
    }
  }else{
    db.foods.push({ id:uid(), name:key, kcal:round(item.kcal), p:round1(item.p), c:round1(item.c),
                    f:round1(item.f), portion:item.portion||"", n:1 });
  }
  db.foods.sort(sortFoods);
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
          '<span>不會胖，只是今天的缺口比計畫小</span></div>';
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
      paceHtml(net, tdee, eaten, lateEnough)+
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
    /* 一鍋火鍋 AI 會拆成十幾樣，整個午餐就變成一整頁。
     * 平常要看的是「這一餐吃了多少」——那個數字在標題右邊已經有了。
     * 所以超過門檻就先收起來，需要細節再展開。摺疊狀態只在記憶體，不落檔。 */
    var open = mealOpen[mk] || list.length<=MEAL_FOLD;
    var show = open ? list : list.slice(0, MEAL_FOLD-1);
    h+='<section class="sec">'+
        '<div class="sec-head"><h2>'+info.emoji+' '+info.label+'</h2>'+
          '<span class="n">'+kcal(sumKcal(list))+' 大卡</span></div>'+
        '<div class="list">';
    show.forEach(function(e){
      h+='<button class="row" data-act="edit-entry" data-id="'+esc(e.id)+'">'+
          '<div class="row-mid"><b>'+esc(e.name)+'</b>'+
            (e.portion ? '<span>'+esc(e.portion)+'</span>' : '')+
          '</div>'+
          '<div class="row-kcal num">'+kcal(e.kcal)+'<i>大卡</i></div>'+
         '</button>';
    });
    if(list.length>MEAL_FOLD){
      var restN=list.length-show.length;
      h+='<button class="row fold" data-act="fold-meal" data-meal="'+mk+'">'+
          '<div class="row-mid"><b>'+(open
            ? "收合這一餐"
            : "還有 "+restN+" 項（共 "+kcal(sumKcal(list.slice(show.length)))+" 大卡）")+'</b></div>'+
          '<div class="row-kcal"><i>'+(open?"⌃":"⌄")+'</i></div>'+
         '</button>';
    }
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

  /* 營養師講評：手動按才打 AI（每按一次都要錢），有記東西才給按。
   * 已經評過的日子直接顯示總評，點進去看存下來的那份，不會再收一次費。 */
  if((d.entries||[]).length){
    var co=d.coach;
    h+='<section class="sec"><button class="coach-btn'+(co?" done":"")+'" data-act="coach">'+
        '<span class="ico">🥗</span>'+
        '<b>'+(co?"營養師講評":"今天吃得怎樣？")+
          '<span>'+esc(co ? co.verdict : (isToday?"讓 AI 幫你看一下三餐，給具體建議":"讓 AI 看看這天吃得如何"))+'</span></b>'+
        '<span class="chev">›</span></button></section>';
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
  var isToday=curDate===dateKey();
  var todo=false;
  var sub;
  if(!w){
    todo=isToday;
    sub='<span>'+esc(weighHint(isToday))+'</span>';
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
  return '<section class="sec"><button class="weigh'+(todo?" todo":"")+'" data-act="edit-weight">'+
      '<span class="weigh-ico">⚖️</span>'+
      '<div class="weigh-mid">'+
        (w?'<b class="num">'+kgTxt(w)+'<i>kg</i></b>':'<b class="none">記錄今天的體重</b>')+
        sub+
      '</div>'+
      '<span class="chev">›</span>'+
     '</button></section>';
}
/* 今天還沒量時要說的話。
 * 體重是 app 裡唯一能驗證「熱量估得準不準」的資料，但也是最容易忘記的一件事。
 * 快湊滿校準門檻時直接把「還差幾次」講出來——比「早上量最準」有動力得多。
 * 只在歷史載入過之後才敢講次數，不然手上只有 7 天資料會算出一個嚇人的數字。 */
function weighHint(isToday){
  if(!isToday) return "這天沒量";
  if(histLoaded){
    var c=calibrate();
    if(!c.ok && c.needPts>0 && c.needPts<=3)
      return "今天還沒量 · 再量 "+c.needPts+" 次就能校準你的 TDEE";
  }
  return "今天還沒量 · 早上起床空腹量最準";
}

/* 三大營養素：一格一個，直接寫「目前／目標」。
 * 曾經換成「熱量來自哪裡」的三色比例條，但那回答的是另一個問題——
 * 每天想知道的是「夠不夠、超了沒」，不是「熱量的組成」。（Benson 反映看不懂，改回來）
 * 原本的方塊唯一的問題是 bar 卡在 100%、超標看不出來，所以補上超標狀態。 */
/* 今天實際做出多少缺口 -> 一週大概幾公斤。
 * 刻意等到晚上 8 點（或看過去的日子）才顯示：中午只吃了 300 大卡時
 * 算出來會是「一週 −1.6 kg」，那是假的，只會誤導。 */
function paceHtml(net, tdee, eaten, lateEnough){
  if(!lateEnough || !(tdee>0) || !(eaten>0)) return "";
  var gap=tdee-net;
  return '<div class="pace'+(gap>0?"":" over")+'">'+
      '<b>'+(gap>0
        ? "今天比 TDEE 少 "+kcal(gap)+" 大卡"
        : "今天比 TDEE 多 "+kcal(-gap)+" 大卡")+'</b>'+
      '<span>維持這個步調，一週約 '+weekPace(gap)+'</span>'+
    '</div>';
}

/* ISO 時間戳 -> 「7/27 21:30」 */
function fmtStamp(iso){
  var d=new Date(iso);
  if(isNaN(d.getTime())) return "";
  return (d.getMonth()+1)+"/"+d.getDate()+" "+
    String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}

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
         '<b class="num">'+gram(v)+'<i>/'+kcal(target)+'g</i></b>'+
         '<div class="mbar"><i style="width:'+(Math.min(1,pct)*100).toFixed(0)+'%;'+
           'background:'+(over?"var(--warn)":color)+'"></i></div></div>';
}

/* 七天長條圖。
 * ⚠️ 一定要畫目標線：高度是相對於「這七天的最大值」，沒有基準線的話，
 * 不管吃多少，最高那天都貼頂——七根滿格配上「0 天達標」的文字，圖等於在騙人。
 * 線的位置要跟 bar 用同一組數字算（BAR_H／底部 padding），改一個就要改另一個。 */
var BAR_H=72;      /* bar 的最大高度，跟 .spark 的高度綁在一起 */
var BAR_BOT=25;    /* bar 底部到 .spark 底部的距離（padding + 星期標籤） */
function goalLineHtml(target, max, label){
  if(!(target>0) || !(max>0)) return "";
  var pct=Math.min(1, target/max);
  return '<i class="goal-line" style="bottom:'+(BAR_BOT+pct*BAR_H).toFixed(1)+'px">'+
         '<b>'+esc(label)+'</b></i>';
}
function sparkHtml(target){
  var keys=[], i;
  for(i=6;i>=0;i--) keys.push(shiftDate(curDate,-i));
  var vals=keys.map(function(k){ var d=db.days[k]; return d?netOf(d):0; });
  var max=Math.max(target, Math.max.apply(null, vals), 1);
  var h='<div class="spark">'+goalLineHtml(target, max, "上限 "+kcal(target));
  keys.forEach(function(k,idx){
    var v=vals[idx];
    var pct=Math.max(0, Math.min(1, v/max));
    var cls=v<=0 ? "none" : (v>target ? "over" : "");
    h+='<div class="col'+(k===curDate?" today":"")+'">'+
        '<div class="bar '+cls+'" style="height:'+(v<=0?3:Math.max(6, pct*BAR_H))+'px" title="'+kcal(v)+' 大卡"></div>'+
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
        '<span class="mrow-num num">'+gram(o.v)+'<i>/'+target+' g</i></span>'+
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
        '<div class="spark">'+goalLineHtml(target, max, "目標 "+target+" g");
  keys.forEach(function(k,idx){
    var v=vals[idx];
    var pct=Math.max(0, Math.min(1, v/max));
    var cls=v<=0 ? "none" : (v>=target ? "" : "under");
    h+='<div class="col'+(k===curDate?" today":"")+'">'+
        '<div class="bar '+cls+'" style="height:'+(v<=0?3:Math.max(6, pct*BAR_H))+'px" title="'+v+' g"></div>'+
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

  /* 這一段是「實際的進度」：拿真的吃了多少去比 TDEE，不是設定裡那個理論值。
   * 一週平均沒有「今天才過一半」的問題，所以這裡不用等到晚上。 */
  var tdeeH=tdeeOf(db.profile);
  if(avg7>0 && tdeeH>0){
    var gap7=tdeeH-avg7;
    h+='<div class="pace big'+(gap7>0?"":" over")+'">'+
        '<b>'+(gap7>0
          ? "最近 7 天平均每天比 TDEE 少 "+kcal(gap7)+" 大卡"
          : "最近 7 天平均每天比 TDEE 多 "+kcal(-gap7)+" 大卡")+'</b>'+
        '<span>照這個步調，一週約 '+weekPace(gap7)+
          '（理論值，實際會被水分與肝醣蓋過去，看兩週以上的體重趨勢比較準）</span>'+
       '</div>';
  }

  h+=weightTrendHtml(keys);

  if(!histLoaded){
    h+='<div class="card"><div class="spin"><div class="dots"><i></i><i></i><i></i></div>讀取紀錄中…</div></div>';
    return h;
  }
  if(!keys.length){
    h+='<div class="card"><p class="desc" style="margin:0">還沒有任何紀錄。回「今天」記第一筆吧。</p></div>';
    return h;
  }

  h+=calibHtml();

  h+='<div class="sec"><div class="list">';
  keys.forEach(function(k){
    var d=db.days[k];
    /* 只量體重、沒記飲食的日子顯示「—」而不是 0（0 會被誤讀成「今天沒吃」） */
    var v=(d && (d.entries||[]).length) ? netOf(d) : null;
    var pct=v!=null&&target>0 ? Math.max(0,Math.min(1,v/target)) : 0;
    /* 跟首頁圓環同一套三段：超過上限但沒超過 TDEE ＝ 黃（那天沒瘦，但也沒胖），
     * 超過 TDEE 才是紅。全部畫成紅色的話，會跟上面「你一週在瘦 0.18 kg」打架。 */
    var over=v!=null&&v>target;
    var cls=over ? ((tdeeH>0 && v<=tdeeH) ? "mid" : "over") : "";
    h+='<button class="hrow" data-act="open-day" data-date="'+esc(k)+'">'+
        '<div class="d">'+esc(fmtMD(k))+(d&&d.coach?'<i class="has-coach" title="有營養師講評">🥗</i>':'')+
          '<small>'+(d&&num(d.weight)?kgTxt(d.weight)+' kg':'週'+WD[parseDateKey(k).getDay()])+'</small></div>'+
        '<div class="hbar"><i class="'+cls+'" style="width:'+(pct*100).toFixed(0)+'%"></i></div>'+
        '<div class="v num '+(v==null?"none":cls)+'">'+(v==null?"—":kcal(v))+'</div>'+
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
        '<div><span>目前體重</span><b class="num">'+kgTxt(last.w)+'<i>kg</i></b></div>'+
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

/* ============ TDEE 校準 ============
 * Mifflin-St Jeor × 活動係數算的是「族群平均」，套到個人身上誤差常有 ±200 大卡，
 * 而 app 裡每一個數字（每日上限、一週幾公斤）都建在這個 TDEE 上。
 * 體重不會說謊：把「這段期間平均吃了多少」跟「體重實際掉了多少」放在一起，
 * 就能反推出真正的消耗：
 *     真實 TDEE = 平均淨攝取 + 每天實際掉的體重 × 7700
 * 兩個門檻都是必要的：十天以內的體重變化會被水分跟肝醣蓋過去；
 * 漏記的日子會把平均攝取拉低，把 TDEE 算得比實際小。 */
var CALIB_WINDOW   = 28;   /* 往回看幾天 */
var CALIB_MIN_PTS  = 6;    /* 至少幾筆體重 */
var CALIB_MIN_SPAN = 13;   /* 頭尾至少隔幾天（13 ＝跨滿兩週） */
var CALIB_MIN_LOG  = 10;   /* 頭尾之間至少幾天有記飲食 */

function calibrate(){
  var start=shiftDate(dateKey(), -(CALIB_WINDOW-1));
  var pts=[], i, k, d;
  for(i=0;i<CALIB_WINDOW;i++){
    k=shiftDate(start,i);
    d=db.days[k];
    if(d && num(d.weight)>0) pts.push({ k:k, x:i, w:num(d.weight) });
  }
  var out={ ok:false, pts:pts.length, needPts:Math.max(0, CALIB_MIN_PTS-pts.length),
            needSpan:0, needLog:0 };
  if(out.needPts>0) return out;

  var first=pts[0], last=pts[pts.length-1];
  out.from=first.k; out.to=last.k;
  out.span=last.x-first.x;
  out.days=out.span+1;
  out.needSpan=Math.max(0, CALIB_MIN_SPAN-out.span);
  if(out.needSpan>0) return out;

  /* 只算「有記飲食」的日子：漏記的那天不是 0 大卡，是沒有資料 */
  var nets=[];
  for(i=first.x;i<=last.x;i++){
    d=db.days[shiftDate(start,i)];
    if(d && (d.entries||[]).length) nets.push(netOf(d));
  }
  out.logged=nets.length;
  out.needLog=Math.max(0, CALIB_MIN_LOG-nets.length);
  if(out.needLog>0) return out;

  /* 體重取最小平方法的斜率，不是頭尾相減——頭尾兩筆各自被那天的水分決定 */
  var n=pts.length, sx=0, sy=0, sxx=0, sxy=0;
  pts.forEach(function(p){ sx+=p.x; sy+=p.w; sxx+=p.x*p.x; sxy+=p.x*p.w; });
  var den=n*sxx-sx*sx;
  if(!den) return out;

  var bmr=bmrOf(db.profile);
  out.slope=(n*sxy-sx*sy)/den;            /* kg／天，負的＝在瘦 */
  out.kgWeek=out.slope*7;
  out.avgNet=avgOf(nets);
  out.real=Math.round(out.avgNet - out.slope*7700);
  out.cur=tdeeOf(db.profile);             /* app 現在實際在用的 */
  out.formula=Math.round(bmr*num(db.profile.activity));
  out.applied=num(db.profile.tdee)>0;
  out.diff=out.real-out.cur;
  /* 推算值低於基礎代謝：人不可能消耗比 BMR 還少，幾乎一定是有漏記的餐 */
  out.suspect=out.real<bmr;
  out.thin=out.logged<out.days*0.7;
  /* 體重跳得太誇張（量錯、打錯、中間斷很久）時推算值會完全不能看，寧可不講 */
  if(out.real<900 || out.real>6000){ out.wild=true; return out; }
  out.ok=true;
  return out;
}

function calibRow(k, v, strong){
  return '<div class="r'+(strong?" strong":"")+'"><span>'+esc(k)+'</span><b>'+esc(v)+'</b></div>';
}

function calibHtml(){
  var c=calibrate();

  if(!c.ok){
    var need;
    if(c.wild) need="這段期間的體重變化太劇烈（可能是量錯或中間斷太久），先累積穩定一點的紀錄";
    else if(c.needPts>0) need="還差 "+c.needPts+" 筆體重紀錄";
    else if(c.needSpan>0) need="體重紀錄要跨滿兩週，再過 "+c.needSpan+" 天就能算";
    else need="這段期間還要再有 "+c.needLog+" 天的飲食紀錄";
    return '<div class="sec"><div class="calib todo">'+
        '<b>🎯 校準你的真實 TDEE</b>'+
        '<span>公式算的 TDEE 是族群平均，套到個人身上常差 ±200 大卡。'+
        '累積兩週的體重紀錄，app 就能用「實際掉了多少」反推你真正的消耗，'+
        '每日上限才會是你的。</span>'+
        '<div class="calib-need">'+esc(need)+'</div>'+
        '<button class="btn" data-act="weigh-today">記今天的體重</button>'+
       '</div></div>';
  }

  var same=Math.abs(c.diff)<50;
  var newTarget=Math.max(800, c.real+round(db.profile.goal));
  var h='<div class="sec"><div class="calib'+(same?" ok":"")+'">'+
      '<b>🎯 你的真實 TDEE 約 '+kcal(c.real)+' 大卡</b>'+
      '<div class="calib-rows">'+
        calibRow("期間", fmtMD(c.from)+"–"+fmtMD(c.to)+"（"+c.days+" 天，"+
                 c.logged+" 天有記飲食）")+
        calibRow("平均每天淨攝取", kcal(c.avgNet)+" 大卡")+
        calibRow("體重趨勢", (c.kgWeek<0?"−":"+")+Math.abs(c.kgWeek).toFixed(2)+" kg／週")+
        calibRow("推算真實 TDEE", kcal(c.real)+" 大卡", true)+
        calibRow("app 目前用的", kcal(c.cur)+" 大卡"+
                 (c.applied?"（已校準）":"（公式）"))+
      '</div>';

  /* 警告一定要印在按鈕「之前」：印在後面等於他先按了才看到。
   * 而且推算值明顯不合理時，套用鈕要降級成次要樣式，不要長得像「照做就對了」。 */
  if(c.suspect){
    h+='<div class="calib-warn">⚠️ 推算值低於你的基礎代謝 '+kcal(bmrOf(db.profile))+
       ' 大卡，人不可能消耗得比基礎代謝還少——這段期間幾乎一定有漏記的餐。'+
       '建議先補齊飲食紀錄再回來看，不要直接套用。</div>';
  }else if(c.thin){
    h+='<div class="calib-warn">⚠️ 這 '+c.days+' 天裡只有 '+c.logged+
       ' 天有記飲食，沒記的日子沒被算進平均，結果會偏低。</div>';
  }
  if(same){
    h+='<div class="calib-need">公式估得很準（相差 '+kcal(Math.abs(c.diff))+
       ' 大卡以內），不用改。</div>';
  }else{
    h+='<div class="calib-need">你的實際消耗比 app 現在用的'+(c.diff<0?"少":"多")+' '+
       kcal(Math.abs(c.diff))+' 大卡。套用之後，每日'+
       (num(db.profile.goal)<0?"上限":"目標")+'會變成 '+kcal(newTarget)+' 大卡。</div>'+
       '<button class="btn'+(c.suspect?" ghost":"")+'" data-act="apply-calib" data-v="'+c.real+'">'+
       (c.suspect?"仍要套用 ":"套用 ")+kcal(c.real)+' 大卡</button>';
  }
  if(c.applied){
    h+='<button class="btn ghost" data-act="clear-calib">改回公式估算（'+
       kcal(c.formula)+' 大卡）</button>';
  }
  h+='<div class="calib-foot">真實 TDEE ＝平均吃進去的 ＋ 每天實際掉的體重 × 7700 大卡。'+
     '體重有新紀錄就會重新算一次。</div>';
  return h+'</div></div>';
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
/* 把「每天缺口幾大卡」翻成「一週幾公斤」。
 * 「少 211 大卡」很抽象，「一週 −0.19 公斤」才有感覺——Benson 說這樣比較有動力。
 * gap > 0 ＝ 吃得比 TDEE 少 ＝ 會瘦（顯示負號）。 */
function weekPace(gapPerDay){
  var kg=num(gapPerDay)*7/7700;
  return (kg>=0?"−":"+")+Math.abs(kg).toFixed(2)+" kg";
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
      sum:(p.sex==="female"?"女":"男")+" · "+round(p.age)+" 歲 · "+round(p.height)+" cm · "+kgTxt(p.weight)+" kg" },
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
  list.push({ g:"其他", id:"push", icon:"\uD83D\uDD14", label:"每日提醒",
    sum: pushSummary() });
  list.push({ g:"其他", id:"ver", icon:"\u2139\uFE0F", label:"版本",
    sum: updateReady ? "有新版本 · 點一下更新" : "v"+APP_VER,
    warn: updateReady ? "amber" : "" });
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

  /* 版本已經是「其他」那一組裡的一列了，頁尾不用再印一次（同一頁講兩遍） */
  h+='<div style="height:24px"></div>';
  return h;
}

/* ---- 設定的分頁 sheet ---- */
var SET_TITLES={ body:"身體資料", activity:"活動量與 TDEE", goal:"每日目標", macros:"營養目標",
                 ai:"AI 熱量判讀", gh:"GitHub 同步", users:"使用者", data:"資料與常吃清單",
                 push:"每日提醒", ver:"版本" };

/* 索引那一列的摘要。這一列的重點是「這台裝置到底會不會響」，
 * 所以不支援／要先加主畫面都直接寫在索引上，不用點進去才知道。 */
function pushSummary(){
  if(!pushSupported()) return "這個瀏覽器不支援";
  if(isIOS() && !isStandalone()) return "要先加入主畫面";
  if(!STORE.canWrite()) return "要先貼 GitHub 金鑰";
  if(myPush) return "每天 "+myPush.time+" 提醒";
  return "關閉中";
}

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
        '<div class="field"><label>身高（cm）</label><input type="number" inputmode="decimal" step="0.1" data-num="height" value="'+p.height+'"></div>'+
      '</div>'+
      '<div class="field"><label>生日（選填）</label>'+
        '<input type="date" id="s-birth" data-birth="1" value="'+esc(p.birth)+'" max="'+esc(dateKey())+'">'+
        '<div class="hint" id="birth-hint">'+birthHintText(p)+'</div></div>'+
      '<div class="field"><label>體重（kg）</label><input type="number" inputmode="decimal" step="0.01" data-num="weight" value="'+p.weight+'"></div>'+
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
        '<input type="number" inputmode="numeric" step="1" data-num="tdee" value="'+p.tdee+'">'+
        '<div class="hint">有做過體檢代謝測量的話填進來，會蓋掉公式估算值。</div></div>';
  }

  if(sec==="goal"){
    return '<p class="desc" style="margin-top:0">在 TDEE 上加減，決定「今天還可以吃多少」。</p>'+
      '<div class="chips">'+
        GOALS.map(function(g){
          return '<button class="chip '+(round(p.goal)===g.v?"on":"")+'" data-set="goal" data-val="'+g.v+'">'+g.label+'</button>';
        }).join("")+
      '</div>'+
      '<div class="field"><label>自訂調整（大卡）</label>'+
        '<input type="number" inputmode="numeric" step="1" data-num="goal" value="'+p.goal+'">'+
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
  if(sec==="push"){
    var why=pushBlockReason();
    var t=(myPush&&myPush.time)||pendPushTime;
    var skip=myPush ? myPush.skipIfWeighed!==false : pendPushSkip;
    var h=(pushMsg?'<div class="set-alert amber"><b>'+esc(pushMsg)+'</b></div>':'');

    if(why && !myPush){
      /* 開不了就不要給一顆按了沒反應的按鈕，直接講為什麼 */
      return h+'<div class="set-alert amber"><b>現在還開不了</b><span>'+esc(why)+'</span></div>'+
        '<p class="desc">通知是手機系統跳出來的那種，跟一般 app 一樣會出現在鎖定畫面。'+
        '它由 GitHub 上的排程送出，所以<b>不用開著 app、電腦關機也照樣會響</b>。</p>';
    }

    h+='<div class="field"><label>提醒時間</label>'+
       '<div class="chips">'+
         PUSH_TIMES.map(function(x){
           return '<button type="button" class="chip'+(x===t?" on":"")+'" data-ptime="'+x+'">'+x+'</button>';
         }).join("")+
       '</div></div>';

    h+='<button type="button" class="opt-row'+(skip?" on":"")+'" data-pskip="1">'+
        '<b>已經量過就不要吵我</b>'+
        '<span>當天量過體重的話今天就不提醒。</span></button>';

    h+='<button class="btn'+(myPush?" ghost":"")+'" type="button" data-push="'+(myPush?"off":"on")+'"'+
        (pushBusy?" disabled":"")+'>'+
        (pushBusy ? "處理中…" : (myPush ? "關閉每日提醒" : "打開每日提醒"))+'</button>';

    h+='<p class="desc">'+(myPush
        ? '每天 <b>'+esc(t)+'</b> 會跳一則通知出來，不用開著 app。'
        : '打開之後，手機會先問你要不要允許通知，按「允許」。')+
       '<br>提醒是 GitHub 上的排程送的，<b>電腦關機也照樣會響</b>。'+
       '不過排程有時候會誤點 <b>5～30 分鐘</b>，當提醒夠用、當鬧鐘不行。</p>';

    /* 狀態一覽：通知沒跳的時候，一眼看得出卡在哪一關。
     * 「雲端有紀錄、這台裝置卻沒有訂閱」＝ iOS 把訂閱撤銷了（收到推播卻沒跳通知會觸發），
     * 這是真的故障；單純還沒開則是灰色，不要嚇人。 */
    var cloud=(pushSubs||[]).filter(function(x){ return x.u===(me&&me.id); })[0];
    var expectOn=!!(myPush || cloud);
    var broken=expectOn && pushDiag.checked && (!pushDiag.sub || !pushDiag.keys);
    var perm=Notification.permission;
    h+='<div class="tdee-box" style="margin-top:14px">'+
        pushRow("通知權限", perm==="granted"?"ok":(perm==="denied"?"bad":"off"),
          perm==="granted"?"已允許":(perm==="denied"?"被拒絕":"還沒問"))+
        pushRow("這台裝置的訂閱",
          !pushDiag.checked?"off":(pushDiag.sub?"ok":(expectOn?"bad":"off")),
          !pushDiag.checked?"檢查中…":(pushDiag.sub?"正常":(expectOn?"沒有（被 iOS 撤銷了）":"尚未開啟")))+
        pushRow("推播加密金鑰",
          !pushDiag.checked?"off":(pushDiag.keys?"ok":(expectOn?"bad":"off")),
          !pushDiag.checked?"檢查中…":(pushDiag.keys?"已備妥":(expectOn?"缺少":"尚未開啟")))+
      '</div>';
    if(broken){
      h+='<div class="set-alert"><b>提醒現在不會響</b>'+
         '<span>iOS 有時候會自己把推播訂閱收回去。按下面那顆重新設定一次就好。</span></div>';
    }
    /* 壞掉的時候這才是該按的那顆，做成主要按鈕；平常只是備用，維持低調 */
    h+='<button class="btn'+(broken?"":" ghost")+'" type="button" data-push="fix"'+
        (pushBusy?" disabled":"")+'>'+
        (pushBusy?"處理中…":(broken?"重新設定提醒":"重新設定提醒（修復用）"))+'</button>';

    if(myPush){
      var owner=users.filter(function(x){ return x.id===myPush.u; })[0];
      if(owner && owner.id!==me.id){
        /* 一台裝置只有一個訂閱，但「今天量過了嗎」是看某一位使用者的紀錄。
         * 綁錯人的話會在該提醒的時候不提醒，所以直接寫出來。 */
        h+='<div class="set-alert amber"><b>目前是看「'+esc(owner.name)+'」有沒有量體重</b>'+
           '<span>動一下上面的時間或選項，就會改成看「'+esc(me.name)+'」的。</span></div>';
      }
      h+='<p class="desc">設定只對<b>這台裝置</b>有效（一台裝置一組提醒）。'+
         '換手機或重灌要再打開一次。</p>';
    }
    return h;
  }

  if(sec==="ver"){
    return '<div class="tdee-box" style="margin-top:0">'+
        '<div class="r"><span>現在跑的版本</span><b class="num">v'+APP_VER+'</b></div>'+
      '</div>'+
      '<div id="ver-state">'+verStateHtml()+'</div>'+
      '<p class="desc">這個號碼是<b>手機上實際跑起來的那一份</b>，不是雲端最新的那一份。'+
      'PWA 的殼會存在手機裡，新版下載好之後要重新載入才會換過去——'+
      '平常關掉重開就會是新的，想馬上換就按上面那顆。</p>';
  }
  return "";
}

/* 狀態一覽的一列。三態，不是兩態：
 *   on   綠 ＝ 這關過了
 *   （紅）＝ 應該要好卻壞了
 *   off  灰 ＝ 還沒開，本來就沒有——不是故障
 * 只有兩態的話，「從來沒開過提醒」的人會看到兩顆紅點，以為 app 壞了。 */
function pushRow(label, state, text){
  return '<div class="r"><span>'+esc(label)+'</span>'+
    '<b class="pdot'+(state==="ok"?" on":(state==="off"?" off":""))+'">'+esc(text)+'</b></div>';
}

/* 半小時一格。排程是每 30 分鐘跑一次，給到分鐘級只會讓他覺得「怎麼沒準時」。 */
var PUSH_TIMES=["06:00","06:30","07:00","07:30","08:00","08:30","09:00","10:00"];

/* 版本區塊的狀態：有新版就給「立即更新」，沒有就給「檢查一下」 */
function verStateHtml(){
  if(updateReady){
    return '<div class="set-alert amber"><b>🎉 新版本已經下載好了</b>'+
        '<span>重新載入就會換過去。記到一半的東西已經存好了，不會不見。</span></div>'+
      '<button class="btn" type="button" data-ver="reload">立即更新</button>';
  }
  return (verMsg ? '<div class="set-alert amber"><b>'+esc(verMsg)+'</b></div>' : '')+
    '<button class="btn ghost" type="button" data-ver="check">檢查有沒有新版本</button>';
}

/* 生日是選填，但填了就以它為準：年齡改成唯讀顯示，生日過了自己 +1。
 * 沒填生日的人維持原本自己輸入年齡的方式（不強迫交出生日）。
 * 抽成獨立一塊是為了「只換這一小塊」——見 wireSetSheet 裡的 data-birth。 */
function ageFieldHtml(p){
  return '<label>年齡</label>'+(p.birth
    ? '<div class="static-val">'+p.age+' 歲<span>生日到了會自動加</span></div>'
    : '<input type="number" inputmode="numeric" step="1" data-num="age" value="'+p.age+'">');
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
  var vChk=root.querySelector('[data-ver="check"]');
  if(vChk) vChk.onclick=function(){
    vChk.disabled=true; vChk.textContent="檢查中…";
    checkUpdate().then(function(found){
      verMsg = found ? "" : "已經是最新版了。";
      redraw(false);
      verMsg="";
    });
  };
  var vGo=root.querySelector('[data-ver="reload"]');
  if(vGo) vGo.onclick=function(){ location.reload(); };

  /* 時間 chip：已經開著的話直接改設定存回去，沒開就只是先選好 */
  root.querySelectorAll("[data-ptime]").forEach(function(b){
    b.onclick=function(){
      var t=b.getAttribute("data-ptime");
      if(!myPush){ pendPushTime=t; redraw(false); return; }
      /* 動到設定就把它綁給現在這位使用者：「要看誰有沒有量體重」以最後設定的人為準 */
      var next=Object.assign({}, myPush, {time:t, u:me.id});
      setMyPush(next, myPush.endpoint).then(function(){
        toast("改成每天 "+t); redraw(false); render();
      }).catch(function(e){
        pushMsg=e.userMessage||"改時間失敗"; redraw(false);
      });
    };
  });
  var pSkip=root.querySelector("[data-pskip]");
  if(pSkip) pSkip.onclick=function(){
    if(!myPush){ pendPushSkip=!pendPushSkip; redraw(false); return; }
    var next=Object.assign({}, myPush, {skipIfWeighed:myPush.skipIfWeighed===false, u:me.id});
    setMyPush(next, myPush.endpoint).then(function(){ redraw(false); }).catch(function(e){
      pushMsg=e.userMessage||"儲存失敗"; redraw(false);
    });
  };
  root.querySelectorAll("[data-push]").forEach(function(pBtn){
    pBtn.onclick=function(){
      var again=function(){ redraw(false); render(); };
      var mode=pBtn.getAttribute("data-push");
      if(mode==="off"){ disablePush(again); return; }
      if(mode==="fix"){ repairPush(again); return; }
      /* requestPermission 要在手勢裡直接呼叫，所以這裡不能先 await 任何東西 */
      enablePush(pendPushTime, pendPushSkip, again);
    };
  });

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
  if(act==="prev-day"){ curDate=shiftDate(curDate,-1); mealOpen={}; ensureDays([curDate]); render(); return; }
  if(act==="next-day"){ if(curDate<dateKey()){ curDate=shiftDate(curDate,1); mealOpen={}; ensureDays([curDate]); render(); } return; }
  if(act==="go-today"){ curDate=dateKey(); mealOpen={}; ensureDays([curDate]); render(); return; }
  if(act==="fold-meal"){
    var fm=el.getAttribute("data-meal");
    mealOpen[fm]=!mealOpen[fm];
    render(); return;
  }
  if(act==="toggle-detail"){ showDetail=!showDetail; render(); return; }
  if(act==="toggle-mnote"){ showMNote=!showMNote; render(); return; }
  if(act==="coach"){ openCoachSheet(false); return; }
  if(act==="open-day"){ curDate=el.getAttribute("data-date"); view="today"; mealOpen={}; ensureDays([curDate]); render(); window.scrollTo(0,0); return; }
  if(act==="add"){ if(requireWrite()) openAddSheet(el.getAttribute("data-meal")); return; }
  if(act==="add-move"){ if(requireWrite()) openMoveSheet(null); return; }
  if(act==="edit-entry"){ if(requireWrite()) openEntrySheet(el.getAttribute("data-id")); return; }
  if(act==="edit-move"){ if(requireWrite()) openMoveSheet(el.getAttribute("data-id")); return; }
  if(act==="edit-notes"){ if(requireWrite()) openNotesSheet(); return; }
  if(act==="edit-weight"){ if(requireWrite()) openWeightSheet(); return; }
  if(act==="weigh-today"){
    if(!requireWrite()) return;
    curDate=dateKey(); view="today"; ensureDays([curDate]);
    render(); window.scrollTo(0,0); openWeightSheet(); return;
  }
  /* 校準結果寫進「手動覆寫 TDEE」——就是設定裡本來就有的那個欄位，
   * 不另外開一個平行的欄位，不然兩個 TDEE 打架時沒人知道哪個在生效。 */
  if(act==="apply-calib"){
    if(!requireWrite()) return;
    var tv=Math.round(Number(el.getAttribute("data-v"))||0);
    if(!(tv>0)) return;
    db.profile.tdee=tv;
    db.profile=cleanProfile(db.profile);
    persistProfile(); render();
    toast("TDEE 已改成 "+kcal(tv)+" 大卡"); return;
  }
  if(act==="clear-calib"){
    if(!requireWrite()) return;
    db.profile.tdee=0;
    db.profile=cleanProfile(db.profile);
    persistProfile(); render();
    toast("已改回公式估算"); return;
  }
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
    /* 提醒狀態是背景載入：讀失敗（沒網路、還沒有 push.md）也不能擋住整個 app，
     * 所以刻意不接進上面那條鏈。讀完再重畫一次設定頁的摘要。 */
    loadPushState().then(function(){ if(view==="settings" && !picking) render(); })
      .catch(function(){});
  }).catch(function(e){
    booted=true;
    toast(e.userMessage||"載入失敗，先用預設值", true);
  });
}

/* ============ sheet 基礎 ============ */
var sheetStack=[];
/* 每張 sheet 一個序號。
 * AI 那幾條路都是「先開一張等待中的 sheet → await → 回來把內容換掉」，
 * 但使用者可能在等的時候就把它關掉、或改去開別張。回來時如果不確認
 * 「最上面那張還是不是我開的那張」，就會發生：關掉之後 sheet 自己彈回來
 * 蓋住整個 app（等太久按關閉就會遇到），或是把別張 sheet 的內容換成 AI 結果。
 * 所以非同步回來一律先問 sheetAlive()。 */
var sheetSeq=0;
function topSid(){ return sheetStack.length ? sheetStack[sheetStack.length-1].sid : 0; }
function sheetAlive(sid){ return !!sid && topSid()===sid; }

function openSheet(title, bodyHtml, opts){
  opts=opts||{};
  sheetStack.push({sid:++sheetSeq, title:title, body:bodyHtml, opts:opts});
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
  /* 每個 sheet 都經過這裡（含 replaceSheet 的重畫），會長高的文字框在這裡一次接好，
   * 各個 onDraw 就不用各自記得呼叫一次。 */
  wireTa($sheetLayer);
}
/* 只換內容不重推堆疊（AI 讀取中 -> 結果） */
function replaceSheet(title, bodyHtml, opts){
  if(!sheetStack.length) return;   /* 已經被關掉了就不要硬塞回去 */
  sheetStack[sheetStack.length-1]={sid:++sheetSeq, title:title, body:bodyHtml, opts:opts||{}};
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
var favPick={};                 /* 常吃分頁的勾選（可一次加好幾樣） */
var favQ="";                    /* 常吃分頁的搜尋字串：sheet 會重畫好幾次，得撐得住 */

function openAddSheet(meal){
  addMeal=meal||guessMeal();
  addTab=hasAiKey()?"text":"manual";
  favPick={}; favQ="";
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
        '<textarea class="ta" id="i-text" rows="2" style="min-height:78px" '+
          'placeholder="例如：排骨便當加飯、南瓜湯頭的麵疙瘩、大杯半糖珍奶" autocomplete="off">'+
          esc(lastText)+'</textarea>'+
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
      '<input type="file" id="i-lib" accept="image/*" multiple hidden>'+
      '<div class="field"><label>補充說明（選填）</label>'+
        taHtml("i-hint", lastHint, "例如：這碗是大碗、白飯只吃一半")+'</div>'+
      '<button class="btn" type="submit" id="b-photo"'+(pendingPhotos.length?"":" disabled")+'>交給 AI 估算</button>'+
    '</form>';
  }
  if(addTab==="fav"){
    if(!db.foods.length){
      return '<div class="card" style="margin:14px 0 0"><p class="desc" style="margin:0">'+
             esc(me.name)+' 還沒有常吃項目。用 AI 或手動記過的東西會自動存進這裡，'+
             '也可以直接自己建一筆。</p></div>'+
             '<button class="btn" type="button" data-fav-new="1">＋ 新增常吃項目</button>';
    }
    /* 清單短的時候搜尋框只是多一個要滑過去的東西 */
    return (db.foods.length>=8
      ? '<div class="field"><label>搜尋</label>'+
        '<input type="text" id="i-fav-q" placeholder="輸入食物名稱" autocomplete="off"></div>'
      : '')+
      '<button class="btn ghost" type="button" data-fav-new="1" style="margin-top:8px">＋ 新增常吃項目</button>'+
      '<div id="fav-list">'+favListHtml(favQ)+'</div>'+
      '<div id="fav-go">'+favGoHtml()+'</div>'+
      '<p class="hint" style="padding:2px 4px 0">點項目＝勾選，可以一次勾好幾樣；右邊的 ✎ 可以改內容或刪掉。</p>';
  }
  /* manual */
  return '<form id="f-manual">'+
    '<div class="field"><label>名稱</label>'+
      taHtml("m-name", "", "例如：滷肉飯", { enter:"submit", required:true })+'</div>'+
    '<div class="field"><label>份量（選填）</label>'+
      taHtml("m-por", "", "例如：一碗（約一個拳頭）", { enter:"submit" })+'</div>'+
    '<div class="field"><label>熱量（大卡）</label><input type="number" inputmode="decimal" step="0.1" id="m-kcal" placeholder="0" required></div>'+
    '<div class="ai-nums c3" style="margin-top:12px">'+
      '<label><span>蛋白 g</span><input type="number" inputmode="decimal" step="0.1" id="m-p" placeholder="0"></label>'+
      '<label><span>碳水 g</span><input type="number" inputmode="decimal" step="0.1" id="m-c" placeholder="0"></label>'+
      '<label><span>脂肪 g</span><input type="number" inputmode="decimal" step="0.1" id="m-f" placeholder="0"></label>'+
    '</div>'+
    '<button class="btn" type="submit">加入</button>'+
  '</form>';
}

/* 已經選過照片就要把預覽畫回來（別讓人以為要重拍）。
 * 這一頁會因為切換分頁、AI 估完退回來等原因重畫好幾次，
 * 而 pendingPhotos 一直都還在記憶體裡——以前這裡固定畫「加一張照片」的空狀態，
 * 送出鈕又是 disabled，看起來就像照片不見了，所以只好重拍一次（Benson 踩過）。 */
function photoPickHtml(){
  var n=pendingPhotos.length;
  if(n){
    var h='<div class="photo-strip'+(n>1?" multi":"")+'">';
    pendingPhotos.forEach(function(src,i){
      h+='<div class="photo-cell"><img class="photo-prev" src="'+src+'" alt="餐點照片 '+(i+1)+'">'+
         '<button type="button" data-rm="'+i+'" aria-label="移除第 '+(i+1)+' 張">✕</button></div>';
    });
    h+='</div>';
    h+= n<MAX_PHOTOS
      ? '<div class="photo-btns after">'+
          '<label class="pbtn" for="i-cam">📷 再拍一張</label>'+
          '<label class="pbtn" for="i-lib">🖼️ 再選幾張</label>'+
        '</div>'
      : '<p class="hint" style="padding:8px 4px 0">已經 '+MAX_PHOTOS+' 張了（上限）。要換的話先移除一張。</p>';
    if(n>1) h+='<p class="hint" style="padding:8px 4px 0">這 '+n+' 張會一起送給 AI、當成同一餐。'+
      '同一樣東西出現在兩張裡不會被算兩次。</p>';
    return h;
  }
  return '<div class="photo-pick">'+
      '<i>🍱</i>'+
      '<b>加餐點照片</b>'+
      '<span>整桌、便當盒都可以，會自動拆成多筆<br>'+
        '一餐分好幾盤就多拍幾張，最多 '+MAX_PHOTOS+' 張</span>'+
      '<div class="photo-btns">'+
        '<label class="pbtn" for="i-cam">📷 拍照</label>'+
        '<label class="pbtn" for="i-lib">🖼️ 從相簿選</label>'+
      '</div>'+
    '</div>';
}

/* 常吃清單（定案）：
 *   點整列 ＝ 勾選（可以一次勾好幾樣，最後按一次加入）——以前一次只能加一筆，
 *   早餐固定三樣就要開三次 sheet。
 *   點 ✎ ＝ 編輯內容或刪除。刪除刻意收進編輯裡，一列不要塞兩顆破壞性按鈕。 */
function favRowHtml(f){
  var on=!!favPick[f.id];
  return '<div class="food-item">'+
    '<button class="food-row'+(on?" on":"")+'" data-fav="'+esc(f.id)+'" aria-pressed="'+(on?"true":"false")+'">'+
      '<span class="tick">'+(on?"✓":"")+'</span>'+
      '<b>'+esc(f.name)+(f.portion?'<span class="por">'+esc(f.portion)+'</span>':'')+'</b>'+
      '<span class="k num">'+kcal(f.kcal)+'<i>大卡</i></span>'+
    '</button>'+
    '<button class="food-del" data-fav-edit="'+esc(f.id)+'" aria-label="編輯 '+esc(f.name)+'">✎</button>'+
  '</div>';
}
/* 分成「★ 常吃」與「吃過的」兩區：記過的東西都會自動進這份清單，
 * 很快就幾十筆、大半只吃過一次，不分區的話真正天天吃的那幾樣會被淹掉。
 * 版面成本只有一條分區標題。 */
function favListHtml(q){
  q=String(q||"").trim().toLowerCase();
  var list=db.foods.filter(function(f){ return !q || f.name.toLowerCase().indexOf(q)>=0; });
  if(!list.length) return '<p class="empty">找不到符合的項目</p>';
  var star=list.filter(function(f){ return f.star; }).slice(0,40);
  var rest=list.filter(function(f){ return !f.star; }).slice(0,60);
  var h="";
  if(star.length){
    h+='<div class="fav-grp">★ 常吃</div>'+star.map(favRowHtml).join("");
    if(rest.length) h+='<div class="fav-grp">吃過的</div>';
  }
  h+=rest.map(favRowHtml).join("");
  return h;
}
function favGoHtml(){
  var picked=db.foods.filter(function(f){ return favPick[f.id]; });
  if(!picked.length) return "";
  var t=0; picked.forEach(function(f){ t+=num(f.kcal); });
  return '<button class="btn" type="button" data-fav-go="1">加入 '+picked.length+' 筆 · 共 '+kcal(t)+' 大卡</button>';
}

/* 新增／編輯一筆常吃項目。以前只能靠「記過一次」被動長出來，
 * 想自己建（或改掉 AI 估歪的數字）都做不到。 */
function openFoodSheet(id){
  var f = id ? db.foods.filter(function(x){ return x.id===id; })[0] : null;
  if(id && !f) return;
  var d = f || { name:"", portion:"", kcal:0, p:0, c:0, f:0 };
  var star=!!(f && f.star);
  var body='<form id="f-food">'+
    '<div class="field" style="margin-top:0"><label>名稱</label>'+
      taHtml("fd-name", d.name, "例如：滷雞腿便當", { enter:"submit", required:true })+'</div>'+
    '<div class="field"><label>份量（選填）</label>'+
      taHtml("fd-por", d.portion||"", "例如：一個便當盒", { enter:"submit" })+'</div>'+
    /* 不用自己記碳水蛋白質：打完名稱按這顆，AI 幫你填 */
    (hasAiKey()?'<button class="btn ghost" type="button" id="fd-ai">🤖 讓 AI 幫我填數字</button>':'')+
    '<div class="ai-nums" id="fd-nums">'+
      '<label><span>大卡</span><input type="number" inputmode="decimal" step="0.1" id="fd-kcal" value="'+round(d.kcal)+'"></label>'+
      '<label><span>蛋白 g</span><input type="number" inputmode="decimal" step="0.1" id="fd-p" value="'+gram(d.p)+'"></label>'+
      '<label><span>碳水 g</span><input type="number" inputmode="decimal" step="0.1" id="fd-c" value="'+gram(d.c)+'"></label>'+
      '<label><span>脂肪 g</span><input type="number" inputmode="decimal" step="0.1" id="fd-f" value="'+gram(d.f)+'"></label>'+
    '</div>'+
    '<button class="btn ghost star-btn'+(star?" on":"")+'" type="button" id="fd-star" aria-pressed="'+(star?"true":"false")+'">'+
      (star?"★ 已釘選為常吃（排最上面）":"☆ 釘選為常吃（排到最上面）")+'</button>'+
    '<button class="btn" type="submit">'+(f?"儲存":"加進常吃清單")+'</button>'+
    (f?'<button class="btn danger" type="button" data-fd-del="1">從常吃清單刪除</button>':'')+
  '</form>';

  openSheet(f?"編輯常吃項目":"新增常吃項目", body, { onDraw:function(root){
    var sb=root.querySelector("#fd-star");
    if(sb) sb.onclick=function(){
      star=!star;
      sb.classList.toggle("on", star);
      sb.setAttribute("aria-pressed", star?"true":"false");
      sb.textContent = star?"★ 已釘選為常吃（排最上面）":"☆ 釘選為常吃（排到最上面）";
    };
    var ab=root.querySelector("#fd-ai");
    if(ab) ab.onclick=function(){
      var name=(root.querySelector("#fd-name").value||"").trim();
      if(!name){ toast("先寫名稱，AI 才知道要估什麼", true); return; }
      var por=(root.querySelector("#fd-por").value||"").trim();
      ab.disabled=true; ab.textContent="估算中…";
      aiAnalyzeOne(db.profile.model, null, "", por ? name+"（"+por+"）" : name)
        .then(function(res){
          var it=(res&&res.items&&res.items[0]);
          if(!it) throw aiErrorLike("AI 沒有回傳結果，再試一次。");
          root.querySelector("#fd-kcal").value=round(it.kcal);
          root.querySelector("#fd-p").value=round(it.p);
          root.querySelector("#fd-c").value=round(it.c);
          root.querySelector("#fd-f").value=round(it.f);
          if(it.portion && !por) root.querySelector("#fd-por").value=it.portion;
          ab.disabled=false; ab.textContent="🤖 重新讓 AI 估";
          toast("填好了，數字不對可以自己改");
        })
        .catch(function(e){
          ab.disabled=false; ab.textContent="🤖 讓 AI 幫我填數字";
          toast(e.userMessage||e.message||"估算失敗", true);
        });
    };
    root.querySelector("#f-food").onsubmit=function(ev){
      ev.preventDefault();
      if(!requireWrite()) return;
      var name=(root.querySelector("#fd-name").value||"").trim();
      if(!name){ toast("請填名稱", true); return; }
      var o={
        name:name,
        portion:(root.querySelector("#fd-por").value||"").trim(),
        kcal:Math.max(0, Number(root.querySelector("#fd-kcal").value)||0),
        p:Math.max(0, Number(root.querySelector("#fd-p").value)||0),
        c:Math.max(0, Number(root.querySelector("#fd-c").value)||0),
        f:Math.max(0, Number(root.querySelector("#fd-f").value)||0)
      };
      o.star=star;
      if(f){ Object.keys(o).forEach(function(k){ f[k]=o[k]; }); }
      else { o.id=uid(); o.n=1; db.foods.push(o); }
      db.foods.sort(sortFoods);
      persistFoods();
      closeSheet();
      drawAddSheet(false);
      toast(f?"已更新":"已加進常吃清單");
    };
    var del=root.querySelector("[data-fd-del]");
    if(del) del.onclick=function(){
      if(!requireWrite()) return;
      if(!confirm("把「"+f.name+"」從常吃清單刪除？（已經記進去的飲食不受影響）")) return;
      db.foods=db.foods.filter(function(x){ return x.id!==f.id; });
      delete favPick[f.id];
      persistFoods();
      closeSheet();
      drawAddSheet(false);
      toast("已刪除");
    };
  }});
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
    lastText=t;
    runAi(function(){ return aiAnalyzeText(db.profile.model, t); });
  };

  var fPhoto=root.querySelector("#f-photo");
  if(fPhoto){
    var btn=root.querySelector("#b-photo");
    var slot=root.querySelector("#photo-slot");
    /* 縮圖列會反覆重畫（加一張、移除一張），畫完要重新接移除鈕 */
    var paint=function(){
      slot.innerHTML=photoPickHtml();
      slot.querySelectorAll("[data-rm]").forEach(function(x){
        x.onclick=function(){
          pendingPhotos.splice(+x.getAttribute("data-rm"),1);
          paint();
        };
      });
      btn.disabled=!pendingPhotos.length;
      btn.textContent="交給 AI 估算";
    };
    paint();
    var onPick=function(input){
      return function(){
        var files=Array.prototype.slice.call(input.files||[]);
        /* 同一張照片連選兩次時 change 不會再觸發，所以每次處理完把 value 清掉 */
        input.value="";
        files=files.slice(0, Math.max(0, MAX_PHOTOS-pendingPhotos.length));
        if(!files.length){
          if(pendingPhotos.length>=MAX_PHOTOS) toast("最多 "+MAX_PHOTOS+" 張", true);
          return;
        }
        btn.disabled=true;
        btn.textContent="處理照片中…";
        /* 一張一張接著處理：同時解好幾張大圖在手機上很容易把記憶體吃爆 */
        files.reduce(function(chain, f){
          return chain.then(function(){
            return compressImage(f).then(function(dataUrl){ pendingPhotos.push(dataUrl); });
          });
        }, Promise.resolve()).then(paint).catch(function(e){
          toast(e.userMessage||"照片處理失敗", true);
          paint();
        });
      };
    };
    ["#i-cam","#i-lib"].forEach(function(sel){
      var el=root.querySelector(sel);
      if(el) el.onchange=onPick(el);
    });
    fPhoto.onsubmit=function(ev){
      ev.preventDefault();
      if(!pendingPhotos.length){ toast("請先選一張照片", true); return; }
      var hint=(root.querySelector("#i-hint")||{}).value||"";
      lastHint=hint;
      var photos=pendingPhotos.slice();
      runAi(function(){ return aiAnalyzePhoto(db.profile.model, photos, hint); }, photos);
    };
  }

  var q=root.querySelector("#i-fav-q");
  if(q){
    q.value=favQ;
    q.oninput=function(){
      favQ=q.value;
      root.querySelector("#fav-list").innerHTML=favListHtml(favQ);
      var goEl=root.querySelector("#fav-go");
      if(goEl) goEl.innerHTML=favGoHtml();
      wireFav(root);
    };
  }
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
      portion:((root.querySelector("#m-por")||{}).value||"").replace(/[\r\n]+/g," ").trim(),
      src:"manual" };
    addEntries([item]);
  };
}
/* 一餐可以給好幾張（不同的盤子、或飲料另外拍）。
 * 上限 4 張：壓縮後每張約 1000 個 token，四張還在零頭；再多只是讓 AI 更容易重複計算。 */
var MAX_PHOTOS=4;
/* 一餐超過幾項就先收起來（火鍋一次十幾樣）。展開狀態只在記憶體，換日期就重來。 */
var MEAL_FOLD=4;
var mealOpen={};
var pendingPhotos=[];
var lastHint="";                /* 上次照片的補充說明：回來「再估一次」時不用重打 */
/* 文字描述同理。AI 失敗（沒網路、額度用完）是最常走到的分支之一，
 * 打了一長串「排骨便當加飯、湯是南瓜的…」結果被清空，等於逼他重打一次。 */
var lastText="";

function wireFav(root){
  /* 只換清單那一塊，不整份重畫：搜尋框正在輸入時重畫會把焦點與鍵盤弄掉 */
  var redrawList=function(){
    var listEl=root.querySelector("#fav-list"), goEl=root.querySelector("#fav-go");
    if(listEl) listEl.innerHTML=favListHtml(favQ);
    if(goEl) goEl.innerHTML=favGoHtml();
    wireFav(root);
  };
  root.querySelectorAll("[data-fav]").forEach(function(b){
    b.onclick=function(){
      var id=b.getAttribute("data-fav");
      if(favPick[id]) delete favPick[id]; else favPick[id]=true;
      redrawList();
    };
  });
  root.querySelectorAll("[data-fav-edit]").forEach(function(b){
    b.onclick=function(){ openFoodSheet(b.getAttribute("data-fav-edit")); };
  });
  var nw=root.querySelector("[data-fav-new]");
  if(nw) nw.onclick=function(){ openFoodSheet(null); };
  var go=root.querySelector("[data-fav-go]");
  if(go) go.onclick=function(){
    var picked=db.foods.filter(function(f){ return favPick[f.id]; });
    if(!picked.length) return;
    addEntries(picked.map(function(f){
      return { id:uid(), name:f.name, kcal:f.kcal, p:f.p||0, c:f.c||0, f:f.f||0,
               portion:f.portion||"", src:"preset" };
    }));
  };
}

/* ---- 呼叫 AI 並顯示可編輯的預覽 ---- */
function runAi(fn, photos){
  replaceSheet("AI 估算中",
    '<div class="spin"><div class="dots"><i></i><i></i><i></i></div>Claude 正在看你吃了什麼…</div>', {});
  var sid=topSid();
  fn().then(function(res){
    if(!sheetAlive(sid)) return;   /* 等的時候被關掉了，不要自己彈回來 */
    aiResult=res;
    /* 記住是哪張照片估出來的：之後「重估某一項」要把同一張圖再送一次 */
    aiResult.photos=(photos||[]).slice();
    drawAiResult();
  }).catch(function(e){
    toast(e.userMessage||"AI 估算失敗", true);
    if(!sheetAlive(sid)) return;   /* 關掉了就只提示，不要把輸入頁叫回來 */
    /* ⚠️ 這裡以前寫 `if(photo)`——v4.1 把參數改成複數 photos 的時候漏改，
     * 變成 ReferenceError。它在 .catch 裡面，所以整個 catch 從那行起中斷、
     * 底下的 drawAddSheet 永遠不會跑，畫面就卡在「AI 估算中」轉圈圈回不去，
     * 而且錯誤被 unhandled rejection 吃掉、console 也不會紅。
     * 教訓：AI 失敗是最常走到的分支之一，一定要有測試。 */
    if(photos && photos.length) addTab="photo";   /* 照片還在，退回去就看得到，不用重拍 */
    drawAddSheet(false); /* 退回輸入畫面，讓他改描述重試 */
  });
}

var aiResult=null;
function drawAiResult(){
  var body='';
  if(aiResult.note) body+='<div class="ai-note">💡 '+esc(aiResult.note)+'</div>';
  /* 「652 大卡」看起來像量過的，其實是估的。不講清楚，使用者會把兩次估算的差
   * 當成 app 壞掉；講清楚之後，同一個誤差就只是正常範圍。 */
  body+='<div class="ai-acc">估算誤差約 ±20%。份量寫錯就點名稱進去調倍數。</div>';
  body+=mealPicker();

  /* 吃過的東西沿用上次的數字。
   * 這是唯一能把「同一張照片兩次差很多」降到零的做法——同樣的東西根本不重估。
   * 只在差 5% 以上時才提示：差幾大卡還跳出來問，只是版面雜訊。 */
  var reusable=[];
  aiResult.items.forEach(function(it,idx){
    if(it.reused) return;
    var f=findFood(it.name);
    if(!f || !num(f.kcal)) return;
    if(Math.abs(num(f.kcal)-num(it.kcal)) < Math.max(20, num(f.kcal)*0.05)) return;
    reusable.push(idx);
  });
  if(reusable.length){
    body+='<div class="ai-reuse"><b>🔁 有 '+reusable.length+' 樣你記過</b>'+
      '<span>沿用上次記的數字，同一份餐點每次記都會一樣，不用管 AI 這次估多少。</span>'+
      '<button data-use="all">全部沿用上次的數字</button></div>';
  }

  aiResult.items.forEach(function(it,idx){
    var cf = it.confidence==="high" ? "" :
      '<span class="conf '+it.confidence+'">'+(it.confidence==="low"?"不太確定":"約略")+'</span>';
    var f=findFood(it.name), last='';
    if(it.reused){
      last='<div class="ai-last done">已沿用上次記的數字</div>';
    }else if(f && num(f.kcal) && reusable.indexOf(idx)>=0){
      var gap=num(it.kcal)-num(f.kcal);
      last='<button class="ai-last" data-use="'+idx+'">上次記 '+kcal(f.kcal)+' 大卡'+
           '（這次'+(gap>0?"多":"少")+' '+kcal(Math.abs(gap))+'）· 沿用</button>';
    }
    body+='<div class="ai-item">'+
      '<div class="t"><button class="ai-name" data-fix="'+idx+'">'+esc(it.name)+cf+
          '<i class="pen">✎</i></button>'+
        '<button data-drop="'+idx+'" aria-label="移除">✕</button></div>'+
      (it.portion?'<div class="por">'+esc(it.portion)+'</div>':'')+
      last+
      '<div class="ai-nums">'+
        '<label><span>大卡</span><input type="number" inputmode="decimal" step="0.1" data-f="kcal" data-i="'+idx+'" value="'+it.kcal+'"></label>'+
        '<label><span>蛋白 g</span><input type="number" inputmode="decimal" step="0.1" data-f="p" data-i="'+idx+'" value="'+gram(it.p)+'"></label>'+
        '<label><span>碳水 g</span><input type="number" inputmode="decimal" step="0.1" data-f="c" data-i="'+idx+'" value="'+gram(it.c)+'"></label>'+
        '<label><span>脂肪 g</span><input type="number" inputmode="decimal" step="0.1" data-f="f" data-i="'+idx+'" value="'+gram(it.f)+'"></label>'+
      '</div>'+
    '</div>';
  });
  body+='<button class="btn ghost" data-fix="-1">＋ 補一項（AI 漏掉的）</button>';
  /* 火鍋、合菜、自助餐這種一次十幾樣的，逐項記在今天頁會佔掉一整頁。
   * 存進去之前先合併成一筆，之後常吃清單也只會多一筆「火鍋」——
   * 下次吃同一家一鍵沿用，比十幾筆各自比對實用得多。 */
  if(aiResult.items.length>=3){
    body+='<button class="btn ghost" data-ai="merge">🍲 合併成一項（'+aiResult.items.length+' 樣併成一筆）</button>';
  }
  var total=0; aiResult.items.forEach(function(i){ total+=num(i.kcal); });
  body+='<button class="btn" data-ai="save">加入 '+aiResult.items.length+' 筆 · 共 '+kcal(total)+' 大卡</button>'+
        '<button class="btn ghost" data-ai="retry">'+
          (aiResult.photos.length?"補充說明，整批再估一次":"重新描述")+'</button>';

  replaceSheet("AI 估算結果 · "+me.name, body, { onDraw:function(root){
    root.querySelectorAll("[data-meal-pick]").forEach(function(b){
      b.onclick=function(){ addMeal=b.getAttribute("data-meal-pick"); drawAiResult(); };
    });
    root.querySelectorAll("[data-f]").forEach(function(inp){
      inp.oninput=function(){
        var i=+inp.getAttribute("data-i");
        var fld=inp.getAttribute("data-f");
        var v=Math.max(0, Number(inp.value)||0);
        /* 熱量是整數，三大營養素留一位小數（食品標示常常是 2.5 g） */
        aiResult.items[i][fld] = (fld==="kcal") ? Math.round(v) : Math.round(v*10)/10;
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
    root.querySelectorAll("[data-fix]").forEach(function(b){
      b.onclick=function(){ openAiItemSheet(+b.getAttribute("data-fix")); };
    });
    root.querySelectorAll("[data-use]").forEach(function(b){
      b.onclick=function(){
        var v=b.getAttribute("data-use");
        if(v==="all"){ aiResult.items.forEach(function(x,i){ useLastFood(i); }); }
        else useLastFood(+v);
        drawAiResult();
      };
    });
    var save=root.querySelector('[data-ai="save"]');
    if(save) save.onclick=function(){ addEntries(aiResult.items); };
    var mg=root.querySelector('[data-ai="merge"]');
    if(mg) mg.onclick=function(){ openMergeSheet(); };
    var retry=root.querySelector('[data-ai="retry"]');
    if(retry) retry.onclick=function(){
      if(aiResult.photos.length) addTab="photo";   /* 照片還在，直接回到照片那一頁 */
      drawAddSheet(false);
    };
  }});
}

/* 把整批合併成一筆。營養素直接加總，份量欄留下「裡面有什麼」當紀錄。 */
function openMergeSheet(){
  var items=aiResult.items;
  var total=0; items.forEach(function(i){ total+=num(i.kcal); });
  var names=items.map(function(i){ return i.name; });
  var guess=String(lastHint||"").trim().split(/[\s,，、。]/)[0] || "";
  var body='<form id="f-merge">'+
    '<p class="desc" style="margin-top:0">把這 '+items.length+' 樣併成一筆 '+kcal(total)+
      ' 大卡，今天頁就只會多一列。營養素會加總，裡面有什麼會寫在份量欄。</p>'+
    '<div class="field"><label>這一餐叫什麼</label>'+
      taHtml("mg-name", guess, "例如：火鍋、鹽水雞、家庭聚餐", { enter:"submit", required:true })+
      '<div class="hint">之後這個名字會進常吃清單，下次吃同一家一鍵沿用。</div></div>'+
    '<div class="tdee-box"><div class="r"><span>會併進來的</span></div>'+
      '<div class="r"><span style="font-size:12px;line-height:1.6">'+esc(names.join("、"))+'</span></div></div>'+
    '<button class="btn" type="submit">合併</button>'+
  '</form>';
  openSheet("合併成一項", body, { onDraw:function(root){
    root.querySelector("#f-merge").onsubmit=function(ev){
      ev.preventDefault();
      var nm=(root.querySelector("#mg-name").value||"").replace(/[\r\n]+/g," ").trim();
      if(!nm){ toast("先給這一餐一個名字", true); return; }
      mergeAiItems(nm);
      closeSheet();
      drawAiResult();
      toast("已併成一筆");
    };
  }});
}
function mergeAiItems(name){
  var items=aiResult.items;
  var k=0,p=0,c=0,f=0, names=[];
  items.forEach(function(it){
    k+=num(it.kcal); p+=num(it.p); c+=num(it.c); f+=num(it.f);
    names.push(it.name);
  });
  var por="共 "+items.length+" 樣："+names.slice(0,8).join("、")+(names.length>8?" 等":"");
  aiResult.items=[{
    id:uid(), name:name,
    kcal:round(k), p:round1(p), c:round1(c), f:round1(f),
    portion:por.slice(0,140), confidence:"medium", src:"ai"
  }];
}

/* 把某一項換成常吃清單裡記過的數字。
 * 順便把名稱也對齊成清單裡的寫法：之後的比對就會是完全命中，
 * 常吃清單也不會因為 AI 每次換個寫法而長出近似重複。 */
function useLastFood(idx){
  var it=aiResult.items[idx];
  if(!it || it.reused) return;
  var f=findFood(it.name);
  if(!f || !num(f.kcal)) return;
  it.name=f.name;
  it.kcal=round(f.kcal); it.p=round1(f.p); it.c=round1(f.c); it.f=round1(f.f);
  if(f.portion) it.portion=f.portion;
  it.confidence="high";   /* 這已經不是估的了，是上次記下來的 */
  it.reused=true;
}

/* ============ 今天吃得怎樣（營養師講評） ============
 * 手動按才打 AI，因為每按一次就是一次費用。
 * 結果存進那一天的紀錄裡（day md 的「## 講評」段）：跨裝置看得到、之後回頭
 * 也能重看，不用再花一次錢。一天只留最新的一則，重新評估就覆蓋。 */

function coachPrompt(){
  var d=dayOf(curDate), p=db.profile;
  var mt=macroTargets(p), m=macrosOf(d);
  var eaten=sumKcal(d.entries), burn=sumKcal(d.moves), net=eaten-burn;
  var target=targetOf(p), tdee=tdeeOf(p);
  var isToday=curDate===dateKey();
  var L=[];
  L.push(isToday
    ? "今天是 "+curDate+"，現在 "+nowHM()+"。"
    : "這是 "+curDate+" 的紀錄（過去的日子，已經結束了）。");
  L.push("我的目標：TDEE "+tdee+" 大卡，每日"+(num(p.goal)<0?"上限":"目標")+" "+target+" 大卡"+
         "（"+(num(p.goal)<0?"減脂中，缺口 "+Math.abs(round(p.goal)):"維持／增肌")+"）。");
  L.push("三大營養素目標：蛋白質 "+mt.p+" g、脂肪 "+mt.f+" g、碳水 "+mt.c+" g。");
  L.push("目前累計：吃了 "+eaten+" 大卡"+(burn?"、運動消耗 "+burn+" 大卡，淨 "+net+" 大卡":"")+
         "；蛋白質 "+Math.round(m.p)+" g、脂肪 "+Math.round(m.f)+" g、碳水 "+Math.round(m.c)+" g。");
  if(isToday) L.push("距離每日"+(num(p.goal)<0?"上限":"目標")+"還有 "+(target-net)+" 大卡。");
  L.push("");
  L.push("今天吃的東西：");
  MEALS.forEach(function(mk){
    var list=(d.entries||[]).filter(function(e){ return e.meal===mk; });
    if(!list.length) return;
    L.push("【"+MEAL_INFO[mk].label+"】");
    list.forEach(function(e){
      L.push("- "+e.name+(e.portion?"（"+e.portion+"）":"")+
        "："+round(e.kcal)+" 大卡"+
        (num(e.p)||num(e.c)||num(e.f)
          ? "，蛋白 "+round(e.p)+"g／碳水 "+round(e.c)+"g／脂肪 "+round(e.f)+"g" : ""));
    });
  });
  if((d.moves||[]).length){
    L.push("【運動】");
    d.moves.forEach(function(mv){ L.push("- "+mv.name+"：消耗 "+round(mv.kcal)+" 大卡"); });
  }
  return L.join("\n");
}

function coachBodyHtml(r){
  var h='<div class="coach-top"><b>'+esc(r.verdict)+'</b>'+
        (r.at?'<span>'+esc(fmtStamp(r.at))+' 評的</span>':'')+'</div>';
  if((r.good||[]).length){
    h+='<div class="coach-sec good"><h3>做得好</h3><ul>'+
       r.good.map(function(x){ return '<li>'+esc(x)+'</li>'; }).join("")+'</ul></div>';
  }
  if((r.issues||[]).length){
    h+='<div class="coach-sec warn"><h3>可以更好</h3><ul>'+
       r.issues.map(function(x){ return '<li>'+esc(x)+'</li>'; }).join("")+'</ul></div>';
  }
  if(r.next){
    h+='<div class="coach-sec next"><h3>接下來</h3><p>'+esc(r.next)+'</p></div>';
  }
  h+='<p class="hint" style="padding:12px 4px 0">AI 給的建議僅供參考，有疾病或特殊需求還是要問醫師或營養師。</p>'+
     '<button class="btn ghost" data-coach="again">重新評估（會再用一次 AI）</button>';
  return h;
}

function openCoachSheet(force){
  if(!hasAiKey()){
    openSheet("今天吃得怎樣", noKeyBox(), { onDraw:function(root){
      var g=root.querySelector('[data-act2="go-settings"]');
      if(g) g.onclick=function(){ closeAllSheets(); view="settings"; render(); };
    }});
    return;
  }
  var key=curDate;
  var draw=function(isNew, body, opts){
    if(isNew) openSheet("今天吃得怎樣", body, opts||{});
    else replaceSheet("今天吃得怎樣", body, opts||{});
  };
  var wire=function(root){
    var again=root.querySelector('[data-coach="again"]');
    if(again) again.onclick=function(){ openCoachSheet(true); };
  };

  var saved=dayOf(key).coach;
  if(!force && saved){
    draw(true, coachBodyHtml(saved), { onDraw:wire });
    return;
  }
  var isNew=!force;
  draw(isNew, '<div class="spin"><div class="dots"><i></i><i></i><i></i></div>營養師正在看你今天吃了什麼…</div>', {});
  var sid=topSid();
  aiCoachDay(db.profile.model, coachPrompt()).then(function(r){
    r.at=new Date().toISOString();
    dayOf(key).coach=r;
    persistDay(key);              /* 存進那一天，之後回頭看不用再花錢 */
    /* 存檔要照做（錢已經花了），但畫面只在他還開著的時候才動 */
    if(sheetAlive(sid)) draw(false, coachBodyHtml(r), { onDraw:wire });
    if(!picking) render();        /* 按鈕文案要換成「看講評」 */
  }).catch(function(e){
    toast(e.userMessage||"評估失敗", true);
    if(sheetAlive(sid)) closeSheet();
  });
}

/* ---- 修正其中一項（idx<0 = 補一項） ----
 * 使用者最常遇到的是「東西認錯了」。原本只能整批重來（而且畫面害他以為要重拍），
 * 為了一項錯誤重做六項很煩。這裡只動那一項，其他項目原封不動。 */
function openAiItemSheet(idx){
  var isNew = idx<0;
  var it = isNew ? { name:"", portion:"" } : aiResult.items[idx];
  var orig = it.name || "";

  var body='<form id="f-aifix">'+
    '<div class="field" style="margin-top:0"><label>這一項是什麼</label>'+
      taHtml("fix-name", it.name||"", "例如：叉燒，3 片", { enter:"submit", required:true })+'</div>'+
    '<div class="field"><label>份量（選填）</label>'+
      taHtml("fix-por", it.portion||"", "例如：約 80 克、半碗", { enter:"submit" })+'</div>'+
    (isNew ? '' : scaleChipsHtml())+
    '<p class="hint" style="padding:0 4px">'+
      (aiResult.photos.length
        ? '會帶著原本'+(aiResult.photos.length>1?"那 "+aiResult.photos.length+" 張":"那張")+
          '照片一起問，其他項目不會動到。'
        : '只重估這一項，其他項目不會動到。')+'</p>'+
    '<button class="btn" type="submit" id="fix-go">'+(isNew?"讓 AI 估這一項":"重新估這一項")+'</button>'+
    (isNew
      ? '<button class="btn ghost" type="button" data-fix2="manual">先加進去，數字我自己填</button>'
      : '<button class="btn ghost" type="button" data-fix2="rename">只改名稱，數字不動</button>')+
  '</form>';

  openSheet(isNew?"補一項":"修正這一項", body, { onDraw:function(root){
    root.querySelectorAll("[data-scale]").forEach(function(b){
      b.onclick=function(){
        var m=Number(b.getAttribute("data-scale"))||1;
        it.kcal=round(num(it.kcal)*m);
        it.p=round1(num(it.p)*m); it.c=round1(num(it.c)*m); it.f=round1(num(it.f)*m);
        it.portion=markScaled(it.portion, m);
        closeSheet();
        drawAiResult();
        toast("換算成 "+kcal(it.kcal)+" 大卡");
      };
    });
    var nameEl=root.querySelector("#fix-name"), porEl=root.querySelector("#fix-por");
    var go=root.querySelector("#fix-go");

    root.querySelector("#f-aifix").onsubmit=function(ev){
      ev.preventDefault();
      var said=(nameEl.value||"").trim();
      if(!said){ toast("先寫這一項是什麼", true); return; }
      var por=(porEl.value||"").trim();
      go.disabled=true; go.textContent="估算中…";
      var sid=topSid();
      aiAnalyzeOne(db.profile.model, aiResult.photos, isNew?"":orig,
                   por ? said+"（"+por+"）" : said)
        .then(function(res){
          var got=(res&&res.items)||[];
          if(!got.length) throw aiErrorLike("AI 沒有回傳結果，再試一次。");
          /* 等的時候被關掉了：不要 closeSheet（會關到別人）也不要硬畫結果頁 */
          if(!sheetAlive(sid)){ toast("已重估，回結果頁看得到"); return; }
          if(isNew) aiResult.items=aiResult.items.concat(got);
          else Array.prototype.splice.apply(aiResult.items, [idx,1].concat(got));
          closeSheet();      /* 回到結果頁 */
          drawAiResult();
          toast(isNew?"已補上":"已重估這一項");
        })
        .catch(function(e){
          go.disabled=false; go.textContent=isNew?"讓 AI 估這一項":"重新估這一項";
          toast(e.userMessage||e.message||"重估失敗", true);
        });
    };

    var alt=root.querySelector("[data-fix2]");
    if(alt) alt.onclick=function(){
      var said=(nameEl.value||"").trim();
      if(!said){ toast("先寫這一項是什麼", true); return; }
      var por=(porEl.value||"").trim();
      if(alt.getAttribute("data-fix2")==="manual"){
        /* 不打 AI：先塞一筆 0 大卡的，數字在結果頁直接改 */
        aiResult.items.push({ id:uid(), name:said, portion:por, kcal:0, p:0, c:0, f:0,
                              confidence:"low", src:"manual" });
      }else{
        aiResult.items[idx].name=said;
        aiResult.items[idx].portion=por;
      }
      closeSheet();
      drawAiResult();
    };
  }});
}
function aiErrorLike(msg){ var e=new Error(msg); e.userMessage=msg; return e; }

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
  pendingPhotos=[]; aiResult=null; lastHint=""; lastText="";
  closeAllSheets();
  render();
  toast("已記錄 "+items.length+" 筆");
}

/* 把今天記的某一筆存成常吃項目。營養素直接沿用那一筆，
 * 不用自己記碳水蛋白質——這是「新增常吃很麻煩」最直接的解法。
 * 同名的就更新並釘選（不要長出第二筆一樣的）。 */
function starEntry(e){
  if(!requireWrite()) return;
  var key=String(e.name||"").trim();
  if(!key) return;
  var hit=findFood(key);
  if(hit){
    hit.star=true;
    hit.kcal=round(e.kcal); hit.p=round1(e.p); hit.c=round1(e.c); hit.f=round1(e.f);
    if(e.portion) hit.portion=e.portion;
  }else{
    db.foods.push({ id:uid(), name:key, kcal:round(e.kcal), p:round1(e.p), c:round1(e.c),
                    f:round1(e.f), portion:e.portion||"", star:true, n:1 });
  }
  db.foods.sort(sortFoods);
  persistFoods();
  toast("已加入常吃：「"+key+"」");
}
function isStarred(name){
  var hit=findFood(name);
  return !!(hit && hit.star);
}

/* ============ 份量的倍數調整 ============
 * 「這一顆到底幾公克」沒有人在餐桌上量得出來，但「這比它說的少一半」是看得出來的——
 * 人判斷「相對量」比判斷「絕對量」準得多。所以給倍數按鈕，不要要求他填公克。
 * 熱量與三大營養素一起換算，比例才不會歪掉（單獨改熱量會讓營養頁對不起來）。 */
var SCALES=[{m:0.5,t:"½"},{m:0.75,t:"¾"},{m:1.5,t:"1.5"},{m:2,t:"2"}];
function scaleChipsHtml(){
  return '<div class="field"><label>份量不對？直接調倍數</label><div class="chips">'+
    SCALES.map(function(s){
      return '<button type="button" class="chip" data-scale="'+s.m+'">×'+s.t+'</button>';
    }).join("")+'</div>'+
    '<div class="hint">不用知道幾公克——只要判斷「比它講的多還是少」。'+
    '熱量與三大營養素會一起換算。</div></div>';
}
/* 份量文字裡的數字沒辦法安全地縮放（「3顆，每顆約28g，共約85g」裡的「每顆」不該動），
 * 所以不改原文，只在後面記一個累計倍率。連按兩次 ×½ 會變成 0.25 倍，
 * 按了 ×½ 再按 ×2 就回到原樣、標記整個消失。 */
function markScaled(txt, m){
  var t=String(txt||"");
  var mm=/（實際約([\d.]+)倍）/.exec(t);
  var prev=mm ? (num(mm[1])||1) : 1;
  var base=t.replace(/（實際約[^）]*）/g,"").trim();
  var f=Math.round(prev*m*100)/100;
  if(Math.abs(f-1)<0.005) return base;
  return base+"（實際約"+f+"倍）";
}

/* ============ 編輯／刪除單筆飲食 ============ */
function openEntrySheet(id){
  var d=dayOf(curDate);
  var e=d.entries.filter(function(x){ return x.id===id; })[0];
  if(!e) return;
  var body='<form id="f-edit">'+
    '<div class="field" style="margin-top:0"><label>名稱</label>'+
      taHtml("e-name", e.name, "", { enter:"submit", required:true })+'</div>'+
    '<p class="hint" id="e-por" style="font-size:12px;color:var(--muted);margin:-6px 0 0;line-height:1.5">'+
      (e.portion?'AI 假設：'+esc(e.portion):'')+'</p>'+
    '<div class="field"><label>記在哪一餐</label><div class="chips">'+
      MEALS.map(function(mk){
        return '<button type="button" class="chip '+(e.meal===mk?"on":"")+'" data-emeal="'+mk+'">'+
               MEAL_INFO[mk].emoji+' '+MEAL_INFO[mk].label+'</button>';
      }).join("")+'</div></div>'+
    '<div class="ai-nums" style="margin-top:12px">'+
      '<label><span>大卡</span><input type="number" inputmode="decimal" step="0.1" id="e-kcal" value="'+e.kcal+'"></label>'+
      '<label><span>蛋白 g</span><input type="number" inputmode="decimal" step="0.1" id="e-p" value="'+gram(e.p)+'"></label>'+
      '<label><span>碳水 g</span><input type="number" inputmode="decimal" step="0.1" id="e-c" value="'+gram(e.c)+'"></label>'+
      '<label><span>脂肪 g</span><input type="number" inputmode="decimal" step="0.1" id="e-f" value="'+gram(e.f)+'"></label>'+
    '</div>'+
    scaleChipsHtml()+
    /* 一鍵存成常吃：營養素直接沿用這一筆，不用自己記碳水蛋白質 */
    '<button class="btn ghost star-btn'+(isStarred(e.name)?" on":"")+'" type="button" id="e-star">'+
      (isStarred(e.name)?"★ 已在常吃清單":"☆ 加入常吃清單")+'</button>'+
    '<button class="btn" type="submit">儲存</button>'+
    '<button class="btn danger" type="button" data-del="1">刪除這筆</button>'+
  '</form>';

  var pickedMeal=e.meal;
  var curPortion=e.portion||"";
  openSheet("編輯", body, { onDraw:function(root){
    root.querySelectorAll("[data-scale]").forEach(function(b){
      b.onclick=function(){
        var m=Number(b.getAttribute("data-scale"))||1;
        var k=root.querySelector("#e-kcal"), pp=root.querySelector("#e-p"),
            cc=root.querySelector("#e-c"), ff=root.querySelector("#e-f");
        k.value=round(num(k.value)*m);
        pp.value=gram(num(pp.value)*m);
        cc.value=gram(num(cc.value)*m);
        ff.value=gram(num(ff.value)*m);
        curPortion=markScaled(curPortion, m);
        var ph=root.querySelector("#e-por");
        if(ph) ph.textContent=curPortion?("AI 假設："+curPortion):"";
        toast("換算成 "+kcal(k.value)+" 大卡");
      };
    });
    var st=root.querySelector("#e-star");
    if(st) st.onclick=function(){
      /* 用畫面上當下的數字（他可能剛改過），不是原本存的那份 */
      starEntry({
        name:(root.querySelector("#e-name").value||e.name),
        kcal:Number(root.querySelector("#e-kcal").value)||0,
        p:Number(root.querySelector("#e-p").value)||0,
        c:Number(root.querySelector("#e-c").value)||0,
        f:Number(root.querySelector("#e-f").value)||0,
        portion:curPortion
      });
      st.classList.add("on");
      st.textContent="★ 已在常吃清單";
    };
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
      e.kcal=Math.max(0, round(Number(root.querySelector("#e-kcal").value)||0));
      /* 三大營養素留一位小數：輸入框收得下 2.5，這裡就不能再進位成 3
       * （手動記錄與常吃編輯本來就沒進位，這裡以前不一致） */
      e.p=Math.max(0, round1(Number(root.querySelector("#e-p").value)||0));
      e.c=Math.max(0, round1(Number(root.querySelector("#e-c").value)||0));
      e.f=Math.max(0, round1(Number(root.querySelector("#e-f").value)||0));
      e.portion=curPortion;
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
      taHtml("mv-name", mv?mv.name:"", "例如：飛輪 45 分、爬象山來回", { enter:"submit", required:true })+'</div>'+
    (hasAiKey()
      ? '<button class="btn ghost ai-move" type="button" data-ai-move="1">🤖 讓 AI 估消耗</button>'+
        '<div class="hint" style="margin-top:6px">清單裡沒有的運動，打上去讓 AI 算。會依你的體重估，'+
        '而且是<b>淨消耗</b>（扣掉那段時間本來就會燒的基礎代謝）。</div>'
      : '')+
    '<div id="mv-detail"></div>'+
    '<div class="field"><label>消耗熱量（大卡）</label>'+
      '<input type="number" inputmode="decimal" step="0.1" id="mv-kcal" value="'+(mv?mv.kcal:"")+'" placeholder="0" required>'+
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
    '<div class="field" style="margin-top:0"><label>'+esc(fmtLong(curDate))+' 的體重（kg）</label>'+
      '<input type="number" inputmode="decimal" step="0.01" id="w-val" value="'+(cur?cur:"")+'" '+
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
      closeSheet(); render(); toast(v?"已記錄 "+kgTxt(v)+" kg":"已清除");
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
        '<div class="field"><label>年齡</label><input type="number" inputmode="numeric" step="1" id="s-age" value="'+p.age+'"></div>'+
        '<div class="field"><label>身高（cm）</label><input type="number" inputmode="decimal" step="0.1" id="s-height" value="'+p.height+'"></div>'+
      '</div>'+
      '<div class="field"><label>體重（kg）</label><input type="number" inputmode="decimal" step="0.01" id="s-weight" value="'+p.weight+'"></div>'+
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
/* ============ 版本與更新 ============
 * PWA 的殼是 cache-first，所以「已經裝在手機上的那份」不會自己變新——
 * 新的 service worker 裝好、activate 之後，畫面上跑的仍然是舊的 JS，
 * 要重新載入才會換過去。使用者完全看不到這件事，只會覺得「怎麼沒有新功能」。
 * 所以：偵測到新版就記起來（updateReady），設定裡給一個「立即更新」。
 * ⚠️ 版本號跟 sw.js 的 cache 版本號要一起 +1。 */
/* ============ 每日提醒（Web Push）============
 * 「app 沒開的時候也要跳提醒」只有推播做得到，而推播一定要有一台機器去送。
 * 這個 app 兩台都不合格：Pages 是靜態的、家裡的 server.js 外面連不到。
 * 所以送的那一端是 GitHub Actions 排程（.github/workflows/daily-reminder.yml）。
 *
 * 公鑰放在程式碼裡是正常的（它本來就要給瀏覽器）；私鑰只在 Actions secret。
 * 換金鑰的話所有裝置都要重新訂閱一次——舊訂閱是綁在舊公鑰上的，換了就推不動。 */
var VAPID_PUBLIC="BBlsPY61wGRzCZKpmz2nrnWGWlXyRjxIF0H1l5b2G9TjaV5JheSfRxG-Q8reWflHgPp7YrFgB0x1h2yQo8jQ74U";

var pushSubs=null;      /* 整份訂閱清單（含別台裝置、女友的）；null ＝ 還沒讀過 */
var myPush=null;        /* 這台裝置這位使用者的那一筆；null ＝ 沒開 */
var pushBusy=false;
var pushMsg="";         /* 設定頁要顯示的一次性訊息 */
/* 還沒打開之前選的時間／選項先放這裡：訂閱成功才會寫進 push.md。
 * 不然「先選 8:00 再按打開」會用到預設的 7:30。 */
var pendPushTime="07:30";
var pendPushSkip=true;
/* 這台裝置「實際」的狀態（不是雲端那筆說的）。
 * 為什麼要存：通知沒跳的原因有好幾種，從外面完全看不出是哪一種——
 * 瀏覽器的訂閱被 iOS 撤銷了？金鑰沒補上去？權限被關了？
 * 猜了好幾輪都猜不中，所以直接顯示出來。 */
var pushDiag={ sub:false, keys:false, checked:false };

function pushSupported(){
  return typeof Notification!=="undefined" && "serviceWorker" in navigator && "PushManager" in window;
}
/* iOS 的硬規則：只有「加入主畫面」的 PWA 收得到推播，Safari 分頁一律不行。
 * 而且分頁裡連 Notification.requestPermission 都不會給——先擋下來講清楚，
 * 不然他會按了沒反應，以為是壞的。 */
function isIOS(){
  return /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
}
function isStandalone(){
  return window.navigator.standalone===true
    || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
}
function pushBlockReason(){
  if(!pushSupported()) return "這個瀏覽器不支援推播通知。";
  if(isIOS() && !isStandalone())
    return "iPhone 只有「加入主畫面」的版本收得到通知。請先用 Safari 的分享鍵 → 加入主畫面，再從主畫面打開來設定。";
  /* 唯讀（還沒貼 GitHub 金鑰）：提醒設定要存到雲端才送得出去。
   * 不先擋的話流程會很難看——通知權限問完、訂閱也成功了，最後卡在存檔那一步失敗。
   * app 其他每個寫入入口都有 requireWrite 守門，這裡也要一致。 */
  if(!STORE.canWrite())
    return "這台裝置還沒貼 GitHub 金鑰（目前是唯讀）。提醒設定要存到雲端，請先到「設定 → GitHub 同步」貼上金鑰再回來開。";
  if(Notification.permission==="denied")
    return "通知權限之前被拒絕過，瀏覽器不會再問第二次。要到 iPhone 的「設定 → 通知 → 減重助手」手動打開。";
  return "";
}

/* 訂閱裡的兩把加密金鑰（送有內容的推播要用）。
 * toJSON() 直接給 base64url 字串，最省事；舊瀏覽器沒有就自己從 ArrayBuffer 轉。 */
function subKeys(sub){
  try{
    var j=sub.toJSON && sub.toJSON();
    if(j && j.keys && j.keys.p256dh && j.keys.auth)
      return { p256dh:j.keys.p256dh, auth:j.keys.auth };
  }catch(e){}
  return { p256dh:u8ToB64url(sub.getKey && sub.getKey("p256dh")),
           auth:u8ToB64url(sub.getKey && sub.getKey("auth")) };
}
function u8ToB64url(buf){
  if(!buf) return "";
  var a=new Uint8Array(buf), str="";
  for(var i=0;i<a.length;i++) str+=String.fromCharCode(a[i]);
  return btoa(str).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

function b64urlToU8(s){
  var pad="=".repeat((4-s.length%4)%4);
  var raw=atob((s+pad).replace(/-/g,"+").replace(/_/g,"/"));
  var out=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i);
  return out;
}

/* 讀整份訂閱，並認出「這台裝置」那一筆。
 * 認的是 endpoint（推播服務給的裝置位址），不是裝置 id——
 * 我們沒有可靠的裝置 id，但 endpoint 本來就唯一。
 *
 * ⚠️ 刻意只比 endpoint、不比使用者：瀏覽器層面**一台裝置只有一個訂閱**，
 * 所以「一台裝置＝一筆提醒」。以前這裡比 (endpoint, 使用者)，結果切到另一位
 * 使用者時 app 就完全看不到自己那筆——顯示「關閉中」、金鑰也補不上去，
 * 而且在另一位底下按打開會被去重規則默默丟掉。
 * `u` 欄位的意義是「要看誰有沒有量體重」，不是「這筆屬於誰」。 */
function loadPushState(){
  if(!pushSupported()) return Promise.resolve();
  return Promise.all([
    STORE.loadPush().catch(function(){ return []; }),
    navigator.serviceWorker.ready.then(function(reg){ return reg.pushManager.getSubscription(); })
      .catch(function(){ return null; })
  ]).then(function(r){
    pushSubs=r[0]||[];
    var sub=r[1], ep=sub?sub.endpoint:"";
    pushDiag={ sub:!!ep, keys:false, checked:true };
    myPush=ep ? (pushSubs.filter(function(x){ return x.endpoint===ep; })[0]||null) : null;
    if(!myPush) return;
    pushDiag.keys=!!(myPush.p256dh && myPush.auth);
    pendPushTime=myPush.time; pendPushSkip=myPush.skipIfWeighed!==false;
    /* v5.2 之前訂的沒存加密金鑰（那時候送的是無內容推播）。
     * 這裡默默補上去，不用叫他把提醒關掉再開一次。 */
    if(myPush.p256dh && myPush.auth) return;
    var k=subKeys(sub);
    if(!k.p256dh || !k.auth) return;
    return setMyPush(Object.assign({}, myPush, k), ep).then(function(){
      pushDiag.keys=true;
    }).catch(function(e){
      /* 以前這裡整個吞掉，結果「金鑰沒補上」完全無聲。至少要留一句給設定頁看。 */
      pushMsg="自動補金鑰失敗："+(e.userMessage||e.message||"未知錯誤")+"，請按下面的「重新設定」。";
    });
  });
}

/* 整份覆蓋前一定要先重讀：別台裝置與女友的提醒都在同一個檔，
 * 拿記憶體裡的舊清單去寫會把別人的提醒無聲關掉。
 * 濾掉的條件只看 endpoint ＝ 一台裝置一筆（見 loadPushState 上面那段）。 */
function setMyPush(sub, endpoint){
  return STORE.loadPush().catch(function(){ return pushSubs||[]; }).then(function(cur){
    var rest=(cur||[]).filter(function(x){ return x.endpoint!==endpoint; });
    var next=sub ? rest.concat([sub]) : rest;
    return STORE.savePush(next).then(function(){
      pushSubs=next;
      myPush=sub;
    });
  });
}

function enablePush(time, skipIfWeighed, done){
  var why=pushBlockReason();
  if(why){ pushMsg=why; done(); return; }
  /* ⚠️ requestPermission 必須在使用者手勢裡「直接」呼叫。
   * 中間插一個 await（例如先去讀 push.md）iOS 就會當成不是手勢觸發、直接拒絕。 */
  var ask;
  try{ ask=Notification.requestPermission(); }catch(e){ ask=null; }
  if(!ask || !ask.then){ pushMsg="這個瀏覽器不支援推播通知。"; done(); return; }

  pushBusy=true; done();
  ask.then(function(perm){
    if(perm!=="granted") throw uiErr("你剛才選了不允許通知。要改的話到 iPhone 的「設定 → 通知 → 減重助手」。");
    return navigator.serviceWorker.ready;
  }).then(function(reg){
    return reg.pushManager.subscribe({
      userVisibleOnly:true,                       /* iOS 強制：收到就一定要跳通知 */
      applicationServerKey:b64urlToU8(VAPID_PUBLIC)
    });
  }).then(function(sub){
    var k=subKeys(sub);
    return setMyPush({
      id:uid(), u:me.id, time:time,
      tz:new Date().getTimezoneOffset(),          /* 台灣 -480；送的那端靠它換回 UTC */
      endpoint:sub.endpoint, p256dh:k.p256dh, auth:k.auth,
      skipIfWeighed:!!skipIfWeighed
    }, sub.endpoint);
  }).then(function(){
    pushMsg=""; toast("提醒開好了，明天 "+time+" 見");
  }).catch(function(e){
    pushMsg=e.userMessage||"提醒設定失敗，等一下再試一次。";
  }).then(function(){
    pushBusy=false; done();
  });
}

/* 一鍵重來：不管現在是什麼狀態，退掉舊的、重新訂一次、整份寫回去。
 * 「通知沒跳」的成因有好幾種（訂閱被 iOS 撤銷、金鑰沒補上、綁到別的使用者），
 * 一項一項查太慢，這顆按鈕把所有情況一次收掉。 */
function repairPush(done){
  var why=pushBlockReason();
  if(why){ pushMsg=why; done(); return; }
  var ask;
  try{ ask=Notification.requestPermission(); }catch(e){ ask=null; }
  if(!ask || !ask.then){ pushMsg="這個瀏覽器不支援推播通知。"; done(); return; }

  pushBusy=true; done();
  var oldEp=(myPush&&myPush.endpoint)||"";
  ask.then(function(perm){
    if(perm!=="granted") throw uiErr("通知權限沒有開。到 iPhone 的「設定 → 通知 → 減重助手」打開。");
    return navigator.serviceWorker.ready;
  }).then(function(reg){
    return reg.pushManager.getSubscription().then(function(cur){
      /* 舊訂閱可能已經被 iOS 撤銷、或綁在舊的金鑰上，一律退掉重來 */
      return (cur ? cur.unsubscribe().catch(function(){ return null; }) : Promise.resolve())
        .then(function(){
          return reg.pushManager.subscribe({
            userVisibleOnly:true,
            applicationServerKey:b64urlToU8(VAPID_PUBLIC)
          });
        });
    });
  }).then(function(sub){
    var k=subKeys(sub);
    if(!k.p256dh || !k.auth) throw uiErr("拿不到推播金鑰，這台裝置可能不支援。");
    return STORE.loadPush().catch(function(){ return pushSubs||[]; }).then(function(cur){
      /* 舊 endpoint 與新 endpoint 都清掉，只留新的一筆 */
      var rest=(cur||[]).filter(function(x){
        return x.endpoint!==sub.endpoint && (!oldEp || x.endpoint!==oldEp);
      });
      var next=rest.concat([{
        id:(myPush&&myPush.id)||uid(), u:me.id, time:pendPushTime,
        tz:new Date().getTimezoneOffset(), endpoint:sub.endpoint,
        p256dh:k.p256dh, auth:k.auth, skipIfWeighed:!!pendPushSkip
      }]);
      return STORE.savePush(next).then(function(){
        pushSubs=next;
        myPush=next[next.length-1];
        pushDiag={ sub:true, keys:true, checked:true };
      });
    });
  }).then(function(){
    pushMsg=""; toast("重新設定好了，可以再測一次");
  }).catch(function(e){
    pushMsg=e.userMessage||e.message||"重新設定失敗";
  }).then(function(){
    pushBusy=false; done();
  });
}

function disablePush(done){
  pushBusy=true; done();
  navigator.serviceWorker.ready.then(function(reg){
    return reg.pushManager.getSubscription();
  }).then(function(sub){
    var ep=sub?sub.endpoint:(myPush&&myPush.endpoint)||"";
    /* 先退訂再清檔：反過來的話中間失敗會留下一筆推得動、但 app 以為關掉的訂閱 */
    return (sub?sub.unsubscribe().catch(function(){ return null; }):Promise.resolve())
      .then(function(){ return setMyPush(null, ep); });
  }).then(function(){
    pushMsg=""; toast("提醒關掉了");
  }).catch(function(e){
    pushMsg=e.userMessage||"關閉失敗，等一下再試一次。";
  }).then(function(){
    pushBusy=false; done();
  });
}

function uiErr(m){ var e=new Error(m); e.userMessage=m; return e; }

var swReg=null;
var updateReady=false;
var verMsg="";                 /* 「檢查更新」的結果訊息，畫完就清掉 */

function markUpdate(){
  if(updateReady) return;
  updateReady=true;
  toast("有新版本了，到「設定 → 版本」可以立即更新");
  if(booted && !picking) render();
}

if("serviceWorker" in navigator){
  /* 第一次安裝時本來就沒有 controller，那不算「更新」，不要嚇人 */
  var hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", function(){
    if(!hadController){ hadController=true; return; }
    markUpdate();
  });
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("sw.js").then(function(reg){
      swReg=reg;
      /* 標準的偵測點：新的 worker 裝好、而且原本就有一個在跑 ＝ 有新版 */
      reg.addEventListener("updatefound", function(){
        var w=reg.installing;
        if(!w) return;
        w.addEventListener("statechange", function(){
          if(w.state==="installed" && navigator.serviceWorker.controller) markUpdate();
        });
      });
    }).catch(function(){ /* 沒 SW 也能用 */ });
  });
}

/* 主動問一次有沒有新版。瀏覽器自己也會檢查，但頻率不保證，
 * 使用者想「現在就確認」的時候要有東西可以按。 */
function checkUpdate(){
  if(!swReg || !swReg.update) return Promise.resolve(false);
  return swReg.update().then(function(){
    /* sw.js 有 skipWaiting，新的通常直接 activate，訊號會由上面那兩個 handler 送達；
     * 這裡等一下下讓它跑完再回報結果。 */
    return new Promise(function(res){
      setTimeout(function(){ res(updateReady); }, 1200);
    });
  }).catch(function(){ return false; });
}
