# lose-weight-helper（減重助手）— 專案備忘（給接手的 AI／開發者）

手機優先的每日熱量記錄 PWA。**兩個人共用一份 app（Benson 與女友），資料完全獨立。**
吃完用講的或拍一張照，Claude 估熱量，一眼看出今天有沒有超過 TDEE。
架構刻意比照 `travel-book`（同一位作者的旅遊 PWA），兩邊的慣例一致，改動前先看那邊有沒有既有做法。

## 多使用者（v2 拍板，別自作主張合併）
- **完全獨立**：紀錄、TDEE、目標、常吃清單全部各自一份，**刻意不共用、不互看**。
  曾評估過「常吃清單共用省 API 錢」與「熱量互看有激勵效果」，Benson 拍板都不要。要改回來需要他再拍板。
- **Netflix 式切換**：進 app 先選人（`picking=true` 的全螢幕 picker），選過之後這台裝置記在
  localStorage `lwh_user`，之後直接進那個人的畫面；點右上頭像回到選人畫面。
- `me` 是目前使用者物件，`users` 是名冊。**每一個 STORE 呼叫都要帶 `me.id`**。
- **切換使用者時整個 `db` 打掉重建**（`switchUser`），不可沿用上一位的 `days` 快取，否則會看到別人的紀錄。
- 非同步載入都有 **`if(me.id!==u) return` 的守門**：切人切很快時，上一位的回應不可以蓋掉現在這位的畫面。
- `persistChains` 的 key 一律前綴 uid，兩個人的寫入不會排進同一條鏈。
- **AI key 與 GitHub PAT 綁「裝置」不綁使用者**（同一支手機兩個人共用一把），這是刻意的。

## 架構（三層，比照 travel-book — 別打破）
- **電腦本機 Node App＝真本**：`server.js`（零執行期依賴，**port 3619**），服務 `public/` 前端＋`/api` CRUD，資料存本機 md 檔。
- **GitHub repo `xd1104/lose-weight-helper`（main）＝同步中樞＋雲端備份**：本機寫入後自動 `git add/commit` → `pull --no-rebase -X ours` → `push`；啟動時也 pull。
- **GitHub Pages（main `/docs`）＝手機 PWA**：`build.js` 從 `public/` 鏡射到 `docs/`。**docs/ 是產物，別手改**。

## 前端 DataStore（`public/store.js`；依 `location.hostname` 自動切；`?store=github` 可強制測 GitHub 模式）
- **localhost → LocalStore**：打本機 `/api`，全功能。
- **非 localhost（Pages）→ GitHubStore**：**有 PAT** 走認證 Contents API 讀寫（即時；PUT/DELETE 帶 sha、base64、409/422 自動重取 sha 重試一次）；**無 PAT** 唯讀走 raw＋`?t=<now>` cache-buster。
- **刻意「按日期取檔」而不是列整個 days 資料夾**：列資料夾的請求數會隨著使用月數線性成長，手機上會越用越慢。首頁只載入「當日 + 前 6 天」，歷史頁才另外抓 index＋最近 30 天。改回列全部＝效能退步。

## 同步（別誤改的決策）
- 同檔衝突：**固定電腦版本勝（`-X ours`）**——沿用 travel-book「電腦是真本」的選擇。
- 同步失敗絕不影響本機存檔（只記 log）。`AUTO_SYNC=0` 可關（測試用）。
- **`initSync()` 會先檢查 `ROOT/.git` 存在才啟用**：這道守門是刻意的。本專案曾被放在別的 repo 的子資料夾裡暫存，沒有它會把那個 repo 整包 `add -A` / push 出去。

## 金鑰（安全）
- **Anthropic API key**：存 localStorage（key **`lwh_anthropic_key`**），只在該裝置。前端直連 `api.anthropic.com`，**必須帶 `anthropic-dangerous-direct-browser-access: true`**，否則 CORS 擋掉。
  - 這是明知的取捨：PWA 在 Pages 上沒有後端，而「在外面吃飯當下就要知道熱量」不能依賴家裡電腦有沒有開機。要降風險就到 console 設每月花費上限。
  - **絕不寫進程式、絕不 commit。**
- **GitHub PAT**：fine-grained、只授權 `lose-weight-helper` 一個 repo 的 Contents 讀寫，存 localStorage（key **`lwh_gh_pat`**）。設定入口只在非 localhost 顯示。

## 資料格式（定案；前後端各有一套 mirror parser，改要一起改）
- **檔案佈局**（v2 起每個人一個資料夾）：
  ```
  data/users.md                              名冊：## 使用者 下每行 {id,name,emoji,color,createdAt}
  data/users/<uid>/profile.md                身體資料／目標／模型
  data/users/<uid>/foods.md                  常吃清單
  data/users/<uid>/days/YYYY-MM-DD.md        每天一個檔
  ```
  - `<uid>` = `<ts36>-<slug(名字)>`。**`safeName` 與前端 `slugify` 必須是同一個字元集（`\p{L}\p{N}` ＋ `._-`）**——
    不一致時中文／日文名字會在兩端被 mangle 成不同資料夾，同一個人跨裝置分裂成兩份資料（travel-book QA B1 的教訓，測試裡有專門一條在守）。
  - 名冊裡 **id 重複只留第一個**（`normalizeUsers`），避免兩個人指到同一個資料夾。
  - 刪除使用者＝連同整個資料夾刪掉；GitHubStore 沒有「刪資料夾」這種 API，所以 `_deleteTree` 遞迴逐檔刪、**刻意序列化執行**（平行刪同一棵樹很容易撞 409）。
  - **v1→v2 遷移**：server 啟動時若看到舊的 `data/profile.md` 而沒有 `data/users.md`，會把單人資料搬進一位叫「我」的使用者。冪等，`users.md` 存在就完全不動。
- **每天一個 `days/YYYY-MM-DD.md`**（檔名就是唯一 key；server 的 `safeDate` 只收嚴格 `YYYY-MM-DD`，順便擋 path traversal）。
  - frontmatter：`date/weight/updatedAt`（字串 JSON-quoted、數字裸寫）＋三段 body：
  - `## 飲食` → 每行 `- {id,time,meal,name,kcal,p,c,f,portion,note,src}`（key 順序固定、空值不寫）
    - `meal`：`breakfast|lunch|dinner|snack`，未知值一律落到 `snack`（**不可讓資料消失**）
    - `src`：`ai|manual|preset`（保留來源，之後才能回頭檢討 AI 估算準度——別當死碼清掉）
  - `## 運動` → 每行 `- {id,time,name,kcal}`
  - `## 備註` → **永遠最後一段、整段原樣文字**（parser 進入後不再解析 heading，所以備註裡打 `##` 不會壞）
- **`profile.md`**：frontmatter `sex/age/height/weight/activity/tdee/goal/model`。
  - `tdee` = 0 表示「用 Mifflin-St Jeor 自動算」，>0 = 手動覆寫。`goal` 是每日加減（負數＝減脂缺口）。
  - `cleanProfile` 會把離譜數值夾回合理範圍（活動係數超出 1–2.5 落回預設），避免算出負的熱量目標。
- **`foods.md`**：`## 食物` 下每行 `- {id,name,kcal,p,c,f,portion,n}`。`n` = 用過次數，是「常吃」清單的排序依據。
  - **這是省錢機制**：AI 算過一次就記起來，同樣的東西下次直接點，不用再花 API 錢。上限 200 筆。**兩個人的清單是分開的**（拍板的決定）。
- **一整天被清空 → 直接刪檔**（不留空殼 md）。GitHubStore 那邊對應 `_deleteFile`。
- **`.gitattributes` 強制 md/js/css/html/json 為 LF**；前後端 parser 開頭都先 `replace(/\r\n/g,'\n')`。壞的 JSON 行 parser 會跳過該行（不整檔炸掉）。

## AI（`public/ai.js`）
- 模型可選 Sonnet 5 / Opus 5 / Haiku 4.5，存在 profile（跟著同步）。**預設 Sonnet 5**：這是估算題不是推理題，Sonnet 的準度夠而成本約 Opus 的 6 折。要更準就在設定切 Opus 5。
- **用 structured outputs（`output_config.format` + json_schema）**，不是叫模型「回 JSON」再自己 parse 自由文字。`effort: "low"`（簡單估算，不需要深度推理，省時間也省錢）。
- **`max_tokens: 4000` 是含 thinking 的**，調小會出現估到一半被截斷。
- 回傳每個食物都帶 `portion`（份量假設）與 `confidence`。**UI 一定要把 portion 顯示出來**——使用者要能一眼看出 AI 是不是份量抓錯，這是這個 app 可信度的關鍵。
- 結果一律先進「可編輯的預覽」，使用者確認才寫入。**不要改成直接寫入**。
- 照片先壓到長邊 1024px / JPEG 0.85 再送。手機原圖 4000px 又慢又貴（圖片 token 隨解析度增加），1024px 對「這盤是什麼、大概多少」已經非常夠。
- **不存原始照片**：資料在 git repo 裡，塞 base64 照片會讓 repo 迅速膨脹。只留 AI 判讀結果。
- 本機用量／花費估算存 localStorage `lwh_ai_usage`（只是估算顯示用，帳以 Anthropic console 為準）。

## 熱量計算（定案）
- BMR 用 **Mifflin-St Jeor**（目前公認誤差最小）：男 `10w+6.25h-5a+5`、女 `10w+6.25h-5a-161`。
- TDEE = BMR × 活動係數（1.2／1.375／1.55／1.725／1.9），`profile.tdee>0` 時覆寫。
- 每日目標 = TDEE + goal，下限夾在 800。
- **淨攝取 = 吃進去 − 額外運動**。活動係數已含日常活動，所以「運動」欄位只記額外運動；UI 上有寫明，別拿掉那句提示，會造成重複扣抵而低估。

## PWA 鐵律（travel-book 血淚，全部已做，別退步）
- 所有資源、manifest `start_url`/`scope`、SW scope **一律相對路徑**（Pages 在 `/lose-weight-helper/` 子路徑）。
- SW：`skipWaiting()`＋activate 清舊快取＋`clients.claim()`；GET `/api` network-first、寫入 network-only、殼 cache-first；**跨網域（Anthropic／GitHub）直接放行不攔**。**改前端記得把 sw.js 的 cache 版本號 +1**（`lwh-shell-vN`，目前 v1）。
- input/textarea/select `font-size ≥ 16px`（iOS 防自動放大）；觸控目標 ≥ 44px；Enter 送出全部走原生 `<form>` + `type=submit`。
- **`#sheet-layer[hidden]{display:none;}` 這行不能省**：`#sheet-layer` 的 ID 選擇器優先度高於瀏覽器對 `[hidden]` 的 `display:none`，少了它 sheet 關掉後仍是一層看不見的全螢幕遮罩，**整個 app 都點不動**（已踩過，實測抓到）。
- 換 icon 後 iOS 已安裝的 PWA 要移除主畫面重加才會換。

## 其他實作備忘
- 寫入用 per-檔案 promise chain 排隊（`persistChains`），避免快速連點時並發互蓋。
- 樂觀更新：畫面先動、背景寫入，失敗才 toast。
- 唯讀模式（Pages 無 PAT）：所有寫入動作入口都有 `requireWrite()` 守門＋toast 提示。
- 日期一律用**當地時區**的 `dateKey()`，**不可以用 `toISOString()`**（那是 UTC，台灣半夜會跳成前一天）。
- PWA 常常整天不關：`visibilitychange` 會在過午夜後把 `curDate` 推到新的一天。
- icon 產生工具在 scratchpad、**不進 repo**；server.js 保持零執行期依賴。
- 測試：`npm test`（`test/roundtrip.js`）。裡面有一條**「前端 store.js 的 serializer 產出與 server.js 逐字相同」**——這是防止前後端 mirror 無聲分岔的主要保險，改格式時它會先炸。

## 啟動
- 雙擊 `start.bat`（只跑 `node server.js`，port 3619）。
- **server.js 啟動時自己執行 build 鏡射 docs/**（build.js 匯出 `build()`），所以從任何入口啟動 docs/ 都不會落後 public/；build 失敗只記 log 不擋服務。
