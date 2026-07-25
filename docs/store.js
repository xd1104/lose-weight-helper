"use strict";
/*
 * 減重助手 — 資料層
 * DataStore 依 location.hostname 自動切：
 *   localhost -> LocalStore：打本機 Node /api（全功能）
 *   其他(GitHub Pages) -> GitHubStore：直接讀寫 GitHub repo
 *     有 PAT -> 認證 Contents API 讀寫（即時）；無 PAT -> 唯讀走 raw + cache-buster
 * 多使用者：每個人一個資料夾 data/users/<uid>/，資料完全獨立。
 * md 序列化與 server.js 是同一套 mirror，改格式要兩邊一起改（見 CLAUDE.md）
 */

/* ============ 小工具 ============ */
function num(v){ var n=Number(v); return isFinite(n)?n:0; }
function round(v){ return Math.round(num(v)); }
function uid(){ return "x"+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function pad2(n){ return (n<10?"0":"")+n; }
/* 一律用「當地時區」的日期，不能用 toISOString（那是 UTC，台灣半夜會跳成前一天） */
function dateKey(d){ d=d||new Date(); return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function parseDateKey(s){ var p=String(s).split("-"); return new Date(+p[0], +p[1]-1, +p[2]); }
function shiftDate(key, n){ var d=parseDateKey(key); d.setDate(d.getDate()+n); return dateKey(d); }
function nowHM(){ var d=new Date(); return pad2(d.getHours())+":"+pad2(d.getMinutes()); }

/* 使用者資料夾名。字元集必須與 server.js 的 safeName（\p{L}\p{N} ＋ ._-）一致，
 * 否則手機端建的中文名字會在電腦端被 mangle 成另一個資料夾 → 同一個人分裂成兩份資料 */
function slugify(str){
  var base=String(str||"").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-+|-+$/g,"").slice(0,40);
  return base || "user";
}
function safeName(s){ return String(s||"").replace(/[^\p{L}\p{N}._\-]+/gu,"_"); }

function b64EncodeUtf8(str){
  var bytes=new TextEncoder().encode(str), bin="";
  for(var i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64DecodeUtf8(b64){
  return new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\n/g,"")), function(c){return c.charCodeAt(0);}));
}

/* ============ md 序列化（server.js 的 mirror，改要一起改） ============ */
var MEALS = ["breakfast","lunch","dinner","snack"];
var MEAL_INFO = {
  breakfast:{label:"早餐", emoji:"🌅"},
  lunch:    {label:"午餐", emoji:"☀️"},
  dinner:   {label:"晚餐", emoji:"🌙"},
  snack:    {label:"點心", emoji:"🍪"}
};
var USER_COLORS = ["#2fa86a","#3b82f6","#e0952c","#a855f7","#e0447f","#0e7490"];
var USER_EMOJIS = ["🙂","🐻","🐰","🦊","🐱","🐶","🌸","⭐","🍀","🔥","🥑","🐧"];

function fmString(v){ return JSON.stringify(String(v==null?"":v)); }
function fmNumber(v){ var n=Number(v); return String(isFinite(n)?n:0); }

/* ---- 使用者名冊 ---- */
function cleanUser(u){
  var o={
    id: safeName((u&&u.id)||""),
    name: String((u&&u.name)||"").trim().slice(0,20) || "未命名",
    emoji: String((u&&u.emoji)||"🙂").slice(0,8),
    color: String((u&&u.color)||""),
    createdAt: String((u&&u.createdAt)||new Date().toISOString())
  };
  if(!/^#[0-9a-fA-F]{3,8}$/.test(o.color)) o.color=USER_COLORS[0];
  if(!o.id) o.id=Date.now().toString(36)+"-"+slugify(o.name);
  return o;
}
function normalizeUsers(list){
  var out=[], seen={};
  (Array.isArray(list)?list:[]).forEach(function(u){
    var o=cleanUser(u);
    if(seen[o.id]) return; /* id 重複只留第一個，避免兩個人指到同一個資料夾 */
    seen[o.id]=true;
    out.push(o);
  });
  return out;
}
function serializeUsers(list){
  var L=["## 使用者",""];
  normalizeUsers(list).forEach(function(u){
    L.push("- "+JSON.stringify({id:u.id, name:u.name, emoji:u.emoji, color:u.color, createdAt:u.createdAt}));
  });
  L.push("");
  return L.join("\n");
}
function parseUsers(text){
  var out=[];
  String(text).replace(/\r\n/g,"\n").split("\n").forEach(function(line){
    var im=/^-\s+(\{.*\})\s*$/.exec(line);
    if(!im) return;
    try{ out.push(JSON.parse(im[1])); }catch(e){}
  });
  return normalizeUsers(out);
}

/* ---- 飲食 / 運動 / 常吃 ---- */
function cleanEntry(e){
  var o={ id:String((e&&e.id)||"") };
  o.time=String((e&&e.time)||"");
  o.meal=MEALS.indexOf(e&&e.meal)>=0 ? e.meal : "snack";
  o.name=String((e&&e.name)||"");
  o.kcal=round(e&&e.kcal);
  if(num(e&&e.p)) o.p=round(e.p);
  if(num(e&&e.c)) o.c=round(e.c);
  if(num(e&&e.f)) o.f=round(e.f);
  if(e&&e.portion) o.portion=String(e.portion);
  if(e&&e.note) o.note=String(e.note);
  if(e&&e.src) o.src=String(e.src);
  return o;
}
function cleanMove(m){
  return { id:String((m&&m.id)||""), time:String((m&&m.time)||""),
           name:String((m&&m.name)||""), kcal:round(m&&m.kcal) };
}
function cleanFood(f){
  var o={ id:String((f&&f.id)||""), name:String((f&&f.name)||"") };
  o.kcal=round(f&&f.kcal);
  if(num(f&&f.p)) o.p=round(f.p);
  if(num(f&&f.c)) o.c=round(f.c);
  if(num(f&&f.f)) o.f=round(f.f);
  if(f&&f.portion) o.portion=String(f.portion);
  o.n=Math.max(1, round(f&&f.n)||1);
  return o;
}

function emptyDay(date){
  return { date:date, weight:0, updatedAt:"", entries:[], moves:[], notes:"" };
}

function serializeDay(d){
  var L=["---"];
  L.push("date: "+fmString(d.date));
  L.push("weight: "+fmNumber(d.weight));
  L.push("updatedAt: "+fmString(d.updatedAt||new Date().toISOString()));
  L.push("---","","## 飲食","");
  (d.entries||[]).forEach(function(e){ L.push("- "+JSON.stringify(cleanEntry(e))); });
  L.push("","## 運動","");
  (d.moves||[]).forEach(function(m){ L.push("- "+JSON.stringify(cleanMove(m))); });
  L.push("","## 備註","");
  var notes=String(d.notes||"").replace(/\r\n/g,"\n");
  if(notes.trim()) L.push(notes.replace(/\s+$/,""));
  L.push("");
  return L.join("\n");
}

function parseFmLine(line){
  var idx=line.indexOf(":");
  if(idx===-1) return null;
  var key=line.slice(0,idx).trim(), raw=line.slice(idx+1).trim(), value;
  try{ value=JSON.parse(raw); }catch(e){ value=raw.replace(/^["']|["']$/g,""); }
  return [key,value];
}

function parseDay(date, text){
  var d=emptyDay(date);
  text=String(text).replace(/\r\n/g,"\n");
  var body=text;
  var fm=/^---\n([\s\S]*?)\n---\n?/.exec(text);
  if(fm){
    fm[1].split("\n").forEach(function(line){
      var kv=parseFmLine(line);
      if(!kv) return;
      if(kv[0]==="weight") d.weight=num(kv[1]);
      else if(kv[0]==="updatedAt") d.updatedAt=String(kv[1]);
    });
    body=text.slice(fm[0].length);
  }
  var section=null, inNotes=false, notesBuf=[];
  body.split("\n").forEach(function(line){
    if(inNotes){ notesBuf.push(line); return; }
    var h2=/^##\s+(.+)$/.exec(line.trim());
    if(h2){
      var name=h2[1].trim();
      if(name==="飲食") section="eat";
      else if(name==="運動") section="move";
      else if(name==="備註") inNotes=true;
      else section=null;
      return;
    }
    var im=/^-\s+(\{.*\})\s*$/.exec(line);
    if(!im) return;
    var obj;
    try{ obj=JSON.parse(im[1]); }catch(e){ return; } /* 壞列跳過，不整檔炸掉 */
    if(section==="eat") d.entries.push(cleanEntry(obj));
    else if(section==="move") d.moves.push(cleanMove(obj));
  });
  d.notes=notesBuf.join("\n").trim();
  return d;
}

function defaultProfile(){
  return { sex:"male", age:30, height:170, weight:65, activity:1.375,
           tdee:0, goal:0, model:"claude-sonnet-5", updatedAt:"" };
}
function cleanProfile(p){
  var d=defaultProfile();
  var o={
    sex:(p&&p.sex)==="female"?"female":"male",
    age:Math.min(120,Math.max(1, round((p&&p.age)||d.age))),
    height:Math.min(260,Math.max(80, round((p&&p.height)||d.height))),
    weight:Math.min(400,Math.max(20, round((p&&p.weight)||d.weight))),
    activity:num(p&&p.activity)||d.activity,
    tdee:Math.max(0, round(p&&p.tdee)),
    goal:round(p&&p.goal),
    model:String((p&&p.model)||d.model),
    updatedAt:new Date().toISOString()
  };
  if(!(o.activity>=1 && o.activity<=2.5)) o.activity=d.activity;
  return o;
}
function serializeProfile(p){
  var o=cleanProfile(p);
  var L=["---"];
  L.push("sex: "+fmString(o.sex));
  L.push("age: "+fmNumber(o.age));
  L.push("height: "+fmNumber(o.height));
  L.push("weight: "+fmNumber(o.weight));
  L.push("activity: "+fmNumber(o.activity));
  L.push("tdee: "+fmNumber(o.tdee));
  L.push("goal: "+fmNumber(o.goal));
  L.push("model: "+fmString(o.model));
  L.push("updatedAt: "+fmString(o.updatedAt));
  L.push("---","");
  return L.join("\n");
}
function parseProfile(text){
  var p=defaultProfile();
  var fm=/^---\n([\s\S]*?)\n---\n?/.exec(String(text).replace(/\r\n/g,"\n"));
  if(!fm) return p;
  fm[1].split("\n").forEach(function(line){
    var kv=parseFmLine(line);
    if(!kv) return;
    var k=kv[0], v=kv[1];
    if(k==="sex"||k==="model"||k==="updatedAt") p[k]=String(v);
    else if(k in p) p[k]=num(v);
  });
  return cleanProfile(p);
}

function serializeFoods(list){
  var L=["## 食物",""];
  (list||[]).forEach(function(f){ L.push("- "+JSON.stringify(cleanFood(f))); });
  L.push("");
  return L.join("\n");
}
function parseFoods(text){
  var out=[];
  String(text).replace(/\r\n/g,"\n").split("\n").forEach(function(line){
    var im=/^-\s+(\{.*\})\s*$/.exec(line);
    if(!im) return;
    try{ out.push(cleanFood(JSON.parse(im[1]))); }catch(e){}
  });
  return out;
}

/* ============ 熱量計算 ============ */
/* Mifflin-St Jeor：目前公認誤差最小的靜息代謝率公式 */
function bmrOf(p){
  var base = 10*num(p.weight) + 6.25*num(p.height) - 5*num(p.age);
  return Math.round(base + (p.sex==="female" ? -161 : 5));
}
function tdeeOf(p){
  if(num(p.tdee)>0) return round(p.tdee); /* 手動覆寫優先 */
  return Math.round(bmrOf(p)*num(p.activity));
}
function targetOf(p){ return Math.max(800, tdeeOf(p)+round(p.goal)); }

function sumKcal(list){
  var s=0; (list||[]).forEach(function(x){ s+=num(x.kcal); }); return s;
}
function macrosOf(day){
  var m={p:0,c:0,f:0};
  (day.entries||[]).forEach(function(e){ m.p+=num(e.p); m.c+=num(e.c); m.f+=num(e.f); });
  return { p:Math.round(m.p), c:Math.round(m.c), f:Math.round(m.f) };
}
/* 淨攝取 = 吃進去的 - 額外運動消耗（TDEE 的活動係數已含日常活動，這裡只算「額外」運動） */
function netOf(day){ return sumKcal(day.entries) - sumKcal(day.moves); }

/* ============ DataStore ============ */
var GH = { owner:"xd1104", repo:"lose-weight-helper", branch:"main" };
var IS_LOCAL = ["localhost","127.0.0.1","::1",""].indexOf(location.hostname)>=0;
var FORCE_GH = /[?&]store=github\b/.test(location.search);
var TOKEN_KEY = "lwh_gh_pat";
function getToken(){ try{ return localStorage.getItem(TOKEN_KEY)||""; }catch(e){ return ""; } }
function setToken(t){ try{ localStorage.setItem(TOKEN_KEY,t); }catch(e){} }
function clearToken(){ try{ localStorage.removeItem(TOKEN_KEY); }catch(e){} }

/* 目前是誰在用（Netflix 式切換；只記在這台裝置） */
var CUR_USER_KEY = "lwh_user";
function getCurUserId(){ try{ return localStorage.getItem(CUR_USER_KEY)||""; }catch(e){ return ""; } }
function setCurUserId(id){ try{ localStorage.setItem(CUR_USER_KEY, id||""); }catch(e){} }
function clearCurUserId(){ try{ localStorage.removeItem(CUR_USER_KEY); }catch(e){} }

function uiError(message){ var e=new Error(message); e.userMessage=message; return e; }

/* 每位使用者的檔案位置（兩個 store 共用） */
function pathProfile(u){ return "data/users/"+u+"/profile.md"; }
function pathFoods(u){ return "data/users/"+u+"/foods.md"; }
function pathDay(u, dk){ return "data/users/"+u+"/days/"+dk+".md"; }
var PATH_USERS = "data/users.md";

var LocalStore = {
  local:true,
  canWrite:function(){ return true; },
  _get:function(path, failMsg){
    return fetch(path).then(function(r){
      if(!r.ok) throw uiError(failMsg+"（"+r.status+"）");
      return r.json();
    }).catch(function(e){
      throw (e&&e.userMessage) ? e : uiError("連不到伺服器（server.js 沒開？）");
    });
  },
  _post:function(path, payload, failMsg){
    return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, data:d}; }); })
      .then(function(x){
        if(!x.ok || !x.data || !x.data.ok) throw uiError((x.data&&x.data.message)||failMsg);
        return x.data;
      },function(){ throw uiError("連不到伺服器，"+failMsg); });
  },
  loadUsers:function(){ return this._get("api/users","讀取使用者失敗").then(function(j){ return j.users||[]; }); },
  saveUsers:function(list){ return this._post("api/users", {users:list}, "使用者儲存失敗"); },
  deleteUser:function(id){
    return fetch("api/users/"+encodeURIComponent(id),{method:"DELETE"}).then(function(r){
      if(!r.ok) throw uiError("刪除使用者失敗");
    });
  },
  loadCore:function(u){ return this._get("api/core?u="+encodeURIComponent(u),"讀取設定失敗"); },
  loadDays:function(u, dates){
    if(!dates.length) return Promise.resolve([]);
    return this._get("api/days?u="+encodeURIComponent(u)+"&dates="+encodeURIComponent(dates.join(",")),"讀取紀錄失敗")
      .then(function(j){ return j.days||[]; });
  },
  loadIndex:function(u){
    return this._get("api/days/index?u="+encodeURIComponent(u),"讀取日期清單失敗")
      .then(function(j){ return j.dates||[]; });
  },
  saveDay:function(u, d){ return this._post("api/days", Object.assign({u:u}, d), "紀錄儲存失敗"); },
  saveProfile:function(u, p){ return this._post("api/profile", {u:u, profile:p}, "設定儲存失敗"); },
  saveFoods:function(u, l){ return this._post("api/foods", {u:u, foods:l}, "常吃清單儲存失敗"); }
};

var GitHubStore = {
  local:false,
  rawBase:"https://raw.githubusercontent.com/"+GH.owner+"/"+GH.repo+"/"+GH.branch,
  apiBase:"https://api.github.com/repos/"+GH.owner+"/"+GH.repo,
  _sha:{}, /* path -> 已知 blob sha（PUT/DELETE 要帶） */
  canWrite:function(){ return !!getToken(); },

  _ghFetch:function(url, opts, needAuth){
    var headers=Object.assign({ Accept:"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28" },
      (opts&&opts.headers)||{});
    if(needAuth){
      var token=getToken();
      if(!token) return Promise.reject(uiError("尚未設定 GitHub 金鑰。"));
      headers.Authorization="token "+token;
    }
    var self=this;
    return fetch(url, Object.assign({},opts,{headers:headers})).then(function(res){
      if(res.ok) return res;
      return res.json().catch(function(){return {};}).then(function(body){
        var err=uiError(self._msgForStatus(res.status, body));
        err.status=res.status;
        throw err;
      });
    },function(){ throw uiError("目前離線或連不到 GitHub。"); });
  },
  _msgForStatus:function(status, body){
    if(status===401) return "GitHub 金鑰無效或已過期，請到「設定」重新貼上金鑰。";
    if(status===403) return "GitHub 金鑰權限不足：需 fine-grained PAT，授權 lose-weight-helper repo，Contents 設為 Read and write。";
    if(status===404) return "找不到資源（可能路徑錯或金鑰未授權此 repo）。";
    if(status===409) return "資料版本衝突（有其他裝置剛改過），請重試。";
    if(status===422) return "GitHub 拒絕此次寫入（"+((body&&body.message)||"格式問題")+"）。";
    return "GitHub 錯誤 "+status+"："+((body&&body.message)||"");
  },
  _getFile:function(pathRel){
    var self=this;
    return this._ghFetch(this.apiBase+"/contents/"+pathRel+"?ref="+GH.branch, {}, true)
      .then(function(res){ return res.json(); })
      .then(function(j){ self._sha[pathRel]=j.sha; return {sha:j.sha, text:j.content?b64DecodeUtf8(j.content):""}; })
      .catch(function(e){ if(e.status===404){ delete self._sha[pathRel]; return null; } throw e; });
  },
  /* 唯讀（無金鑰）用 raw CDN：會快取，所以帶時間 cache-buster */
  _getRaw:function(pathRel){
    return fetch(this.rawBase+"/"+pathRel+"?t="+Date.now())
      .then(function(r){ return r.ok ? r.text() : null; })
      .catch(function(){ return null; });
  },
  _readText:function(pathRel){
    if(this.canWrite()){
      return this._getFile(pathRel).then(function(f){ return f?f.text:null; }).catch(function(){ return null; });
    }
    return this._getRaw(pathRel);
  },
  _putFile:function(pathRel, contentB64, message, sha){
    var self=this;
    var body={ message:message, content:contentB64, branch:GH.branch };
    if(sha) body.sha=sha;
    return this._ghFetch(this.apiBase+"/contents/"+pathRel, {method:"PUT", body:JSON.stringify(body)}, true)
      .then(function(res){ return res.json(); })
      .then(function(j){ if(j&&j.content) self._sha[pathRel]=j.content.sha; return j; })
      .catch(function(e){
        if(e.status===409||e.status===422){
          /* sha 過期或缺 sha（檔案已存在）：重取 sha 再試一次，last-write-wins */
          return self._getFile(pathRel).then(function(cur){
            body.sha=cur?cur.sha:undefined;
            return self._ghFetch(self.apiBase+"/contents/"+pathRel, {method:"PUT", body:JSON.stringify(body)}, true)
              .then(function(res){ return res.json(); })
              .then(function(j){ if(j&&j.content) self._sha[pathRel]=j.content.sha; return j; });
          });
        }
        throw e;
      });
  },
  _deleteFile:function(pathRel, message){
    var self=this;
    var doDelete=function(sha){
      if(!sha) return Promise.resolve(); /* 檔案本來就不在 */
      return self._ghFetch(self.apiBase+"/contents/"+pathRel,
        {method:"DELETE", body:JSON.stringify({message:message, sha:sha, branch:GH.branch})}, true)
        .then(function(){ delete self._sha[pathRel]; });
    };
    if(this._sha[pathRel]){
      return doDelete(this._sha[pathRel]).catch(function(){
        return self._getFile(pathRel).then(function(cur){ return doDelete(cur?cur.sha:null); });
      });
    }
    return this._getFile(pathRel).then(function(cur){ return doDelete(cur?cur.sha:null); });
  },
  /* 遞迴刪一個資料夾底下所有檔案（刪除使用者用；Contents API 沒有刪資料夾這種東西） */
  _deleteTree:function(dir, message){
    var self=this;
    return this._ghFetch(this.apiBase+"/contents/"+dir+"?ref="+GH.branch, {}, true)
      .then(function(res){ return res.json(); })
      .catch(function(e){ if(e.status===404) return []; throw e; })
      .then(function(items){
        var list=Array.isArray(items)?items:[];
        /* 逐一刪；子資料夾遞迴。刻意序列化執行：同一棵樹平行刪很容易撞 409 */
        return list.reduce(function(chain, it){
          return chain.then(function(){
            if(it.type==="dir") return self._deleteTree(dir+"/"+it.name, message);
            self._sha[dir+"/"+it.name]=it.sha;
            return self._deleteFile(dir+"/"+it.name, message);
          });
        }, Promise.resolve());
      });
  },

  loadUsers:function(){
    return this._readText(PATH_USERS).then(function(txt){ return txt?parseUsers(txt):[]; });
  },
  saveUsers:function(list){
    return this._putFile(PATH_USERS, b64EncodeUtf8(serializeUsers(list)), "mobile: update users", this._sha[PATH_USERS]||null);
  },
  deleteUser:function(id){
    var self=this;
    return this.loadUsers().then(function(list){
      return self.saveUsers(list.filter(function(u){ return u.id!==id; }));
    }).then(function(){
      return self._deleteTree("data/users/"+id, "mobile: delete user "+id);
    });
  },
  loadCore:function(u){
    var self=this;
    return Promise.all([ self._readText(pathProfile(u)), self._readText(pathFoods(u)) ])
      .then(function(r){
        return { profile: r[0]?parseProfile(r[0]):defaultProfile(),
                 foods:   r[1]?parseFoods(r[1]):[] };
      });
  },
  loadDays:function(u, dates){
    var self=this;
    /* 一天一個請求、平行打。刻意不列整個 days 資料夾：
     * 那會隨著使用月數線性增加請求數，手機上會越用越慢。 */
    return Promise.all(dates.map(function(dk){
      return self._readText(pathDay(u, dk))
        .then(function(txt){ return txt ? parseDay(dk, txt) : emptyDay(dk); })
        .catch(function(){ return emptyDay(dk); });
    }));
  },
  loadIndex:function(u){
    var hasKey=this.canWrite();
    return this._ghFetch(this.apiBase+"/contents/data/users/"+u+"/days?ref="+GH.branch, {}, hasKey)
      .then(function(res){ return res.json(); })
      .catch(function(e){ if(e.status===404) return []; throw e; })
      .then(function(files){
        return (Array.isArray(files)?files:[])
          .filter(function(f){ return /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name); })
          .map(function(f){ return f.name.replace(/\.md$/,""); }).sort();
      })
      .catch(function(){ return []; });
  },
  saveDay:function(u, d){
    var pathRel=pathDay(u, d.date);
    d.updatedAt=new Date().toISOString();
    var isEmpty=!(d.entries||[]).length && !(d.moves||[]).length
      && !String(d.notes||"").trim() && !num(d.weight);
    if(isEmpty) return this._deleteFile(pathRel, "mobile: clear "+d.date);
    return this._putFile(pathRel, b64EncodeUtf8(serializeDay(d)), "mobile: log "+d.date, this._sha[pathRel]||null);
  },
  saveProfile:function(u, p){
    var pathRel=pathProfile(u);
    return this._putFile(pathRel, b64EncodeUtf8(serializeProfile(p)), "mobile: update profile", this._sha[pathRel]||null);
  },
  saveFoods:function(u, l){
    var pathRel=pathFoods(u);
    return this._putFile(pathRel, b64EncodeUtf8(serializeFoods(l)), "mobile: update foods", this._sha[pathRel]||null);
  }
};

var STORE = (IS_LOCAL && !FORCE_GH) ? LocalStore : GitHubStore;
