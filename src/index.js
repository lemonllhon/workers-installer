const INSTALL_PATH = "/install.sh";
const INSTALL_ALIASES = new Set([INSTALL_PATH, "/inatall.sh"]);
const TEAMNODE_RELAY_PATHS = new Set([
  "/api/internal/nodejs-argo/registrations",
  "/api/internal/nodejs-argo/heartbeats",
  "/api/internal/nodejs-argo/offline"
]);
const TEAMNODE_REDEEM_PATH = "/api/teamnode/redeem";
const DASHBOARD_API_PATH = "/api/nodes";
const DEFAULT_TEAMNODE_UPSTREAM_BASE_URL = "https://teamnode.lemon.vin";
const DEFAULT_TEAMNODE_KEY_ID = "nodejs-argo-prod";
const DEFAULT_ONLINE_TTL_MS = 10 * 60 * 1000;
const NODE_REGISTRY_NAME = "nodejs-argo";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function sha256LowerHex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(leftValue, rightValue) {
  const left = new TextEncoder().encode(String(leftValue || ""));
  const right = new TextEncoder().encode(String(rightValue || ""));
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function safeNodeId(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : "";
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function hmacSha256Hex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(value || ""))
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveRelayToken(syncSecret, uuid) {
  const material = `nodejs-argo-relay-v1\n${String(uuid || "").trim()}`;
  return `relay_v1_${await hmacSha256Hex(syncSecret, material)}`;
}

function getRegistryStub(env) {
  if (!env.NODE_REGISTRY) return null;
  const id = env.NODE_REGISTRY.idFromName(NODE_REGISTRY_NAME);
  return env.NODE_REGISTRY.get(id);
}

function onlineTtlMs(env) {
  const configured = Number.parseInt(String(env.TEAMNODE_DASHBOARD_ONLINE_TTL_MS || ""), 10);
  return Number.isFinite(configured) && configured >= 30000
    ? configured
    : DEFAULT_ONLINE_TTL_MS;
}

async function recordNodeEvent(request, env, payload, eventPath) {
  const stub = getRegistryStub(env);
  if (!stub) return;

  const uuid = safeNodeId(payload?.uuid);
  if (!uuid) return;

  const status = eventPath.endsWith("/offline") ? "offline" : "online";
  const event = {
    uuid,
    status,
    eventPath,
    lastSeen: status === "online" ? Date.now() : null,
    lastEventAt: Date.now(),
    sourceIp: request.headers.get("CF-Connecting-IP") || null,
    country: request.cf?.country || null,
    colo: request.cf?.colo || null,
    label: String(payload?.label || "").slice(0, 128),
    argoDomain: String(payload?.argoDomain || "").slice(0, 253),
    provider: String(payload?.provider || "").slice(0, 64),
    countryCode: String(payload?.countryCode || "").slice(0, 16),
    countryName: String(payload?.countryName || "").slice(0, 128),
    runtimeStatus: String(payload?.runtimeStatus || "").slice(0, 32),
    contentIncluded: Boolean(payload?.contentBase64),
    updatedAt: Date.now()
  };

  await stub.fetch("https://node-registry/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event)
  });
}

async function listNodeEvents(env) {
  const stub = getRegistryStub(env);
  if (!stub) return null;

  const query = new URLSearchParams({
    now: String(Date.now()),
    ttl: String(onlineTtlMs(env))
  });
  const response = await stub.fetch(`https://node-registry/online?${query}`);
  if (!response.ok) throw new Error("node_registry_unavailable");
  const data = await response.json();
  return Array.isArray(data.nodes) ? data.nodes : [];
}

function dashboardUser(env) {
  return String(env.DASHBOARD_USER || "admin").trim() || "admin";
}

function dashboardUnauthorizedResponse() {
  return new Response("Dashboard authentication required\n", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": 'Basic realm="nodejs-argo dashboard", charset="UTF-8"',
      "cache-control": "no-store"
    }
  });
}

function dashboardAuthResponse(request, env) {
  const password = String(env.DASHBOARD_PASSWORD || "");
  if (!password) {
    return null;
  }

  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Basic ")) {
    return dashboardUnauthorizedResponse();
  }

  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(":");
    const user = separator >= 0 ? decoded.slice(0, separator) : "";
    const presentedPassword = separator >= 0 ? decoded.slice(separator + 1) : "";
    if (
      constantTimeEqual(user, dashboardUser(env))
      && constantTimeEqual(presentedPassword, password)
    ) {
      return null;
    }
  } catch {
    // Fall through to the same generic authentication response.
  }

  return dashboardUnauthorizedResponse();
}

function decorateNodeStatus(nodes, env) {
  const now = Date.now();
  const ttl = onlineTtlMs(env);
  return nodes
    .map((node) => ({
      ...node,
      online: node.status === "online"
        && Number.isFinite(Number(node.lastSeen))
        && now - Number(node.lastSeen) <= ttl
    }))
    .sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      return Number(right.lastSeen || right.lastEventAt || 0) - Number(left.lastSeen || left.lastEventAt || 0);
    });
}

async function dashboardNodesResponse(request, env) {
  const authError = dashboardAuthResponse(request, env);
  if (authError) return authError;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  try {
    const nodes = decorateNodeStatus(await listNodeEvents(env) || [], env);
    return json({
      ok: true,
      onlineTtlMs: onlineTtlMs(env),
      generatedAt: Date.now(),
      nodes
    });
  } catch (error) {
    return json({ error: "node_registry_unavailable", message: String(error?.message || error) }, 503);
  }
}

function dashboardTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return new Date(timestamp).toISOString();
}

async function dashboardPageResponse(request, env) {
  const authError = dashboardAuthResponse(request, env);
  if (authError) return authError;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  try {
    const nodes = decorateNodeStatus(await listNodeEvents(env) || [], env).filter((node) => node.online);
    const onlineCount = nodes.length;
    const ttlMinutes = Math.max(1, Math.round(onlineTtlMs(env) / 60000));
    const isOperational = onlineCount > 0;
    const overviewLabel = isOperational ? "全部系统运行正常" : "暂无在线机器";
    const overviewDetail = isOperational
      ? String(onlineCount) + " 台机器正在发送心跳，最近 " + String(ttlMinutes) + " 分钟内保持在线。"
      : "等待机器发送心跳；超过 " + String(ttlMinutes) + " 分钟未收到心跳的机器会自动移出列表。";
    const overviewClass = isOperational ? "operational" : "attention";
    const rows = nodes.length > 0
      ? nodes.map((node) => `
        <tr>
          <td><span class="badge ${node.online ? "online" : "offline"}">${node.online ? "在线" : node.status === "offline" ? "已下线" : "超时"}</span></td>
          <td>${htmlEscape(node.sourceIp || "-")}</td>
          <td>${htmlEscape(node.label || "-")}</td>
          <td>${htmlEscape(node.argoDomain || "-")}</td>
          <td>${htmlEscape(node.country || node.countryName || "-")}</td>
          <td>${htmlEscape(node.provider || "-")}</td>
          <td>${htmlEscape(dashboardTime(node.lastSeen || node.lastEventAt))}</td>
        </tr>`).join("")
      : '<tr><td class="empty" colspan="7">暂无在线机器</td></tr>';

    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>lemon-监控面板</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --ink: #202124;
      --muted: #6b7280;
      --line: #e5e7eb;
      --surface: #ffffff;
      --canvas: #fafafa;
      --green: #16803c;
      --green-soft: #e7f6ec;
      --amber: #9a6700;
      --amber-soft: #fff7df;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: var(--canvas); color: var(--ink); }
    main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 28px 0 64px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 4px 0 36px; }
    .brand { display: inline-flex; align-items: center; gap: 12px; color: inherit; text-decoration: none; }
    .brand img { width: 38px; height: 38px; border-radius: 50%; }
    .brand-name { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
    .brand-context { margin-left: 8px; color: var(--muted); font-size: 14px; font-weight: 500; }
    .live-meta { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
    .live-dot, .service-dot { width: 9px; height: 9px; border-radius: 50%; background: #22a652; box-shadow: 0 0 0 4px #22a6521c; }
    .service-dot.attention { background: #d18b00; box-shadow: 0 0 0 4px #d18b001c; }
    .hero { display: flex; align-items: flex-start; gap: 18px; padding: 30px 32px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; }
    .hero-icon { display: grid; flex: 0 0 42px; place-items: center; width: 42px; height: 42px; border-radius: 50%; color: var(--green); background: var(--green-soft); font-size: 24px; font-weight: 800; }
    .hero-icon.attention { color: var(--amber); background: var(--amber-soft); }
    .eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(25px, 4vw, 34px); letter-spacing: -.035em; line-height: 1.15; }
    .hero-detail { margin: 10px 0 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
    .section { margin-top: 46px; }
    .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
    h2 { margin: 0; font-size: 21px; letter-spacing: -.02em; }
    .count { color: var(--muted); font-size: 13px; }
    .service-list, .node-card { overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
    .service-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px 22px; border-bottom: 1px solid var(--line); }
    .service-row:last-child { border-bottom: 0; }
    .service-main { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .service-copy { min-width: 0; }
    .service-name { display: block; font-size: 14px; font-weight: 650; }
    .service-description { display: block; margin-top: 4px; overflow: hidden; color: var(--muted); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .service-state { color: var(--green); font-size: 13px; font-weight: 650; white-space: nowrap; }
    .node-card { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 920px; }
    th, td { padding: 16px 18px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
    th { color: var(--muted); font-size: 12px; font-weight: 650; letter-spacing: .02em; }
    td { font-size: 14px; }
    tr:last-child td { border-bottom: 0; }
    .badge { display: inline-flex; align-items: center; gap: 7px; color: var(--green); font-size: 13px; font-weight: 650; }
    .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #22a652; }
    .empty { padding: 34px; text-align: center; color: var(--muted); }
    .footer { margin: 18px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
    @media (max-width: 640px) {
      main { width: min(100% - 28px, 1120px); padding-top: 18px; }
      .topbar { align-items: flex-start; padding-bottom: 26px; }
      .brand-context { display: block; margin: 3px 0 0; }
      .live-meta { padding-top: 7px; }
      .hero { padding: 24px 20px; }
      .section { margin-top: 34px; }
      .service-row { align-items: flex-start; padding: 16px; }
      .service-state { padding-top: 1px; }
    }
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <a class="brand" href="/">
        <img src="/favicon.png" alt="">
        <span><span class="brand-name">lemon</span><span class="brand-context">监控面板</span></span>
      </a>
      <div class="live-meta"><span class="live-dot"></span><span>实时监控</span><span id="last-updated">刚刚更新</span></div>
    </header>

    <section class="hero" aria-live="polite">
      <div id="overview-icon" class="hero-icon ${overviewClass}">${isOperational ? "✓" : "!"}</div>
      <div>
        <p class="eyebrow">当前状态</p>
        <h1 id="overview-label">${overviewLabel}</h1>
        <p id="overview-detail" class="hero-detail">${overviewDetail}</p>
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <div><p class="eyebrow">System status</p><h2>系统状态</h2></div>
        <span id="dashboard-count" class="count">${onlineCount} 台在线</span>
      </div>
      <div class="service-list">
        <div class="service-row">
          <div class="service-main"><span id="heartbeat-dot" class="service-dot ${isOperational ? "operational" : "attention"}"></span><span class="service-copy"><span class="service-name">TeamNode 心跳</span><span class="service-description" id="heartbeat-description">${onlineCount > 0 ? String(onlineCount) + " 台机器正在上报状态" : "当前没有收到在线机器的心跳"}</span></span></div>
          <span id="heartbeat-state" class="service-state">${onlineCount > 0 ? "正常" : "等待中"}</span>
        </div>
        <div class="service-row">
          <div class="service-main"><span id="node-dot" class="service-dot ${isOperational ? "operational" : "attention"}"></span><span class="service-copy"><span class="service-name">节点连接</span><span class="service-description" id="node-description">${onlineCount > 0 ? "在线节点可继续提供订阅和连接" : "在线节点恢复后会显示在下方"}</span></span></div>
          <span id="node-state" class="service-state">${onlineCount > 0 ? "正常" : "等待中"}</span>
        </div>
        <div class="service-row">
          <div class="service-main"><span class="service-dot"></span><span class="service-copy"><span class="service-name">监控面板</span><span class="service-description">Worker API 和节点列表可用</span></span></div>
          <span class="service-state">正常</span>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <div><p class="eyebrow">Online nodes</p><h2>在线机器</h2></div>
        <span id="node-count" class="count">${onlineCount} 台</span>
      </div>
      <div class="node-card">
        <table>
          <thead><tr><th>状态</th><th>来源 IP</th><th>名称</th><th>ARGO_DOMAIN</th><th>地区</th><th>Provider</th><th>最后心跳</th></tr></thead>
          <tbody id="node-rows">${rows}
          </tbody>
        </table>
      </div>
    </section>
    <p id="dashboard-status" class="footer">每 30 秒自动更新节点内容，不会刷新整个页面。来源 IP 为 Cloudflare 看到的设备出口 IP；如果设备经过 NAT 或代理，这可能是 NAT/代理出口地址。</p>
  </main>
  <script>
    (() => {
      const rowsElement = document.getElementById("node-rows");
      const overviewIconElement = document.getElementById("overview-icon");
      const overviewLabelElement = document.getElementById("overview-label");
      const overviewDetailElement = document.getElementById("overview-detail");
      const dashboardCountElement = document.getElementById("dashboard-count");
      const nodeCountElement = document.getElementById("node-count");
      const heartbeatDescriptionElement = document.getElementById("heartbeat-description");
      const heartbeatStateElement = document.getElementById("heartbeat-state");
      const heartbeatDotElement = document.getElementById("heartbeat-dot");
      const nodeDescriptionElement = document.getElementById("node-description");
      const nodeStateElement = document.getElementById("node-state");
      const nodeDotElement = document.getElementById("node-dot");
      const lastUpdatedElement = document.getElementById("last-updated");
      const statusElement = document.getElementById("dashboard-status");
      let refreshing = false;

      function escapeHtml(value) {
        const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
        return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
      }

      function formatTime(value) {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
        return new Date(timestamp).toISOString();
      }

      function renderRows(nodes) {
        if (!nodes.length) {
          return '<tr><td class="empty" colspan="7">暂无在线机器</td></tr>';
        }

        return nodes.map((node) => {
          const status = node.online ? "在线" : (node.status === "offline" ? "已下线" : "超时");
          const statusClass = node.online ? "online" : "offline";
          return "<tr>"
            + "<td><span class=\"badge " + statusClass + "\">" + status + "</span></td>"
            + "<td>" + escapeHtml(node.sourceIp || "-") + "</td>"
            + "<td>" + escapeHtml(node.label || "-") + "</td>"
            + "<td>" + escapeHtml(node.argoDomain || "-") + "</td>"
            + "<td>" + escapeHtml(node.country || node.countryName || "-") + "</td>"
            + "<td>" + escapeHtml(node.provider || "-") + "</td>"
            + "<td>" + escapeHtml(formatTime(node.lastSeen || node.lastEventAt)) + "</td>"
            + "</tr>";
        }).join("");
      }

      async function refreshNodes() {
        if (refreshing) return;
        refreshing = true;
        try {
          const response = await fetch("/api/nodes", {
            cache: "no-store",
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
          });
          if (!response.ok) throw new Error("HTTP " + response.status);

          const data = await response.json();
          if (!data || !Array.isArray(data.nodes)) throw new Error("invalid_dashboard_response");

          const onlineNodes = data.nodes.filter((node) => node && node.online);
          const ttlMinutes = Math.max(1, Math.round(Number(data.onlineTtlMs || 600000) / 60000));
          const operational = onlineNodes.length > 0;
          rowsElement.innerHTML = renderRows(onlineNodes);
          overviewIconElement.className = "hero-icon " + (operational ? "operational" : "attention");
          overviewIconElement.textContent = operational ? "✓" : "!";
          overviewLabelElement.textContent = operational ? "全部系统运行正常" : "暂无在线机器";
          overviewDetailElement.textContent = operational
            ? onlineNodes.length + " 台机器正在发送心跳，最近 " + ttlMinutes + " 分钟内保持在线。"
            : "等待机器发送心跳；超过 " + ttlMinutes + " 分钟未收到心跳的机器会自动移出列表。";
          dashboardCountElement.textContent = onlineNodes.length + " 台在线";
          nodeCountElement.textContent = onlineNodes.length + " 台";
          heartbeatDescriptionElement.textContent = operational
            ? onlineNodes.length + " 台机器正在上报状态"
            : "当前没有收到在线机器的心跳";
          heartbeatStateElement.textContent = operational ? "正常" : "等待中";
          heartbeatDotElement.className = "service-dot " + (operational ? "operational" : "attention");
          nodeDescriptionElement.textContent = operational
            ? "在线节点可继续提供订阅和连接"
            : "在线节点恢复后会显示在下方";
          nodeStateElement.textContent = operational ? "正常" : "等待中";
          nodeDotElement.className = "service-dot " + (operational ? "operational" : "attention");
          lastUpdatedElement.textContent = "刚刚更新";
          statusElement.textContent = "最后更新：" + new Date().toLocaleString() + "；每 30 秒自动更新节点内容，不会刷新整个页面。来源 IP 为 Cloudflare 看到的设备出口 IP，如果设备经过 NAT 或代理，这可能是 NAT/代理出口地址。";
        } catch (error) {
          statusElement.textContent = "内容刷新失败（" + String(error?.message || error) + "），保留上次数据显示。";
        } finally {
          refreshing = false;
        }
      }

      window.setInterval(refreshNodes, 30000);
    })();
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff"
      }
    });
  } catch (error) {
    return json({ error: "node_registry_unavailable", message: String(error?.message || error) }, 503);
  }
}

async function relayTeamNodeRequest(request, env, ctx) {
  if (!TEAMNODE_RELAY_PATHS.has(new URL(request.url).pathname)) {
    return null;
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const syncSecret = String(env.TEAMNODE_SYNC_SECRET || "");
  if (!syncSecret) {
    return json({ error: "teamnode_sync_secret_not_configured" }, 503);
  }

  const url = new URL(request.url);
  const body = await request.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const uuid = String(payload?.uuid || "").trim();
  if (!uuid || uuid.length > 128 || /[\r\n]/.test(uuid)) {
    return json({ error: "invalid_node_uuid" }, 400);
  }

  const configuredRelayToken = String(env.TEAMNODE_SYNC_RELAY_TOKEN || "").trim();
  const expectedRelayToken = configuredRelayToken || await deriveRelayToken(syncSecret, uuid);
  const presentedToken = request.headers.get("x-teamnode-sync-relay-token") || "";
  if (!constantTimeEqual(presentedToken, expectedRelayToken)) {
    return json({ error: "teamnode_relay_unauthorized" }, 401);
  }

  const timestamp = Date.now().toString();
  const nonce = randomToken();
  const eventId = `worker_relay_${randomToken().replace(/-/g, "")}`;
  const signaturePayload = [
    request.method.toUpperCase(),
    url.pathname,
    await sha256LowerHex(new TextEncoder().encode(body)),
    timestamp,
    nonce,
    eventId
  ].join("\n");
  const signature = await hmacSha256Hex(syncSecret, signaturePayload);

  const upstreamBaseUrl = String(
    env.TEAMNODE_SYNC_UPSTREAM_BASE_URL || DEFAULT_TEAMNODE_UPSTREAM_BASE_URL
  ).trim().replace(/\/+$/, "");
  const upstreamUrl = `${upstreamBaseUrl}${url.pathname}${url.search}`;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": request.headers.get("content-type") || "application/json",
        "x-sync-key-id": String(env.TEAMNODE_SYNC_KEY_ID || DEFAULT_TEAMNODE_KEY_ID),
        "x-sync-timestamp": timestamp,
        "x-sync-nonce": nonce,
        "x-event-id": eventId,
        "x-sync-signature": signature
      },
      body
    });

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.delete("set-cookie");

    if (upstreamResponse.ok) {
      const persistPromise = recordNodeEvent(request, env, payload, url.pathname)
        .catch((error) => console.error(`节点状态记录失败：${error?.message || error}`));
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(persistPromise);
      } else {
        await persistPromise;
      }
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders
    });
  } catch (error) {
    return json({ error: "teamnode_upstream_unreachable", message: String(error?.message || error) }, 502);
  }
}

async function redeemTeamNodeRelayToken(request, env) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const enrollmentPassword = String(env.TEAMNODE_SYNC_ENROLL_PASSWORD || "");
  const syncSecret = String(env.TEAMNODE_SYNC_SECRET || "");
  if (!enrollmentPassword || !syncSecret) {
    return json({ error: "teamnode_enrollment_not_configured" }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const presentedPassword = String(payload?.password || "");
  if (!constantTimeEqual(presentedPassword, enrollmentPassword)) {
    return json({ error: "invalid_enrollment_password" }, 401);
  }

  const uuid = String(payload?.uuid || "").trim();
  if (!uuid || uuid.length > 128 || /[\r\n]/.test(uuid)) {
    return json({ error: "invalid_node_uuid" }, 400);
  }

  return json({ relayToken: await deriveRelayToken(syncSecret, uuid), uuid });
}

export class NodeRegistry {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/record" && request.method === "POST") {
      let event;
      try {
        event = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const uuid = safeNodeId(event?.uuid);
      if (!uuid) return json({ error: "invalid_node_uuid" }, 400);

      const key = `node:${uuid}`;
      if (event.status === "offline") {
        await this.state.storage.delete(key);
        return json({ ok: true, removed: true });
      }

      const previous = (await this.state.storage.get(key)) || {};
      const record = {
        ...previous,
        ...event,
        uuid,
        status: "online",
        lastSeen: Number(event.lastSeen || Date.now()),
        lastEventAt: Number(event.lastEventAt || Date.now()),
        updatedAt: Number(event.updatedAt || Date.now())
      };

      await this.state.storage.put(key, record);
      return json({ ok: true });
    }

    if (url.pathname === "/online" && request.method === "GET") {
      const now = Number.parseInt(url.searchParams.get("now") || "", 10) || Date.now();
      const ttl = Number.parseInt(url.searchParams.get("ttl") || "", 10) || DEFAULT_ONLINE_TTL_MS;
      const entries = await this.state.storage.list({ prefix: "node:" });
      const nodes = [];

      for (const [key, value] of entries) {
        const lastSeen = Number(value?.lastSeen || 0);
        if (value?.status !== "online" || !lastSeen || now - lastSeen > ttl) {
          await this.state.storage.delete(key);
          continue;
        }
        nodes.push(value);
      }

      return json({ nodes });
    }

    return json({ error: "not_found" }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return dashboardPageResponse(request, env);
    }

    if (url.pathname === DASHBOARD_API_PATH) {
      return dashboardNodesResponse(request, env);
    }

    if (url.pathname === TEAMNODE_REDEEM_PATH) {
      return redeemTeamNodeRelayToken(request, env);
    }

    if (TEAMNODE_RELAY_PATHS.has(url.pathname)) {
      return relayTeamNodeRequest(request, env, ctx);
    }

    if (url.pathname === "/healthz") {
      return json({ ok: true, service: "nodejs-argo-installer" });
    }

    if (INSTALL_ALIASES.has(url.pathname)) {
      if (request.method !== "GET") {
        return json({ error: "method_not_allowed" }, 405);
      }

      const assetRequest = new Request(new URL(INSTALL_PATH, request.url), request);
      const asset = await env.ASSETS.fetch(assetRequest);
      if (!asset.ok) {
        return json({ error: "installer_not_found" }, 404);
      }

      const sourceAsset = await env.ASSETS.fetch(new Request(new URL("/agent/index.js", request.url), request));
      if (!sourceAsset.ok) {
        return json({ error: "agent_not_found" }, 500);
      }
      const sourceSha256 = await sha256Hex(await sourceAsset.arrayBuffer());

      const sourceBaseUrl = `${url.origin}/agent`;
      const installerText = (await asset.text()).replaceAll(
        "__WORKER_SOURCE_BASE_URL__",
        sourceBaseUrl
      ).replaceAll("__WORKER_SOURCE_SHA256__", sourceSha256)
        .replaceAll("__WORKER_SYNC_BASE_URL__", url.origin);
      const headers = new Headers(asset.headers);
      headers.set("content-type", "text/x-shellscript; charset=utf-8");
      headers.set("cache-control", "no-store, max-age=0");
      headers.set("content-disposition", "inline; filename=install.sh");
      return new Response(installerText, { status: asset.status, headers });
    }

    return env.ASSETS.fetch(request);
  }
};
