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

/* 降級用：沒有 structured outputs 時，靠提示詞把形狀講死 */
var AI_JSON_FALLBACK = [
  "只輸出一段 JSON，不要加任何說明文字、不要用 markdown 的程式碼框。格式：",
  '{"items":[{"name":"食物名稱","portion":"份量假設","kcal":0,"protein":0,"carbs":0,"fat":0,"confidence":"high|medium|low"}],"note":"一句話說明"}'
].join("\n");

/* ---- 運動：估「額外」消耗 ---- */
/* 關鍵：要的是「淨消耗」。TDEE 的活動係數已經涵蓋那段時間的靜息代謝，
 * 一般 app 報的是總消耗（含靜息），直接拿來扣就會系統性高估、變成怎麼練都瘦不下來。 */
var AI_MOVE_SYSTEM = [
  "你是運動生理的熱量估算助手。使用者會用口語描述剛做完的運動，你要估出消耗的熱量。",
  "",
  "規則：",
  "1. 用 MET 值估算：kcal = MET × 體重(kg) × 時數。使用者的體重會在訊息裡給你。",
  "2. **回傳「淨消耗」**：從總消耗扣掉同一段時間的靜息代謝（約 1 MET）。",
  "   也就是實際用 (MET - 1) × 體重 × 時數。這一點很重要，因為使用者的每日總消耗 TDEE",
  "   已經包含了那段時間本來就會燒的基礎代謝，不扣掉會重複計算。",
  "3. 沒說時長就用該運動最常見的一次時長，並在 detail 裡寫明你假設了多久。",
  "4. 沒說強度就用中等強度。「認真練」「衝刺」「爆汗」往高的抓，「散步」「輕鬆」往低的抓。",
  "5. 重訓類要考慮組間休息，實際 MET 比想像低（一般 3–6，不是 8）。",
  "6. detail 要寫出你用的假設：時長、強度、MET、體重。使用者要能一眼看出你是不是抓錯。",
  "7. 台灣常見的講法要聽得懂：飛輪、有氧、TRX、拳擊有氧、爬象山、河濱騎車、健身房滑步機。",
  "8. 一定要給數字，不確定就取中位數並用 confidence 表達。全部用繁體中文。"
].join("\n");

var AI_MOVE_SCHEMA = {
  type:"object",
  properties:{
    name:{ type:"string", description:"整理過的運動名稱，含時長，例如「飛輪 45 分」" },
    detail:{ type:"string", description:"採用的假設：時長、強度、MET、體重" },
    kcal:{ type:"integer", description:"淨消耗（已扣掉同時間的靜息代謝），大卡" },
    met:{ type:"number", description:"採用的 MET 值" },
    confidence:{ type:"string", enum:["high","medium","low"] }
  },
  required:["name","detail","kcal","met","confidence"],
  additionalProperties:false
};

/* ---- 今天吃得怎樣（營養師） ----
 * 刻意要求「講他今天實際吃的東西」而不是通則：
 * 「多吃蛋白質」誰都會講，「午餐那盤燙青菜換成滷雞腿」才有辦法照做。 */
var AI_COACH_SYSTEM =
  "你是台灣的營養師，正在看使用者今天的飲食紀錄，給一段簡短、務實的回饋。\n"+
  "原則：\n"+
  "1. 一律用繁體中文，台灣用語。\n"+
  "2. 具體到「哪一餐的哪一樣」，並用台灣常見、買得到的食物給替代方案"+
  "（超商、自助餐、便當店、小吃攤都可以）。不要只說「多吃蛋白質」這種空話。\n"+
  "3. 語氣像朋友，不要說教、不要恐嚇、不要用「應該」「必須」。就算今天吃很差也先講一個做得好的地方。\n"+
  "4. 熱量與三大營養素的數字我已經算好給你了，不要重算，也不要把數字整串複述一遍。\n"+
  "5. 如果一天還沒過完（會告訴你現在幾點、還剩多少額度），建議要針對「接下來那一餐」；"+
  "如果已經是晚上或看的是過去的日子，就給「明天可以怎麼調整」。\n"+
  "6. 每一點都要短，手機上看得完。";

var AI_COACH_SCHEMA = {
  type:"object",
  properties:{
    verdict:{ type:"string", description:"一句話總評，20 個中文字以內，例如「熱量守得不錯，但油脂偏高」" },
    good:{ type:"array", items:{ type:"string" },
      description:"今天做得好的地方，1-2 點，每點 30 字內，要指名實際吃的東西" },
    issues:{ type:"array", items:{ type:"string" },
      description:"可以更好的地方，1-3 點，每點 40 字內，要指名是哪一餐的哪一樣，並給具體替代方案" },
    next:{ type:"string", description:"接下來那一餐（或明天）的具體建議，50 字內，直接講可以吃什麼" }
  },
  required:["verdict","good","issues","next"],
  additionalProperties:false
};

/* 這一支不共用 aiRequest：system 與 schema 都不一樣（aiRequest 綁的是「估熱量」那組） */
function aiCoachDay(model, userText){
  var key=getAiKey();
  if(!key) return Promise.reject(aiError("還沒設定 API key，到「設定」貼上就能用。","nokey"));
  var body={
    model: model,
    max_tokens: 2000,
    system: AI_COACH_SYSTEM,
    messages: [{ role:"user", content:[{ type:"text", text:String(userText||"") }] }],
    output_config: outputConfigFor(model, AI_COACH_SCHEMA)
  };
  return fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "content-type":"application/json",
      "x-api-key":key,
      "anthropic-version":"2023-06-01",
      "anthropic-dangerous-direct-browser-access":"true"
    },
    body: JSON.stringify(body)
  }).then(function(res){
    if(res.ok) return res.json();
    return res.json().catch(function(){ return {}; }).then(function(j){
      throw aiError(aiMsgForStatus(res.status, j), "http"+res.status);
    });
  },function(){ throw aiError("連不到 Anthropic，檢查一下網路。","offline"); })
  .then(function(j){
    addUsage(model, j.usage);
    var txt="";
    (j.content||[]).forEach(function(b){ if(b.type==="text") txt+=b.text; });
    var o=null;
    try{ o=JSON.parse(txt); }
    catch(e){ var mm=/\{[\s\S]*\}/.exec(txt); if(mm){ try{ o=JSON.parse(mm[0]); }catch(e2){} } }
    if(!o || !o.verdict) throw aiError("AI 回傳的內容看不懂，再試一次。","bad-json");
    return {
      verdict:String(o.verdict||""),
      good:(o.good||[]).map(String).slice(0,3),
      issues:(o.issues||[]).map(String).slice(0,4),
      next:String(o.next||"")
    };
  });
}

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

/* output_config 的 effort 目前只有推理型模型吃得下，Haiku 4.5 會直接回 400。
 * 不先擋掉的話，選 Haiku 的人每次都會白打一次請求才降級（慢、又多算一次 usage）。 */
function outputConfigFor(model, schema){
  var cfg={ format:{ type:"json_schema", schema:schema } };
  if(!/^claude-haiku/.test(String(model||""))) cfg.effort="low"; /* 簡單估算，不需要深度推理；省時間也省錢 */
  return cfg;
}

/* 送出一次 Messages 請求，回傳 parse 過的結果。
 * plain=true 時不用 structured outputs，改在 system 裡要求純 JSON。
 * 這是降級路徑：萬一 output_config 的形狀被 API 拒絕（400），
 * 使用者不該直接看到「AI 拒絕了這個請求」然後整個功能不能用。 */
function aiRequest(model, contentBlocks, plain){
  var key=getAiKey();
  if(!key) return Promise.reject(aiError("還沒設定 API key，到「設定」貼上就能用 AI 判讀。","nokey"));

  var body={
    model: model,
    max_tokens: 4000,           /* 含 thinking，留寬一點避免估到一半被截斷 */
    system: AI_SYSTEM + (plain ? "\n\n" + AI_JSON_FALLBACK : ""),
    messages: [{ role:"user", content: contentBlocks }]
  };
  if(!plain) body.output_config = outputConfigFor(model, AI_SCHEMA);

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
      if(!res.ok){
        /* 400 且還沒降級過 -> 很可能是 output_config 的形狀不被接受，改用純 JSON 再試一次 */
        if(res.status===400 && !plain){
          return aiRequest(model, contentBlocks, true).then(function(r){ return {__done:r}; });
        }
        throw aiError(aiMsgForStatus(res.status, j), "http"+res.status);
      }
      return j;
    });
  }, function(){
    throw aiError("連不到 Anthropic（目前離線？）","offline");
  }).then(function(j){
    if(j && j.__done) return j.__done; /* 降級那條路已經 parse 完了 */
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

/* ---- 對外：運動 ---- */
function aiAnalyzeMove(model, text, profile){
  var t=String(text||"").trim();
  if(!t) return Promise.reject(aiError("先描述做了什麼運動。","empty-input"));
  var w=Math.round(Number(profile&&profile.weight)||70);
  var who=(profile&&profile.sex)==="female"?"女性":"男性";
  var age=Math.round(Number(profile&&profile.age)||30);
  return aiMoveRequest(model, "我是 "+age+" 歲"+who+"、體重 "+w+" 公斤。剛做完：" + t);
}

var AI_MOVE_JSON_FALLBACK = [
  "只輸出一段 JSON，不要加任何說明文字、不要用 markdown 的程式碼框。格式：",
  '{"name":"運動名稱含時長","detail":"時長/強度/MET/體重的假設","kcal":0,"met":0,"confidence":"high|medium|low"}'
].join("\n");

function aiMoveRequest(model, userText, plain){
  var key=getAiKey();
  if(!key) return Promise.reject(aiError("還沒設定 API key，到「設定」貼上就能用 AI 判讀。","nokey"));
  var body={
    model: model,
    max_tokens: 2000,
    system: AI_MOVE_SYSTEM + (plain ? "\n\n" + AI_MOVE_JSON_FALLBACK : ""),
    messages: [{ role:"user", content:[{ type:"text", text:userText }] }]
  };
  if(!plain) body.output_config = outputConfigFor(model, AI_MOVE_SCHEMA);
  return fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "content-type":"application/json",
      "x-api-key":key,
      "anthropic-version":"2023-06-01",
      "anthropic-dangerous-direct-browser-access":"true"
    },
    body: JSON.stringify(body)
  }).then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(j){
      if(!res.ok){
        if(res.status===400 && !plain){
          return aiMoveRequest(model, userText, true).then(function(r){ return {__done:r}; });
        }
        throw aiError(aiMsgForStatus(res.status, j), "http"+res.status);
      }
      return j;
    });
  }, function(){
    throw aiError("連不到 Anthropic（目前離線？）","offline");
  }).then(function(j){
    if(j && j.__done) return j.__done;
    addUsage(model, j.usage);
    if(j.stop_reason==="refusal") throw aiError("AI 拒絕回答這個內容。","refusal");
    var txt="";
    (j.content||[]).forEach(function(bk){ if(bk.type==="text") txt+=bk.text; });
    var data=null;
    try{ data=JSON.parse(txt); }
    catch(e){ var m=/\{[\s\S]*\}/.exec(txt); if(m){ try{ data=JSON.parse(m[0]); }catch(e2){} } }
    if(!data || !data.name || !isFinite(Number(data.kcal))){
      throw aiError("AI 這次看不懂這個運動，換個講法試試。","empty");
    }
    return {
      name: String(data.name).slice(0,60),
      detail: String(data.detail||"").slice(0,120),
      kcal: Math.max(0, round(data.kcal)),
      met: Number(data.met)||0,
      confidence: ({high:"high",medium:"medium",low:"low"})[data.confidence] || "medium"
    };
  });
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

/* 只重估「其中一項」。
 * 照片一起送是關鍵——使用者最常遇到的是「東西認錯了」（叉燒被當成燒鴨），
 * 光靠文字 AI 看不到真正的份量，帶著原圖它才有辦法一邊看圖一邊修正。
 * 刻意告訴它「其他項目不用列」，回來才只換掉那一項。 */
function aiAnalyzeOne(model, dataUrl, wrongName, said){
  var blocks=[];
  if(dataUrl){
    var m=/^data:(image\/[a-z+]+);base64,(.*)$/i.exec(String(dataUrl));
    if(m) blocks.push({ type:"image", source:{ type:"base64", media_type:m[1], data:m[2] } });
  }
  var t=blocks.length
    ? "這張照片你剛才幫我拆成好幾項，其中一項判斷錯了。只要重新估那一項，其他項目不用列出來。\n"
    : "幫我估一項東西的熱量。\n";
  if(wrongName) t+="你原本判斷成：「"+String(wrongName)+"」\n";
  t+="正確的是：「"+String(said)+"」\n"+
     "請只回這一項；除非這句話明顯包含兩樣以上的東西，才拆成多項。";
  blocks.push({ type:"text", text:t });
  return aiRequest(model, blocks);
}

/* ---- 照片壓縮：長邊 1024px、JPEG 0.85 ----
 * 手機原圖動輒 4000px / 4MB，直接送上去又慢又貴（圖片 token 隨解析度增加）。
 * 1024px 對「這盤是什麼、大概多少」已經非常夠用。 */
function compressImage(file, maxEdge, quality){
  maxEdge = maxEdge || 1024;
  quality = quality || 0.85;

  function toDataUrl(src, w, h){
    var scale=Math.min(1, maxEdge/Math.max(w,h));
    var cw=Math.max(1, Math.round(w*scale)), ch=Math.max(1, Math.round(h*scale));
    var cv=document.createElement("canvas");
    cv.width=cw; cv.height=ch;
    cv.getContext("2d").drawImage(src, 0, 0, cw, ch);
    return cv.toDataURL("image/jpeg", quality);
  }

  /* 舊路徑：<img> + canvas。注意這條路徑「不會」照 EXIF 轉正 */
  function viaImage(){
    return new Promise(function(resolve, reject){
      var url=URL.createObjectURL(file);
      var img=new Image();
      img.onload=function(){
        try{
          var out=toDataUrl(img, img.naturalWidth, img.naturalHeight);
          URL.revokeObjectURL(url);
          resolve(out);
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

  /* 優先走 createImageBitmap({imageOrientation:"from-image"})：會照 EXIF 轉正。
   * iPhone 直向拍的照片 EXIF orientation 常常是 6，不轉正就會躺著送給 AI，判讀會變差。 */
  if(typeof createImageBitmap==="function"){
    try{
      return createImageBitmap(file, { imageOrientation:"from-image" }).then(function(bmp){
        var out=toDataUrl(bmp, bmp.width, bmp.height);
        if(bmp.close) bmp.close();
        return out;
      }, viaImage);
    }catch(e){ return viaImage(); }
  }
  return viaImage();
}
