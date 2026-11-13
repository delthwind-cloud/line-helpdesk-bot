// LINE 問題回報小幫手 — v0.1：簽章驗證 + 複誦訊息
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("LINE helpdesk bot is running", { status: 200 });
    }

    const body = await request.text();
    const signature = request.headers.get("x-line-signature") || "";

    // 驗證這個請求真的是 LINE 送來的
    if (!(await verifySignature(body, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("Bad signature", { status: 401 });
    }

    const { events = [] } = JSON.parse(body);
    await Promise.all(events.map((e) => handleEvent(e, env)));
    return new Response("OK", { status: 200 });
  },
};

async function handleEvent(event, env) {
  if (event.type === "follow") {
    return reply(event.replyToken, "你好！我是問題回報小幫手，目前測試中。", env);
  }
  if (event.type === "message" && event.message.type === "text") {
    return reply(event.replyToken, `你說：${event.message.text}`, env);
  }
}

async function reply(replyToken, text, env) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) console.log("LINE reply failed", res.status, await res.text());
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
