// LINE 問題回報小幫手
// v0.4：問題單存入 D1、「我的問題單」查詢、每小時回報次數限制

const CATEGORIES = ["帳號登入", "設備故障", "網路問題", "軟體操作", "其他"];
const URGENCIES = ["一般", "急"];
const MAX_DESCRIPTION = 500;
const MAX_REPORTS_PER_HOUR = 10;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // LIFF 頁面呼叫的 API
    if (url.pathname === "/api/report" && request.method === "POST") {
      return handleReport(request, env);
    }
    if (url.pathname === "/api/my-reports" && request.method === "GET") {
      return handleMyReports(request, env);
    }

    // LINE Webhook
    if (request.method === "POST") {
      return handleWebhook(request, env);
    }

    // /liff/ 由靜態資源（public/）直接提供，走不到這裡
    return new Response("LINE helpdesk bot is running", { status: 200 });
  },
};

// ───────────────────────── 資料庫（D1） ─────────────────────────

let schemaReady; // 同一個 isolate 只建立一次資料表

function ensureSchema(env) {
  if (!env.DB) throw new Error("D1 binding `DB` is not configured");
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS reports (
           id            INTEGER PRIMARY KEY AUTOINCREMENT,
           created_at    TEXT NOT NULL,
           line_user_id  TEXT NOT NULL,
           display_name  TEXT,
           category      TEXT NOT NULL,
           urgency       TEXT NOT NULL,
           description   TEXT NOT NULL,
           status        TEXT NOT NULL DEFAULT '未處理'
         )`
      ),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_reports_user ON reports (line_user_id, id DESC)"
      ),
    ]).catch((err) => {
      schemaReady = undefined; // 失敗時允許下次重試
      throw err;
    });
  }
  return schemaReady;
}

// 單號：台灣日期 + 流水號，例如 261113-0007
function ticketLabel(id, createdIso) {
  const tw = new Date(new Date(createdIso).getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const date =
    String(tw.getUTCFullYear()).slice(2) + pad(tw.getUTCMonth() + 1) + pad(tw.getUTCDate());
  return `${date}-${String(id).padStart(4, "0")}`;
}

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
  await Promise.all(
    events.map((e) =>
      handleEvent(e, env).catch((err) =>
        console.log(JSON.stringify({ msg: "event handler error", error: String(err) }))
      )
    )
  );
  return new Response("OK", { status: 200 });
}

async function handleEvent(event, env) {
  const liffUrl = `https://liff.line.me/${env.LIFF_ID}`;

  if (event.type === "follow") {
    return reply(
      event.replyToken,
      `你好！我是問題回報小幫手。\n輸入「回報」就能填寫問題單：\n${liffUrl}\n輸入「查詢」可看你最近的問題單。`,
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

    // 開啟表單
    if (/^(回報|問題回報|報修|我要回報)$/.test(text)) {
      return reply(event.replyToken, `請點這裡填寫問題回報：\n${liffUrl}`, env);
    }

    // 查詢自己最近的問題單
    if (/^(查詢|我的問題單|查單)$/.test(text)) {
      return reply(event.replyToken, await recentReportsText(event.source?.userId, env), env);
    }

    // 其他訊息：暫時複誦（之後會換成 AI 問答）
    return reply(
      event.replyToken,
      `收到：${text}\n（輸入「回報」填寫問題單、「查詢」看我的問題單）`,
      env
    );
  }
}

async function recentReportsText(userId, env) {
  if (!userId) return "無法辨識你的帳號，請改用表單裡的「我的問題單」查看。";
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, category, urgency, status FROM reports WHERE line_user_id = ? ORDER BY id DESC LIMIT 5"
  )
    .bind(userId)
    .all();
  if (!results.length) return "你還沒有送出過問題單。輸入「回報」就能開始。";
  const lines = results.map(
    (r) =>
      `#${ticketLabel(r.id, r.created_at)}｜${r.status}｜${r.category}${r.urgency === "急" ? "（急）" : ""}`
  );
  return `你最近的問題單：\n${lines.join("\n")}`;
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

// ───────────────────────── LIFF API ─────────────────────────

// 驗證呼叫者：必須帶 LIFF 的 access token，且 token 屬於我們的 LINE Login channel
async function authenticate(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { error: json({ error: "尚未登入，請從 LINE 重新開啟表單" }, 401) };

  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`
  );
  if (!verifyRes.ok) return { error: json({ error: "登入已失效，請重新開啟表單" }, 401) };
  const info = await verifyRes.json();
  if (String(info.client_id) !== String(env.LINE_LOGIN_CHANNEL_ID) || !(info.expires_in > 0)) {
    return { error: json({ error: "登入資訊不符，請從 LINE 重新開啟表單" }, 401) };
  }

  const profileRes = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!profileRes.ok) {
    return { error: json({ error: "無法取得使用者資料，請重新開啟表單" }, 401) };
  }
  return { profile: await profileRes.json() }; // { userId, displayName, ... }
}

async function handleReport(request, env) {
  const { profile, error } = await authenticate(request, env);
  if (error) return error;

  // 驗證表單內容
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

  try {
    await ensureSchema(env);

    // 防濫用：每位使用者每小時最多 N 筆，保護免費額度
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reports WHERE line_user_id = ? AND created_at > ?"
    )
      .bind(profile.userId, since)
      .first();
    if (recent.n >= MAX_REPORTS_PER_HOUR) {
      return json({ error: `一小時內最多送出 ${MAX_REPORTS_PER_HOUR} 筆，請稍後再試` }, 429);
    }

    const createdAt = new Date().toISOString();
    const result = await env.DB.prepare(
      `INSERT INTO reports (created_at, line_user_id, display_name, category, urgency, description)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(createdAt, profile.userId, profile.displayName ?? "", category, urgency, description)
      .run();

    const ticketId = ticketLabel(result.meta.last_row_id, createdAt);
    console.log(
      JSON.stringify({
        msg: "report saved",
        ticketId,
        category,
        urgency,
        descriptionLength: description.length,
      })
    );
    return json({ ok: true, ticketId, displayName: profile.displayName });
  } catch (err) {
    console.log(JSON.stringify({ msg: "report save failed", error: String(err) }));
    return json({ error: "系統暫時無法儲存，請稍後再試" }, 500);
  }
}

async function handleMyReports(request, env) {
  const { profile, error } = await authenticate(request, env);
  if (error) return error;

  try {
    await ensureSchema(env);
    const { results } = await env.DB.prepare(
      `SELECT id, created_at, category, urgency, description, status
         FROM reports WHERE line_user_id = ? ORDER BY id DESC LIMIT 20`
    )
      .bind(profile.userId)
      .all();
    return json({
      reports: results.map((r) => ({
        ticketId: ticketLabel(r.id, r.created_at),
        createdAt: r.created_at,
        category: r.category,
        urgency: r.urgency,
        description: r.description,
        status: r.status,
      })),
    });
  } catch (err) {
    console.log(JSON.stringify({ msg: "list reports failed", error: String(err) }));
    return json({ error: "系統暫時無法讀取，請稍後再試" }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
