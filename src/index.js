const API_VERSION = "5.199";
const SOURCE_SCREEN_NAME = "funtime";
const RAID_PATTERN = /\[\s*рейд\s*\]/iu;
const LONG_POLL_WAIT = 25;

const SETUP_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FunTime Raid Bridge</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif}
body{margin:0;background:#10131b;color:#f2f4f8;min-height:100vh;display:grid;place-items:center;padding:18px}
main{width:min(100%,440px);background:#1b2130;border:1px solid #30394c;border-radius:18px;padding:22px;box-sizing:border-box}
h1{font-size:23px;margin:0 0 8px}p{color:#aeb8c9;line-height:1.5}
input{width:100%;box-sizing:border-box;padding:13px;border-radius:10px;border:1px solid #46516a;background:#101521;color:white;font-size:16px;margin:10px 0}
button{border:0;border-radius:10px;padding:12px 15px;font-size:15px;font-weight:650;cursor:pointer;margin:5px 5px 5px 0;background:#5865f2;color:white}
button.secondary{background:#39445b}pre{white-space:pre-wrap;word-break:break-word;background:#101521;border-radius:10px;padding:12px;color:#c9d4e5;min-height:48px}
small{color:#8995a9}
</style>
</head>
<body><main>
<h1>FunTime Raid Bridge</h1>
<p>Мост пересылает только входящие сообщения от сообщества FunTime с меткой <b>[Рейд]</b> в выбранный Discord-канал.</p>
<label for="key">Пароль управления (SETUP_PASSWORD)</label>
<input id="key" type="password" autocomplete="current-password" placeholder="Введи пароль управления">
<div>
<button onclick="run('start')">Запустить</button>
<button class="secondary" onclick="run('status')">Статус</button>
<button class="secondary" onclick="run('test')">Тест Discord</button>
<button class="secondary" onclick="run('stop')">Остановить</button>
</div>
<pre id="out">Ожидаю команду.</pre>
<small>Не отправляй пароль или VK-токен в чаты. Пароль используется только для управления этим Worker.</small>
<script>
async function run(action){
 const out=document.getElementById('out'); const key=document.getElementById('key').value;
 if(!key){out.textContent='Введи пароль управления.';return}
 out.textContent='Выполняю...';
 try{
  const r=await fetch('/'+action,{method:'POST',headers:{'Authorization':'Bearer '+key}});
  const t=await r.text(); let d; try{d=JSON.parse(t)}catch{d={message:t}}
  out.textContent=JSON.stringify(d,null,2);
 }catch(e){out.textContent='Ошибка: '+e.message}
}
</script>
</main></body></html>`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function cleanText(value) {
  return String(value ?? "").replace(/@(?=everyone|here)/giu, "@\u200b").trim();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/setup")) {
      return new Response(SETUP_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "funtime-raid-bridge" });
    }

    const allowed = new Set(["/start", "/stop", "/status", "/test"]);
    if (!allowed.has(url.pathname) || request.method !== "POST) {
      return json({ error: "Not found" }, 404);
    }

    if (!env.SETUP_PASSWORD) {
      return json({ error: "SETUP_PASSWORD secret is not configured in Cloudflare." }, 503);
    }

    const auth = request.headers.get("authorization") || "";
    if (auth !== `Bearer ${env.SETUP_PASSWORD}`) {
      return json({ error: "Wrong setup password." }, 401);
    }

    if (url.pathname === "/start" && (!env.VK_ACCESS_TOKEN || !env.DISCORD_WEBHOOK_URL)) {
      return json({ error: "Add VK_ACCESS_TOKEN and DISCORD_WEBHOOK_URL in Cloudflare Worker secrets first." }, 503);
    }

    const id = env.BRIDGE.idFromName("funtime-main");
    const stub = env.BRIDGE.get(id);
    return stub.fetch(new Request(`https://bridge.internal${url.pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" }
    }));
  },

  async scheduled(_event, env, ctx) {
    const id = env.BRIDGE.idFromName("funtime-main");
    const stub = env.BRIDGE.get(id);
    ctx.waitUntil(stub.fetch("https://bridge.internal/ensure", { method: "POST" }));
  }
};

export class VkBridge {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/start") {
      await this.storage.put("enabled", true);
      await this.storage.setAlarm(Date.now() + 100);
      return json({ ok: true, enabled: true, message: "Мост запускается. Первое подключение к VK может занять несколько секунд." });
    }

    if (path === "/stop") {
      await this.storage.put("enabled", false);
      await this.storage.deleteAlarm();
      return json({ ok: true, enabled: false });
    }

    if (path === "/ensure") {
      if (await this.storage.get("enabled")) {
        const alarm = await this.storage.getAlarm();
        if (alarm === null) await this.storage.setAlarm(Date.now() + 100);
      }
      return json({ ok: true });
    }

    if (path === "/status") {
      const pending = await this.storage.get("pending") || [];
      return json({
        enabled: Boolean(await this.storage.get("enabled")),
        source: "VK DM: @funtime",
        filter: "[Рейд]",
        groupId: await this.storage.get("groupId") || null,
        lastPollAt: await this.storage.get("lastPollAt") || null,
        lastSentAt: await this.storage.get("lastSentAt") || null,
        sentCount: await this.storage.get("sentCount") || 0,
        pendingCount: pending.length,
        lastError: await this.storage.get("lastError") || null
      });
    }

    if (path === "/test") {
      try {
        await this.sendDiscord("🔧 **Тестовое сообщение**\nСвязь с Discord работает. Источник: FunTime.");
        return json({ ok: true, message: "Тест отправлен в Discord." });
      } catch (error) {
        return json({ ok: false, error: error.message }, 502);
      }
    }

    return json({ error: "Not found" }, 404);
  }

  async alarm() {
    if (!(await this.storage.get("enabled"))) return;

    let nextDelay = 5000;
    try {
      await this.pollOnce();
      const delivered = await this.flushPending();
      const pending = await this.storage.get("pending") || [];
      nextDelay = delivered && pending.length === 0 ? 250 : 5000;
      await this.storage.put("lastError", null);
    } catch (error) {
      await this.storage.put("lastError", String(error?.message || error).slice(0, 500));
      nextDelay = 5000;
    }

    if (await this.storage.get("enabled")) {
      await this.storage.setAlarm(Date.now() + nextDelay);
    }
  }

  async vkApi(method, params = {}) {
    const body = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      access_token: this.env.VK_ACCESS_TOKEN,
      v: API_VERSION
    });
    const response = await fetch(`https://api.vk.com/method/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) throw new Error(`VK HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) {
      throw new Error(`VK API ${data.error.error_code}: ${data.error.error_msg}`);
    }
    return data.response;
  }

  async resolveGroupId() {
    let groupId = await this.storage.get("groupId");
    if (groupId) return groupId;

    const result = await this.vkApi("utils.resolveScreenName", { screen_name: SOURCE_SCREEN_NAME });
    if (!result || result.type !== "group" || !result.object_id) {
      throw new Error("VK не смог определить сообщество @funtime через utils.resolveScreenName.");
    }
    groupId = Number(result.object_id);
    await this.storage.put("groupId", groupId);
    return groupId;
  }

  async getLongPollSession() {
    const response = await this.vkApi("messages.getLongPollServer", {
      need_pts: 1,
      lp_version: 3
    });
    if (!response?.server || !response?.key || response.ts === undefined) {
      throw new Error("VK вернул неполные данные Long Poll.");
    }
    const session = {
      server: response.server,
      key: response.key,
      ts: response.ts,
      pts: response.pts ?? null
    };
    await this.storage.put("vkSession", session);
    return session;
  }

  async pollOnce() {
    if (!this.env.VK_ACCESS_TOKEN) throw new Error("VK_ACCESS_TOKEN не задан.");

    const groupId = await this.resolveGroupId();
    let session = await this.storage.get("vkSession");
    if (!session) session = await this.getLongPollSession();

    const server = String(session.server).startsWith("http")
      ? String(session.server)
      : `https://${session.server}`;
    const pollUrl = new URL(server);
    pollUrl.searchParams.set("act", "a_check");
    pollUrl.searchParams.set("key", session.key);
    pollUrl.searchParams.set("ts", String(session.ts));
    pollUrl.searchParams.set("wait", String(LONG_POLL_WAIT));
    pollUrl.searchParams.set("mode", "34");
    pollUrl.searchParams.set("version", "3");

    const response = await fetch(pollUrl.toString());
    if (!response.ok) throw new Error(`VK Long Poll HTTP ${response.status}`);
    const result = await response.json();

    if (result.failed) {
      if (result.failed === 1 && result.ts !== undefined) {
        session.ts = result.ts;
        await this.storage.put("vkSession", session);
        return;
      }
      if ([2, 3].includes(result.failed)) {
        await this.storage.delete("vkSession");
        return;
      }
      if (result.failed === 4) {
        throw new Error("VK Long Poll не поддерживает выбранную версию протокола.");
      }
      throw new Error(`VK Long Poll вернул ошибку ${result.failed}.`);
    }

    if (result.ts !== undefined) session.ts = result.ts;
    if (result.pts !== undefined) session.pts = result.pts;
    await this.storage.put("vkSession", session);
    await this.storage.put("lastPollAt", Date.now());

    const pending = await this.storage.get("pending") || [];
    const pendingIds = new Set(pending.map(item => String(item.id)));
    const seenIds = await this.storage.get("seenIds") || [];
    const seen = new Set(seenIds.map(String));

    for (const event of result.updates || []) {
      if (!Array.isArray(event) || event[0] !== 4) continue;

      const messageId = String(event[1]);
      const flags = Number(event[2] || 0);
      const peerId = Number(event[3] || 0);
      const text = String(event[5] || "").trim();

      // Bit 2 marks an outgoing message. Only incoming messages from the FunTime DM are accepted.
      if ((flags & 2) !== 0) continue;
      if (Math.abs(peerId) !== groupId) continue;
      if (!RAID_PATTERN.test(text)) continue;
      if (seen.has(messageId) || pendingIds.has(messageId)) continue;

      pending.push({
        id: messageId,
        text: cleanText(text).slice(0, 1700),
        timestamp: Number(event[4] || Math.floor(Date.now() / 1000))
      });
      pendingIds.add(messageId);
    }

    if (pending.length > 500) pending.splice(0, pending.length - 500);
    await this.storage.put("pending", pending);
  }

  async sendDiscord(text) {
    if (!this.env.DISCORD_WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL не задан.");
    const response = await fetch(this.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "FunTime Raid Alert",
        content: text.slice(0, 1950),
        allowed_mentions: { parse: [] }
      })
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 180);
      throw new Error(`Discord webhook HTTP ${response.status}: ${detail}`);
    }
  }

  async flushPending() {
    const pending = await this.storage.get("pending") || [];
    const seenIds = await this.storage.get("seenIds") || [];
    const seen = new Set(seenIds.map(String));

    while (pending.length > 0) {
      const item = pending[0];
      const content = `💣 **НОВЫЙ РЕЙД FUNTime**\n${item.text}\n\nИсточник: https://vk.com/funtime`;
      try {
        await this.sendDiscord(content);
      } catch (error) {
        await this.storage.put("lastError", String(error?.message || error).slice(0, 500));
        await this.storage.put("pending", pending);
        return false;
      }

      pending.shift();
      seen.add(String(item.id));
      await this.storage.put("pending", pending);
      await this.storage.put("seenIds", Array.from(seen).slice(-300));
      await this.storage.put("lastSentAt", Date.now());
      await this.storage.put("sentCount", (await this.storage.get("sentCount") || 0) + 1);
    }

    return true;
  }
}
