# line-helpdesk-bot

LINE 官方帳號「問題回報小幫手」：LINE Messaging API + LIFF 問題回報表單 + Cloudflare Workers AI 問答。

## 架構

LINE 使用者 → LINE 平台 → Webhook → Cloudflare Worker（`src/index.js`）

LINE 內開啟 LIFF 表單（`public/liff/index.html`，由同一個 Worker 以靜態資源提供）
→ `POST /api/report`（驗證 LIFF access token 屬於我們的 LINE Login channel）→ 問題單

## 專案結構

| 路徑 | 說明 |
|---|---|
| `src/index.js` | Worker：LINE Webhook、問題回報 API |
| `public/liff/index.html` | LIFF 問題回報表單頁 |
| `wrangler.jsonc` | Worker 設定（靜態資源、非機密變數） |

## 版本紀錄

| 版本 | 內容 |
|---|---|
| v0.1 | Webhook 簽章驗證，複誦使用者訊息 |
| v0.1.1 | 機密去除前後空白；簽章失敗時記錄診斷（不含機密內容）；開啟 Workers 觀測記錄 |
| v0.1.2 | 記錄收到的事件類型與回覆結果（不含使用者訊息內容），access token 去除空白 |
| v0.2 | 回覆文字由「你說：」改為「收到：」（示範版本差異） |
| v0.3 | LIFF 問題回報表單、`/api/report`（驗證登入 + 欄位檢查）、「回報」指令、表單送出後的聊天室確認 |

## 機密設定

`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` 只存在 Cloudflare Worker 的
Settings → Variables and Secrets（Type: Secret），**不放進這個 repo**。
