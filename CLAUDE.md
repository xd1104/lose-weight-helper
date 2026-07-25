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

## 體重（v2.1）
- `day.weight` 早就在資料格式裡，但之前**沒有 UI 入口**——一個叫「減重助手」的 app 不能記體重是最大的缺口，v2.1 補上。
- 首頁熱量環正下方一張體重卡（點進去輸入），歷史頁有趨勢折線＋區間增減。
- **記今天的體重會一併寫回 `profile.weight`**：TDEE 是用體重算的，不同步會越用越不準。UI 上有明講，別偷偷拿掉。
- 趨勢折線**只連有量到的日子，不補值**——補值會畫出一條看起來很順但假的曲線。
- 全部一樣重時 span 夾在 0.6，避免折線貼著邊框。
- 歷史頁「只量體重、沒記飲食」的日子熱量顯示 `—` 而不是 `0`（0 會被誤讀成「今天沒吃」）。

## `updatedAt` 的語意（踩過的坑，別改回去）
- `cleanProfile` **讀取時原樣保留 `updatedAt`**，時間戳只在 `serializeProfile` 落檔那一刻蓋。
- 曾經在 `cleanProfile` 裡無條件蓋 `new Date()`，結果 `updatedAt` 變成「剛才讀檔的時間」，
  前端「還沒設定過身體資料」的引導**永遠不會出現**（QC 實測抓到）。測試裡有一條專門釘住這件事。
- 前端存檔時會自己把 `db.profile.updatedAt` 標記起來（代表「這個 session 設定過了」），這樣不用重讀檔就能把引導收起來。

## 唯讀模式的出口（踩過的坑，別移除）
- 手機端（Pages）沒貼 GitHub 金鑰＝唯讀。**選人畫面一定要留一個「貼上金鑰」的出口**（`openKeysSheet`）。
- 曾經是死路：沒有使用者 → 選人畫面只有「新增使用者」→ 被唯讀擋掉 → 而「設定」要有使用者才進得去
  → **完全沒有地方能貼金鑰，手機第一次開就卡死**。
- `openKeysSheet()` 刻意**不依賴 `me`**（選人畫面時 `me` 是 null），裡面同時放 GitHub 金鑰與 Anthropic API key。
- 唯讀時直接**不顯示**「新增使用者」磚（按了也沒用，不如不給），文案也要跟著換——
  不能在建不了使用者的狀態下叫他「先建立第一位使用者」。

## 新使用者引導
- 建完使用者**直接跳出身體資料設定 sheet**：不設的話首頁的目標是用預設值（男/30歲/170cm/65kg）算的，等於假的。
- 沒設定過的人首頁上方有黃色提醒卡；設定完自動消失。
- 設定 sheet 裡改 chip 前會先把已輸入的數字讀起來（`readInputs`），否則重畫會把使用者剛打的身高體重吃掉。

## 運動 AI 估算（v2.2）
- 運動的消耗跟**體重高度相關**（食物不會），所以 `aiAnalyzeMove` 一定要把 profile 的體重／年齡／性別帶進 prompt。
- **一定要 AI 回「淨消耗」**（`(MET-1) × 體重 × 時數`）：TDEE 的活動係數已經含了那段時間的靜息代謝，
  一般 app 報的是總消耗，直接拿來扣會系統性高估、變成「怎麼練都瘦不下來」。prompt 裡寫死了，別拿掉。
- 回傳的 `detail` 一定要顯示出來（時長／強度／MET／體重）——同「食物要顯示 portion」的理由：
  使用者要能一眼看出 AI 是不是抓錯強度。
- 數字填進表單後**仍可手改**才存，跟食物一樣不直接寫入。
- **快速選擇＝你做過的運動（從 `db.days` 撈）＋內建預設**，刻意不另外開檔案存：資料本來就在 days 裡。
  自己做過的用 `.chip.mine` 標示，跟內建的區分開。

## 熱量目標的語意與基礎代謝下限（v2.4）
- 首頁那個數字是**上限**不是要達成的目標。減脂時（`goal<0`）標籤顯示「每日上限」，
  維持／增肌時才顯示「每日目標」——Benson 問過「這是要達到還是不能超過」，
  原本一律叫「目標」會讓人以為要吃到。
- **真正該看的是「缺口佔 TDEE 的百分比」，不是跟 BMR 比**。「不能吃低於基礎代謝」是常見的
  經驗法則、不是硬性生理禁令；設定頁固定顯示缺口百分比與理論每週減重，>25% 給黃色提醒。
- **目標低於 BMR 時，設定頁一定要警告**（紅色）。久坐（1.2）＋ 減脂快（-500）很容易讓目標掉到 BMR 以下
  （Benson 的實際設定就是：BMR 1720、TDEE 2064、目標 1564）。長期吃低於基礎代謝，
  掉的會有一大部分是肌肉。警告會算出「缺口要縮到多少以內」給具體解法。
- 首頁「今天吃太少」的提示**只在過去的日子或今天 20 點後才顯示**——一天還沒過完就跳
  「低於基礎代謝」很煩，會被無視。

## 營養分頁（v2.3）
- 三大營養素目標的**順序是固定的**：先蛋白質（體重決定）→ 再脂肪（熱量百分比）→ 碳水拿剩下的。
  這樣「碳水超標」自然等於「另外兩個沒吃夠」，語意才通。
- **蛋白質與脂肪／碳水的判定語意不同**，`macroRow` 的 `mode` 就是在區分這個：
  - `atleast`（蛋白質）：吃不夠才是問題，超過不算壞事
  - `cap`（脂肪／碳水）：超過才是問題；脂肪另有下限 `體重×0.6`，長期低於會影響荷爾蒙
- 蛋白質缺口 > 目標 60% 時**刻意不給零食換算**——那不是「補一下」的量，
  講「等於 5 份高蛋白飲」只會讓人放棄，改成提醒正餐要配蛋白質。
- 食物換算同一種最多列 2 份就換下一種（三杯高蛋白飲不是實際會做的事）。
- 三大營養素加總的熱量與記錄熱量差超過 15% 時會提示——通常是某幾筆手動輸入只填了熱量沒填營養素。
- 首頁的三大方塊點下去會跳到營養頁（`data-nav2`）。

## 熱量計算（定案）
- BMR 用 **Mifflin-St Jeor**（目前公認誤差最小）：男 `10w+6.25h-5a+5`、女 `10w+6.25h-5a-161`。
- TDEE = BMR × 活動係數（1.2／1.375／1.55／1.725／1.9），`profile.tdee>0` 時覆寫。
- 每日目標 = TDEE + goal，下限夾在 800。
- **活動係數＝「不含運動」的日常生活強度**，UI 的說明刻意寫「工作型態與走路量」而不是教科書的「每週運動幾次」。
  教科書定義把運動算進係數裡，但本 app 另外有運動欄位；照教科書選就會把健身房算兩遍、目標虛高。
  設定頁與首次引導都有一句提醒，**別把它拿掉**（Benson 問過「輕度是什麼意思」才發現原本文案在引導重複計算）。
- **活動係數＝「不含運動」的日常生活強度**，UI 說明刻意寫「工作型態與走路量」而不是教科書的「每週運動幾次」。
  教科書定義把運動算進係數裡，但本 app 另外有運動欄位；照教科書選就會把健身房算兩遍、目標虛高。
  設定頁與首次引導都有一句提醒，**別拿掉**（Benson 問「輕度是什麼意思」才發現原本文案在引導使用者重複計算）。
- **淨攝取 = 吃進去 − 額外運動**。活動係數已含日常活動，所以「運動」欄位只記額外運動；UI 上有寫明，別拿掉那句提示，會造成重複扣抵而低估。

## 讀取／歷史頁（2026-07 稽核後定案，別改回去）
- **讀日紀錄失敗 ≠ 那天沒吃**：`ensureDays` 先放空殼避免重複請求，但**失敗時一定要把空殼收回來**（只收回「還是原本那個空殼」的，載入途中記的東西不能弄丟）。留著的話 `db.days[k]` 有值 → 永遠不再重試，而那個空白的一天一旦被存回去就會蓋掉雲端真正的紀錄。同理 GitHubStore 讀 day 走 **`_readTextStrict`**（只有真 404 才回 null，其他錯誤往外丟）——別為了「比較不會噴錯」改回寬鬆的 `_readText`。
- **歷史頁的天數用單一常數 `HIST_DAYS`**（載入與繪製共用）。原本載 30、畫 60，第 31–60 天永遠顯示「—」。
- **`histDates` 由 `persistDay` 順手維護**：有內容就加進去、整天清空就移除（判斷條件 `dayHasData` 要跟 server 的「空天刪檔」條件一致）。歷史清單一輩子只在開 app／第一次點歷史時抓一次，不維護的話當天新記的紀錄要重開 app 才看得到。

## PWA 鐵律（travel-book 血淚，全部已做，別退步）
- 所有資源、manifest `start_url`/`scope`、SW scope **一律相對路徑**（Pages 在 `/lose-weight-helper/` 子路徑）。
- SW：`skipWaiting()`＋activate 清舊快取＋`clients.claim()`；GET `/api` network-first、寫入 network-only、殼 cache-first；**跨網域（Anthropic／GitHub）直接放行不攔**。**改前端記得把 sw.js 的 cache 版本號 +1**（`lwh-shell-vN`，目前 v1）。
- input/textarea/select `font-size ≥ 16px`（iOS 防自動放大）；觸控目標 ≥ 44px；Enter 送出全部走原生 `<form>` + `type=submit`。
- **`#sheet-layer[hidden]{display:none;}` 這行不能省**：`#sheet-layer` 的 ID 選擇器優先度高於瀏覽器對 `[hidden]` 的 `display:none`，少了它 sheet 關掉後仍是一層看不見的全螢幕遮罩，**整個 app 都點不動**（已踩過，實測抓到）。
- 換 icon 後 iOS 已安裝的 PWA 要移除主畫面重加才會換。

## 其他實作備忘
- **`output_config.effort` 只在推理型模型送**（`outputConfigFor`）：Haiku 4.5 收到會直接回 400，雖然有純 JSON 降級路徑接住，但等於每次都白打一次請求（慢、又多算一次 usage）。新增模型時記得確認這個開關。
- 常吃清單支援**刪單筆**（`data-fav-del`，有 confirm）：AI 偶爾會生出「甜椒配料 3 大卡」這種項目，只有「清空全部」的話會一直卡在清單裡。
- 寫入用 per-檔案 promise chain 排隊（`persistChains`），避免快速連點時並發互蓋。
- 樂觀更新：畫面先動、背景寫入，失敗才 toast。
- 唯讀模式（Pages 無 PAT）：所有寫入動作入口都有 `requireWrite()` 守門＋toast 提示。
- 日期一律用**當地時區**的 `dateKey()`，**不可以用 `toISOString()`**（那是 UTC，台灣半夜會跳成前一天）。
- PWA 常常整天不關：`visibilitychange` 會在過午夜後把 `curDate` 推到新的一天。
- icon 產生工具在 scratchpad、**不進 repo**；server.js 保持零執行期依賴。
- 熱量環在 0 時**不畫彩色弧**：`stroke-linecap:round` 會在 dasharray 0 的位置留一個小圓點。
- **AI 有降級路徑**：`output_config` 的形狀若被 API 回 400，會自動改用「提示詞要求純 JSON」再試一次（`aiRequest(..., plain)`）。
  沒有 API key 就無法驗證 structured outputs 的形狀，這條保險是刻意留的，別當多餘刪掉。
- **照片有兩個 file input，這是刻意的**：`capture="environment"` 會**強制**開相機，手機上就完全看不到相簿；
  不帶 `capture` 才會讓系統給選單。與其靠系統選單，不如直接給「拍照」「從相簿選」兩顆按鈕。
  **不要把兩個 input 合併成一個**，合併就一定得犧牲其中一種來源。
- 每次處理完照片要把 `input.value=""` 清掉，否則使用者連選同一張時 `change` 不會再觸發。
- **照片走 `createImageBitmap({imageOrientation:"from-image"})`**：iPhone 直向拍的 EXIF orientation 常是 6，
  用 `<img>`+canvas 不會轉正，會把躺著的照片送給 AI，判讀變差。舊瀏覽器才退回 `<img>` 路徑。
- 測試：`npm test`（`test/roundtrip.js`）＋ `npm run test:browser`（`test/browser/`，需要 `npm i -D playwright`）。
  `test/browser/README.md` 有寫**哪些是假的外部服務、哪些還沒驗過**——接手前先看那一段。裡面有一條**「前端 store.js 的 serializer 產出與 server.js 逐字相同」**——這是防止前後端 mirror 無聲分岔的主要保險，改格式時它會先炸。

## 啟動
- 雙擊 `start.bat`（只跑 `node server.js`，port 3619）。
- **server.js 啟動時自己執行 build 鏡射 docs/**（build.js 匯出 `build()`），所以從任何入口啟動 docs/ 都不會落後 public/；build 失敗只記 log 不擋服務。
