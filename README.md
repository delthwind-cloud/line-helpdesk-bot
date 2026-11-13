# line-helpdesk-bot

LINE 官方帳號「問題回報小幫手」：LINE Messaging API + LIFF 問題回報表單 + Cloudflare Workers AI 問答。

## 架構

LINE 使用者 → LINE 平台 → Webhook → Cloudflare Worker（`src/index.js`）

## 版本紀錄

| 版本 | 內容 |
|---|---|
| v0.1 | Webhook 簽章驗證，複誦使用者訊息 |

## 機密設定

`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` 只存在 Cloudflare Worker 的
Settings → Variables and Secrets（Type: Secret），**不放進這個 repo**。
