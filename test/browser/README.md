# 瀏覽器測試

`test/roundtrip.js`（`npm test`）只測 md 解析與序列化。這裡是**真的開瀏覽器**跑的流程測試，
涵蓋單元測試碰不到的東西：畫面、事件、GitHubStore 的寫入重試、AI 的 request 形狀。

## 跑法

```bash
node server.js &                     # 另一個視窗，或背景
npm i -D playwright                  # 只有測試才需要，不進執行期相依
node test/browser/01-flow.js
```

每支都會自己 `process.exit(1)` 表示失敗。

| 檔案 | 測什麼 |
|---|---|
| `01-flow.js` | 新使用者引導 → 體重 → 歷史趨勢 → 邊界值 → iOS 觸控/字級規範 |
| `02-readonly.js` | **手機第一次開、沒有金鑰**：必須有「貼上金鑰」的出口，不能卡死 |
| `03-github-write.js` | **GitHubStore 寫入路徑**：sha 記憶、缺 sha 的 422、sha 過期的 409 自動重試、刪檔、遞迴刪使用者資料夾 |
| `04-multiuser.js` | 兩個使用者的資料隔離、TDEE 各自獨立 |
| `05-ai.js` | AI request 形狀、結果預覽的編輯與刪除、用量統計 |
| `06-photo.js` | 相機／相簿兩個入口、`capture` 屬性、重選同一張、非圖片檔的錯誤 |
| `07-move-ai.js` | 運動 AI 估算：請求有帶體重、要求淨消耗、數字可先改再存、做過的運動進快速選擇 |
| `09-floor.js` | 熱量上限語意（減脂顯示「上限」）、目標低於 BMR 的警告與消失條件、**三段式圓環**（綠／黃＝超過上限但未超 TDEE／紅＝超過 TDEE） |
| `08-macros.js` | 營養分頁：三大營養素達標判定、蛋白質缺口建議、熱量來源分配、目標可調 |
| `10-audit-fixes.js` | 2026-07 稽核修正的回歸測試：讀取失敗不留空白天、歷史頁載入=繪製窗口、當天紀錄即時進歷史、Haiku 不送 effort、常吃可刪單筆 |
| `17-reuse.js` | 吃過的東西沿用上次記的數字：命中才提示、差 5% 以內不吵、名稱寫法不同也認得、加星的常吃不被 AI 覆寫 |
| `18-multiphoto.js` | 一餐給多張照片：request 真的帶 N 個 image block、多張才叮嚀「同一樣東西只能算一次」、單筆重估帶所有照片、上限 4 張 |
| `19-version.js` | 版本與更新：設定看得到版本、主動檢查、真的改 sw.js 驗證偵測得到（會暫時改寫 `public/sw.js`，finally 還原） |
| `20-weight.js` | 體重的小數位：step 允許 0.01、59.45 存得進檔案、身體資料不再被進位成整數、kgTxt 的顯示規則 |
| `21-tidy.js` | 長餐段摺疊、AI 結果合併成一項、會自己長高的文字框（含 Enter 仍然送出） |
| `22-audit.js` | **全 app 基本功稽核**：每個 number 欄位都有 step 且 inputmode 對得起來、小數真的送得出去、觸控目標 ≥44px、輸入字級 ≥16px、焦點會被捲進畫面、長條圖有目標線、同頁不重複講同一件事。加新欄位／新畫面時這支會先炸 |
| `23-scale.js` | 份量的倍數調整：四個數字一起換算、份量文字只記累計倍率、AI 結果頁也調得動、編輯一筆的營養素不再被進位 |
| `15-fav-coach.js` | **常吃清單**（多選一次加、自己新增、編輯與刪除、搜尋不掉勾選）＋ **今天吃得怎樣**（送出的內容、講評版面、同一天不重複收費、存進 day 檔重開還在、歷史頁的 🥗 記號） |
| `14-pace.js` | **「一週約 −0.19 kg」**：白天不顯示、缺口跟 TDEE 比、超過 TDEE 變 + 且轉紅、歷史頁 7 天平均與三段配色 |
| `13-ai-fix.js` | **AI 結果的單筆修正**：照片退回去還在、點某一項改名字、「重新估這一項」帶原圖且只換那一項、只改名稱不打 AI、補一項 |
| `12-sync.js` | **手機版寫入**：一次記 6 筆只寫 2 個檔、寫入完全序列化、409 退避重試、失敗時的「還沒同步」橫幅與重送 |
| `11-settings.js` | 索引式設定頁：摘要值、控制項收在 sheet 裡、改數字不重建 input、警示留在索引上、從 sheet 切換使用者 |

`06` 需要先跑 `node test/browser/fixtures.js` 產生素材（素材不進 repo）。

## 測試之間必須隔離

所有測試打的是**同一個本機 server**，不重置的話前一支留下的飲食會累加到同一天，
後一支的斷言就會噴假警報（踩過）。`_setup.js` 提供：

- `clearAll()` — 刪光所有使用者，給「測建立流程」的測試（01–04）
- `seedUser()` — 清空後建一位填好身體資料的 Benson，給其他測試（05–11）
- `openSet(page, sec)` / `closeSet(page)` — 設定頁是索引式的，控制項在各自的 sheet 裡，
  要動 `[data-set]` / `[data-num]` 一律先 `openSet`；換頁前要 `closeSet`，不然 sheet 會蓋住導覽列

每支測試開頭都會呼叫其中一個。新增測試時記得跟著做。

⚠️ 這兩個函式會**刪掉本機 server 上的所有使用者資料**。跑測試前確認那不是你正在用的真實資料。

## 這些測試用的是假的外部服務

`03` 用一個**有狀態**的假 GitHub Contents API（會記 sha、會回 409/422），
`05` 攔截 `api.anthropic.com` 回固定內容。

**所以它們驗的是「我們的 client 邏輯」，不是 GitHub 或 Anthropic 本身的行為。**
真實服務只在有金鑰的裝置上跑得到——第一次上手機時要自己確認一遍。

## 已知未涵蓋

- 真 iOS Safari（只跑過 Chromium 390px）
- 真手機相機拍的照片（EXIF 轉正走 `createImageBitmap`，程式碼有處理，但沒有實機驗過）
- 真實 Anthropic API 的 request 形狀（沒有 key 驗不了；`ai.js` 有 400 降級路徑當保險）
- Service worker 的更新／離線行為
  （註：`10-audit-fixes.js` 開 context 時用 `serviceWorkers:'block'`——
  SW 接手之後 fetch 不經過 `page.route`，攔不到就製造不出「讀取失敗」的情境。
  其他要攔本機 `/api` 的測試也要照做。）
- GitHub Pages 子路徑（`/lose-weight-helper/`）實際部署
