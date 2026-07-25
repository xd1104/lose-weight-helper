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
- GitHub Pages 子路徑（`/lose-weight-helper/`）實際部署
