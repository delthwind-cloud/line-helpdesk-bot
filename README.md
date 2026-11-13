# line-helpdesk-bot

LINE 官方帳號「問題回報小幫手」：LINE Messaging API + LIFF 問題回報表單 + Cloudflare Workers AI 問答。

## 架構

LINE 使用者 → LINE 平台 → Webhook → Cloudflare Worker（`src/index.js`）

LINE 內開啟 LIFF 表單（`public/liff/index.html`，由同一個 Worker 以靜態資源提供）
→ `POST /api/report`（驗證 LIFF access token 屬於我們的 LINE Login channel）→ 問題單存入 Cloudflare D1
→ `GET /api/my-reports` 讓使用者查看自己的問題單

聊天室一般訊息 → Cloudflare Workers AI（`env.AI`，預設 Qwen3 30B）→ 回覆；
每人每天 15 則、全站每天 300 則，額度記錄在 D1 `ai_usage`（UTC 日期，與免費額度同一天重置）。

## 專案結構

| 路徑 | 說明 |
|---|---|
| `src/index.js` | Worker：LINE Webhook、問題回報 API、D1 資料存取、AI 問答 |
| `public/liff/index.html` | LIFF 問題回報表單頁 |
| `wrangler.jsonc` | Worker 設定（靜態資源、非機密變數、D1 與 AI 綁定、AI 模型與額度） |

## 版本紀錄

| 版本 | 內容 |
|---|---|
| v0.1 | Webhook 簽章驗證，複誦使用者訊息 |
| v0.1.1 | 機密去除前後空白；簽章失敗時記錄診斷（不含機密內容）；開啟 Workers 觀測記錄 |
| v0.1.2 | 記錄收到的事件類型與回覆結果（不含使用者訊息內容），access token 去除空白 |
| v0.2 | 回覆文字由「你說：」改為「收到：」（示範版本差異） |
| v0.3 | LIFF 問題回報表單、`/api/report`（驗證登入 + 欄位檢查）、「回報」指令、表單送出後的聊天室確認 |
| v0.4 | 問題單存入 D1（自動建表）、單號改為「日期-流水號」、「我的問題單」分頁與「查詢」指令、每人每小時 10 筆上限 |
| v0.5 | Workers AI 問答（Qwen3 30B）、每人/全站每日額度保護、「說明」指令、先回 200 再背景回覆、AI 失敗時的備援訊息 |
| v0.6 | 課堂簡報 `docs/briefing.html`：可點擊翻頁、可下載、可存成 PDF 的 HTML 簡報（使用方式與問題回報流程） |

## 機密設定

`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` 只存在 Cloudflare Worker 的
Settings → Variables and Secrets（Type: Secret），**不放進這個 repo**。

## 問題單狀態

預設「未處理」。在 Cloudflare → Storage & Databases → D1 → `helpdesk-db` → Console 執行：

```sql
UPDATE reports SET status = '處理中' WHERE id = 1;  -- 狀態：未處理 / 處理中 / 已完成
```
