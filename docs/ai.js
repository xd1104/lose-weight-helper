"use strict";
/*
 * 減重助手 — AI 熱量估算（直接打 Anthropic Messages API）
 *
 * 為什麼前端直連而不經自己的 server：
 *   本 app 的 PWA 跑在 GitHub Pages（純靜態、沒有後端），手機在外面吃飯要即時判讀，
 *   不能依賴家裡電腦有沒有開機。Anthropic API 有開放瀏覽器直連，
 *   但必須帶 anthropic-dangerous-direct-browser-access 這個 header 才會過 CORS。
 * 代價（已知並接受）：
 *   API key 存在這台手機的 localStorage，任何拿到這支手機的人都能看到。
 *   → key 只在自己的裝置上放，並且到 console.anthropic.com 設每月花費上限。
 *   → key 絕不寫進程式、絕不 commit（同 GitHub PAT 的規矩）。
 */

var AI_KEY = "lwh_anthropic_key";
var AI_USAGE_KEY = "lwh_ai_usage";
var USD_TWD = 32; /* 粗估用，不需要精準匯率 */

/* 價格 USD / 每百萬 token（input, output）。改模型記得一起改，這只影響「花費估算」顯示。 */
var AI_MODELS = [
  { id:"claude-sonnet-5",  label:"Sonnet 5",  hint:"預設 · 準度與成本最平衡", in:3, out:15 },
  { id:"claude-opus-5",    label:"Opus 5",    hint:"最準 · 約 1.7 倍價格",    in:5, out:25 },
  { id:"claude-haiku-4-5", label:"Haiku 4.5", hint:"最快最便宜 · 準度略低",   in:1, out:5  }
];
function aiModelInfo(id){
  for(var i=0;i<AI_MODELS.length;i++) if(AI_MODELS[i].id===id) return AI_MODELS[i];
  return AI_MODELS[0];
}

function getAiKey(){ try{ return localStorage.getItem(AI_KEY)||""; }catch(e){ return ""; } }
function setAiKey(k){ try{ localStorage.setItem(AI_KEY, k); }catch(e){} }
function clearAiKey(){ try{ localStorage.removeItem(AI_KEY); }catch(e){} }
function hasAiKey(){ return !!getAiKey(); }

/* ---- 本月用量／花費估算（只存在本機，不同步） ---- */
function ymNow(){ var d=new Date(); return d.getFullYear()+"-"+(d.getMonth()<9?"0":"")+(d.getMonth()+1); }
function readUsage(){
  try{
    var u=JSON.parse(localStorage.getItem(AI_USAGE_KEY)||"{}");
    if(u.ym!==ymNow()) return { ym:ymNow(), calls:0, inTok:0, outTok:0, usd:0 };
    return { ym:u.ym, calls:+u.calls||0, inTok:+u.inTok||0, outTok:+u.outTok||0, usd:+u.usd||0 };
  }catch(e){ return { ym:ymNow(), calls:0, inTok:0, outTok:0, usd:0 }; }
}
function addUsage(modelId, usage){
  if(!usage) return;
  var m=aiModelInfo(modelId), u=readUsage();
  /* 快取讀寫也是 input，一起算進去才不會低估 */
  var inTok=(+usage.input_tokens||0)+(+usage.cache_read_input_tokens||0)+(+usage.cache_creation_input_tokens||0);
  var outTok=(+usage.output_tokens||0);
  u.calls+=1; u.inTok+=inTok; u.outTok+=outTok;
  u.usd += inTok/1e6*m.in + outTok/1e6*m.out;
  try{ localStorage.setItem(AI_USAGE_KEY, JSON.stringify(u)); }catch(e){}
}
function usageText(){
  var u=readUsage();
  if(!u.calls) return "本月還沒用過";
  return "本月 "+u.calls+" 次 · 約 NT$ "+(u.usd*USD_TWD).toFixed(1);
}

/* ---- 提示詞 ---- */
var AI_SYSTEM = [
  "你是熟悉台灣飲食的營養估算助手。使用者會用口語描述剛吃的東西，或直接給一張餐點照片。",
  "你的工作是估出熱量與三大營養素，讓他知道今天有沒有超過 TDEE。",
  "",
  "規則：",
  "1. 以台灣的常見份量為基準：自助餐、便當、麵店、早餐店、手搖飲、超商。除非使用者說了份量，否則用一般成人單人份。",
  "2. 口語份量要照著調整：「加飯」白飯多算一份、「大碗」約 1.3 倍、「小碗」約 0.7 倍、「半糖」糖量減半、「去冰」不影響熱量。",
  "3. 照片裡每一樣可分辨的食物各給一個 item（例如排骨便當要拆成排骨、白飯、配菜）。純文字描述若包含多樣食物也要拆開。",
  "4. portion 欄寫出你採用的份量假設，要具體，例如「便當盒大小、白飯約 1.5 碗」「700ml 中杯」。使用者要能一眼看出你是不是估錯份量。",
  "5. 一定要給數字。資訊不足時取合理中位數，用 confidence 表達不確定，不要拒答也不要回 0。",
  "6. kcal 是大卡、protein/carbs/fat 是公克，全部給整數。",
  "7. note 用一句繁體中文說明最關鍵的假設或提醒（例如「醬汁與炒油抓得較保守，實際可能再高 100 大卡」）。",
  "8. 全部用繁體中文，食物名稱用台灣慣用說法。"
].join("\n");

/* 結構化輸出 schema：強制回傳可直接落檔的形狀，不用解析自由文字 */
var AI_SCHEMA = {
  type:"object",
  properties:{
    items:{
      type:"array",
      items:{
        type:"object",
        properties:{
          name:{ type:"string", description:"食物名稱，繁體中文" },
          portion:{ type:"string", description:"採用的份量假設" },
          kcal:{ type:"integer", description:"熱量（大卡）" },
          protein:{ type:"integer", description:"蛋白質（公克）" },
          carbs:{ type:"integer", description:"碳水化合物（公克）" },
          fat:{ type:"integer", description:"脂肪（公克）" },
          confidence:{ type:"string", enum:["high","medium","low"], description:"估算把握度" }
        },
        required:["name","portion","kcal","protein","carbs","fat","confidence"],
        additionalProperties:false
      }
    },
    note:{ type:"string", description:"一句話說明主要假設" }
  },
  required:["items","note"],
  additionalProperties:false
};

function aiError(message, code){ var e=new Error(message); e.userMessage=message; e.code=code||""; return e; }

function aiMsgForStatus(status, body){
  var m=(body&&body.error&&body.error.message)||"";
  if(status===401) return "API key 無效或已撤銷，請到「設定」重新貼上。";
  if(status===400) return "AI 拒絕了這個請求："+(m||"格式問題");
  if(status===403) return "這把 API key 沒有權限使用此模型。";
  if(status===404) return "找不到模型（"+(m||"模型 id 可能已變更")+"）。";
  if(status===413) return "照片太大了，請重拍或換一張。";
  if(status===429) return "太頻繁或已達用量上限，等一下再試。";
  if(status>=500) return "Anthropic 服務忙碌中，稍後再試一次。";
  return "AI 錯誤 "+status+"："+m;
}

/* 送出一次 Messages 請求，回傳 parse 過的結果 */
function aiRequest(model, contentBlocks){
  var key=getAiKey();
  if(!key) return Promise.reject(aiError("還沒設定 API key，到「設定」貼上就能用 AI 判讀。","nokey"));

  var body={
    model: model,
    max_tokens: 4000,           /* 含 thinking，留寬一點避免估到一半被截斷 */
    system: AI_SYSTEM,
    output_config: {
      effort: "low",            /* 這是簡單估算，不需要深度推理；省時間也省錢 */
      format: { type:"json_schema", schema: AI_SCHEMA }
    },
    messages: [{ role:"user", content: contentBlocks }]
  };

  return fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "content-type":"application/json",
      "x-api-key":key,
      "anthropic-version":"2023-06-01",
      /* 沒有這個 header，瀏覽器直連會被 CORS 擋掉 */
      "anthropic-dangerous-direct-browser-access":"true"
    },
    body: JSON.stringify(body)
  }).then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(j){
      if(!res.ok) throw aiError(aiMsgForStatus(res.status, j), "http"+res.status);
      return j;
    });
  }, function(){
    throw aiError("連不到 Anthropic（目前離線？）","offline");
  }).then(function(j){
    addUsage(model, j.usage);
    if(j.stop_reason==="refusal") throw aiError("AI 拒絕回答這個內容，請換個描述或照片。","refusal");
    if(j.stop_reason==="max_tokens") throw aiError("AI 回覆被截斷了，請再試一次。","truncated");
    return parseAiResult(j);
  });
}

function parseAiResult(j){
  var text="";
  (j.content||[]).forEach(function(b){ if(b.type==="text") text+=b.text; });
  var data=null;
  try{ data=JSON.parse(text); }
  catch(e){
    /* 結構化輸出理論上就是純 JSON，這是保險：撈出第一個 {...} 再試一次 */
    var m=/\{[\s\S]*\}/.exec(text);
    if(m){ try{ data=JSON.parse(m[0]); }catch(e2){} }
  }
  if(!data || !Array.isArray(data.items) || !data.items.length){
    throw aiError("AI 這次沒認出食物，換個講法或補一張清楚的照片試試。","empty");
  }
  var items=data.items.map(function(it){
    return {
      id: uid(),
      name: String(it.name||"未命名").slice(0,60),
      portion: String(it.portion||"").slice(0,80),
      kcal: Math.max(0, round(it.kcal)),
      p: Math.max(0, round(it.protein)),
      c: Math.max(0, round(it.carbs)),
      f: Math.max(0, round(it.fat)),
      confidence: ({high:"high",medium:"medium",low:"low"})[it.confidence] || "medium",
      src: "ai"
    };
  });
  return { items:items, note:String(data.note||"").slice(0,200) };
}

/* ---- 對外：文字 ---- */
function aiAnalyzeText(model, text){
  var t=String(text||"").trim();
  if(!t) return Promise.reject(aiError("先描述一下吃了什麼。","empty-input"));
  return aiRequest(model, [{ type:"text", text:"我剛吃了：" + t }]);
}

/* ---- 對外：照片 ---- */
/* 圖片放在文字前面（官方建議的順序，照片題型準度較好） */
function aiAnalyzePhoto(model, dataUrl, hint){
  var m=/^data:(image\/[a-z+]+);base64,(.*)$/i.exec(String(dataUrl||""));
  if(!m) return Promise.reject(aiError("照片讀取失敗，請重選一張。","bad-image"));
  var blocks=[{ type:"image", source:{ type:"base64", media_type:m[1], data:m[2] } }];
  var t=String(hint||"").trim();
  blocks.push({ type:"text", text: t
    ? "這是我剛吃的東西。補充資訊：" + t
    : "這是我剛吃的東西，幫我估熱量。" });
  return aiRequest(model, blocks);
}

/* ---- 照片壓縮：長邊 1024px、JPEG 0.85 ----
 * 手機原圖動輒 4000px / 4MB，直接送上去又慢又貴（圖片 token 隨解析度增加）。
 * 1024px 對「這盤是什麼、大概多少」已經非常夠用。 */
function compressImage(file, maxEdge, quality){
  maxEdge = maxEdge || 1024;
  quality = quality || 0.85;
  return new Promise(function(resolve, reject){
    var url=URL.createObjectURL(file);
    var img=new Image();
    img.onload=function(){
      try{
        var w=img.naturalWidth, h=img.naturalHeight;
        var scale=Math.min(1, maxEdge/Math.max(w,h));
        var cw=Math.max(1, Math.round(w*scale)), ch=Math.max(1, Math.round(h*scale));
        var cv=document.createElement("canvas");
        cv.width=cw; cv.height=ch;
        cv.getContext("2d").drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL("image/jpeg", quality));
      }catch(e){
        URL.revokeObjectURL(url);
        reject(aiError("照片處理失敗，請換一張。","bad-image"));
      }
    };
    img.onerror=function(){
      URL.revokeObjectURL(url);
      reject(aiError("這個檔案不是可讀的圖片。","bad-image"));
    };
    img.src=url;
  });
}
