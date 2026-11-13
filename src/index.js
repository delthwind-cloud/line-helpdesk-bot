// LINE 問題回報小幫手
// v0.3：LIFF 問題回報表單 + 送出 API + 「回報」指令

const CATEGORIES = ["帳號登入", "設備故障", "網路問題", "軟體操作", "其他"];
const URGENCIES = ["一般", "急"];
const MAX_DESCRIPTION = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 表單送出的 API（LIFF 頁面呼叫）
    if (url.pathname === "/api/report" && request.method === "POST") {
      return handleReport(request, env);
    }

    // LINE Webhook
    if (request.method === "POST") {
      return handleWebhook(request, env);
    }

    // /liff/ 由靜態資源（public/）直接提供，走不到這裡
    return new Response("LINE helpdesk bot is running", { status: 200 });
  },
};

// ───────────────────────── LINE Webhook ─────────────────────────

async function handleWebhook(request, env) {
  const body = await request.text();
  const signature = request.headers.get("x-line-signature") || "";

  // 驗證這個請求真的是 LINE 送來的
  const secret = (env.LINE_CHANNEL_SECRET || "").trim();
  if (!(await verifySignature(body, signature, secret))) {
    console.log(
      JSON.stringify({
        msg: "signature check failed",
        secretConfigured: secret.length > 0,
        secretLength: secret.length, // Channel secret 正常應為 32
        signatureHeaderPresent: signature.length > 0,
      })
    );
    return new Response("Bad signature", { status: 401 });
  }

  const { events = [] } = JSON.parse(body);
  // 診斷記錄：只記事件類型，不記使用者訊息內容
  console.log(
    JSON.stringify({
      msg: "webhook received",
      eventCount: events.length,
      eventTypes: events.map((e) => `${e.type}/${e.message?.type ?? "-"}`),
      accessTokenConfigured: Boolean((env.LINE_CHANNEL_ACCESS_TOKEN || "").trim()),
    })
  );
  await Promise.all(events.map((e) => handleEvent(e, env)));
  return new Response("OK", { status: 200 });
}

async function handleEvent(event, env) {
  const liffUrl = `https://liff.line.me/${env.LIFF_ID}`;

  if (event.type === "follow") {
    return reply(
      event.replyToken,
      `你好！我是問題回報小幫手。\n輸入「回報」就能填寫問題單：\n${liffUrl}`,
      env
    );
  }

  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // 表單送出後，LIFF 會代使用者在聊天室送出這則訊息
    if (text.startsWith("【問題回報】")) {
      const ticket = text.match(/單號\s*(\S+)/)?.[1];
      return reply(
        event.replyToken,
        ticket
          ? `✅ 已收到你的問題回報，單號 ${ticket}。我們會盡快處理。`
          : "✅ 已收到你的問題回報。我們會盡快處理。",
        env
      );
    }

    // 開啟表單的指令
    if (/^(回報|問題回報|報修|我要回報)$/.test(text)) {
      return reply(event.replyToken, `請點這裡填寫問題回報：\n${liffUrl}`, env);
    }

    // 其他訊息：暫時複誦（之後會換成 AI 問答）
    return reply(
      event.replyToken,
      `收到：${text}\n（輸入「回報」可開啟問題回報表單）`,
      env
    );
  }
}

async function reply(replyToken, text, env) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${(env.LINE_CHANNEL_ACCESS_TOKEN || "").trim()}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (res.ok) {
    console.log(JSON.stringify({ msg: "LINE reply ok", status: res.status }));
  } else {
    console.log(
      JSON.stringify({ msg: "LINE reply failed", status: res.status, detail: await res.text() })
    );
  }
}

async function verifySignature(body, signature, secret) {
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

// ───────────────────────── 問題回報 API ─────────────────────────

async function handleReport(request, env) {
  // 1. 驗證呼叫者：必須帶 LIFF 的 access token，且 token 屬於我們的 LINE Login channel
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ error: "尚未登入，請從 LINE 重新開啟表單" }, 401);

  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`
  );
  if (!verifyRes.ok) return json({ error: "登入已失效，請重新開啟表單" }, 401);
  const info = await verifyRes.json();
  if (String(info.client_id) !== String(env.LINE_LOGIN_CHANNEL_ID) || !(info.expires_in > 0)) {
    return json({ error: "登入資訊不符，請從 LINE 重新開啟表單" }, 401);
  }

  const profileRes = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!profileRes.ok) return json({ error: "無法取得使用者資料，請重新開啟表單" }, 401);
  const profile = await profileRes.json(); // { userId, displayName, ... }

  // 2. 驗證表單內容
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "資料格式錯誤" }, 400);
  }
  const category = String(data.category ?? "");
  const urgency = String(data.urgency ?? "");
  const description = String(data.description ?? "").trim();

  if (!CATEGORIES.includes(category)) return json({ error: "請選擇問題類別" }, 400);
  if (!URGENCIES.includes(urgency)) return json({ error: "請選擇急迫程度" }, 400);
  if (description.length < 1) return json({ error: "請描述你遇到的問題" }, 400);
  if (description.length > MAX_DESCRIPTION) {
    return json({ error: `問題描述請在 ${MAX_DESCRIPTION} 字以內` }, 400);
  }

  // 3. 建立問題單（v0.3 先產生單號並記錄；v0.4 會存入 D1 資料庫）
  const ticketId = newTicketId();
  console.log(
    JSON.stringify({
      msg: "report created",
      ticketId,
      category,
      urgency,
      descriptionLength: description.length,
    })
  );

  return json({ ok: true, ticketId, displayName: profile.displayName });
}

function newTicketId() {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // 台灣時間
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${String(now.getUTCFullYear()).slice(2)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `${stamp}-${rand}`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
