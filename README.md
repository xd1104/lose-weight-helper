# 減重助手（lose-weight-helper）

手機優先的每日熱量記錄 PWA。吃完用講的或拍一張照，Claude 幫你估熱量，一眼看出今天有沒有超過 TDEE。

**兩個人共用一份 app**：進來像 Netflix 一樣先選人，紀錄、TDEE、目標、常吃清單完全獨立、互不干擾。

- 📝 **文字**：「排骨便當加飯」「南瓜湯頭的麵疙瘩」「大杯半糖珍奶」直接打進去
- 📷 **拍照**：整桌、便當盒都可以，會自動拆成多筆
- ⭐ **常吃**：AI 算過一次就記起來，下次一鍵加入（不用再花 API 錢）
- ✏️ **手動**：沒有 API key 也能用
- 📈 TDEE 自動計算（Mifflin-St Jeor）、每日目標、三大營養素、7 日／30 日趨勢
- 👥 多使用者：點右上頭像即可切換，這台裝置會記住上次是誰

AI 估算一律先給**可編輯的預覽**——每筆都會寫出份量假設（例如「便當盒、白飯約 1.5 碗」），
你確認或改完數字才寫進紀錄。

## 快速開始（電腦）

```bash
node server.js       # 或雙擊 start.bat
```

開 <http://localhost:3619>。資料存在 `data/`，是純 markdown，可以直接用文字編輯器改。

## 手機

推到 GitHub 後開啟 Pages（Settings → Pages → Deploy from a branch → `main` / `/docs`），
用手機開 `https://<你的帳號>.github.io/lose-weight-helper/`，加到主畫面即可當 App 用。

手機端要能**記錄**需要兩把金鑰，都只存在該裝置的瀏覽器裡（不會上傳、不會進 repo）：

| 金鑰 | 用途 | 去哪拿 |
|---|---|---|
| Anthropic API key | AI 判讀熱量 | <https://console.anthropic.com> → API keys（記得在 Billing 設每月上限） |
| GitHub fine-grained PAT | 讀寫紀錄 | GitHub → Settings → Developer settings → Fine-grained tokens，只授權 `lose-weight-helper` 這一個 repo，Contents 設 **Read and write** |

沒有 GitHub 金鑰＝唯讀（看得到，記不了）。沒有 Anthropic key＝AI 判讀不能用，但「手動」與「常吃」照常。

## 成本

實測一次文字判讀約 1,400 input + 260 output tokens。以預設的 Sonnet 5 計算約 **US$0.008（≈ NT$0.26）**，
一天三餐大約 **NT$25/月**。設定頁會顯示本月累計用量與估算金額（以 Anthropic console 的帳單為準）。

想更省可切 Haiku 4.5，想更準可切 Opus 5。

## 架構

```
server.js   本機 Node（零相依，port 3619）＝ 真本，資料寫 data/*.md
            └ 寫入後自動 git commit → pull(-X ours) → push
GitHub repo 同步中樞 ＋ 雲端備份
docs/       build.js 從 public/ 鏡射，給 GitHub Pages 當手機 PWA（產物，別手改）
```

前端依 hostname 自動切資料層：localhost 打本機 `/api`，Pages 直接讀寫 GitHub Contents API。

## 資料格式

```
data/users.md                          使用者名冊
data/users/<uid>/profile.md            身高體重、活動量、目標、模型
data/users/<uid>/foods.md              常吃清單
data/users/<uid>/days/2026-07-25.md    每天一個檔
```

每天的檔案長這樣，人看得懂、git diff 也乾淨：

```markdown
---
date: "2026-07-25"
weight: 0
updatedAt: "2026-07-25T02:36:30.339Z"
---

## 飲食

- {"id":"a2","time":"12:40","meal":"lunch","name":"排骨便當（加飯）","kcal":980,"p":34,"c":128,"f":33,"portion":"便當盒、白飯約 1.5 碗","src":"ai"}

## 運動

- {"id":"m1","time":"19:30","name":"慢跑 30 分","kcal":300}

## 備註

今天午餐加飯了，晚上補跑。
```

## 測試

```bash
npm test
```

涵蓋 md round-trip、壞資料容錯、CRLF、數值夾限、path traversal，
以及「前端與後端的 serializer 產出必須逐字相同」（防止前後端格式無聲分岔）。

## 開發備忘

改動前請看 [`CLAUDE.md`](./CLAUDE.md)，裡面記了哪些是刻意的設計決策、哪些地雷不要踩。
