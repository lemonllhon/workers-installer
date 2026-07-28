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
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ONLINE_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_HISTORY_LIMIT = 72;
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

function normalizeRuntimeInfo(value) {
  if (!value || typeof value !== "object") return null;

  const cpuCores = Number.parseInt(String(value.cpuCores || ""), 10);
  const memoryMb = Number.parseInt(String(value.memoryMb || ""), 10);
  return {
    platform: String(value.platform || "").slice(0, 32),
    arch: String(value.arch || "").slice(0, 32),
    osType: String(value.osType || "").slice(0, 64),
    osRelease: String(value.osRelease || "").slice(0, 128),
    cpuCores: Number.isFinite(cpuCores) && cpuCores > 0 ? Math.min(cpuCores, 4096) : null,
    memoryMb: Number.isFinite(memoryMb) && memoryMb > 0 ? Math.min(memoryMb, 16 * 1024 * 1024) : null
  };
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

function heartbeatTimeoutMs(env) {
  const configured = Number.parseInt(String(env.TEAMNODE_DASHBOARD_HEARTBEAT_TIMEOUT_MS || ""), 10);
  return Number.isFinite(configured) && configured >= 30000
    ? Math.min(configured, onlineTtlMs(env))
    : Math.min(DEFAULT_HEARTBEAT_TIMEOUT_MS, onlineTtlMs(env));
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
    runtimeInfo: normalizeRuntimeInfo(payload?.runtimeInfo),
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
  const timeout = heartbeatTimeoutMs(env);
  const ttl = onlineTtlMs(env);
  return nodes
    .map((node) => ({
      ...node,
      online: node.status === "online"
        && Number.isFinite(Number(node.lastSeen))
        && now - Number(node.lastSeen) <= timeout,
      timedOut: node.status === "online"
        && Number.isFinite(Number(node.lastSeen))
        && now - Number(node.lastSeen) > timeout
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
      heartbeatTimeoutMs: heartbeatTimeoutMs(env),
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

function heartbeatHistoryValues(node) {
  return (Array.isArray(node?.heartbeatHistory) ? node.heartbeatHistory : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(-HEARTBEAT_HISTORY_LIMIT);
}

function runtimeSummary(node) {
  const info = node?.runtimeInfo || {};
  const system = [info.osType || info.platform, info.osRelease]
    .filter(Boolean)
    .join(" ") || "-";
  const resources = [
    Number.isFinite(Number(info.cpuCores)) ? `${info.cpuCores} 核` : "",
    Number.isFinite(Number(info.memoryMb)) ? `${info.memoryMb} MB` : ""
  ].filter(Boolean).join(" / ") || "-";
  return {
    system,
    arch: info.arch || "-",
    resources
  };
}

function heartbeatSegments(node) {
  const history = heartbeatHistoryValues(node);
  const pulseClass = node?.timedOut ? "pulse-timeout" : "pulse-ok";
  return Array.from({ length: HEARTBEAT_HISTORY_LIMIT }, (_, index) => {
    const timestamp = history[index];
    if (!timestamp) return '<span class="pulse pulse-empty" aria-hidden="true"></span>';
    return `<span class="pulse ${pulseClass}" title="${htmlEscape(dashboardTime(timestamp))}" aria-label="心跳 ${htmlEscape(dashboardTime(timestamp))}"></span>`;
  }).join("");
}

async function dashboardPageResponse(request, env) {
  const authError = dashboardAuthResponse(request, env);
  if (authError) return authError;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  try {
    const nodes = decorateNodeStatus(await listNodeEvents(env) || [], env)
      .filter((node) => node.online || node.timedOut);
    const onlineCount = nodes.filter((node) => node.online).length;
    const timedOutCount = nodes.filter((node) => node.timedOut).length;
    const visibleCount = nodes.length;
    const ttlMinutes = Math.max(1, Math.round(onlineTtlMs(env) / 60000));
    const isOperational = onlineCount > 0 && timedOutCount === 0;
    const overviewLabel = timedOutCount > 0
      ? "部分节点心跳超时"
      : isOperational ? "全部系统运行正常" : "暂无在线机器";
    const overviewDetail = timedOutCount > 0
      ? String(timedOutCount) + " 台机器已超时并标记为灰色；超过 " + String(ttlMinutes) + " 分钟未收到心跳后自动移除。"
      : isOperational
        ? String(onlineCount) + " 台机器正在发送心跳，最近 " + String(ttlMinutes) + " 分钟内保持在线。"
        : "等待机器发送心跳；超过 " + String(ttlMinutes) + " 分钟未收到心跳的机器会自动移出列表。";
    const overviewClass = isOperational ? "operational" : "attention";
    const heartbeatDescription = timedOutCount > 0
      ? String(timedOutCount) + " 台机器心跳超时，恢复后会自动变绿"
      : onlineCount > 0 ? String(onlineCount) + " 台机器正在上报状态" : "当前没有收到在线机器的心跳";
    const heartbeatState = timedOutCount > 0 ? "有超时" : onlineCount > 0 ? "正常" : "等待中";
    const heartbeatStateClass = heartbeatState === "正常" ? "operational" : heartbeatState === "等待中" ? "waiting" : "attention";
    const nodeDescription = timedOutCount > 0
      ? String(timedOutCount) + " 台节点暂时不可用，仍保留 5 分钟"
      : onlineCount > 0 ? "在线节点可继续提供订阅和连接" : "在线节点恢复后会显示在下方";
    const nodeState = timedOutCount > 0 ? "部分异常" : onlineCount > 0 ? "正常" : "等待中";
    const nodeStateClass = nodeState === "正常" ? "operational" : nodeState === "等待中" ? "waiting" : "attention";
    const rows = nodes.length > 0
      ? nodes.map((node) => {
        const runtime = runtimeSummary(node);
        return `
        <article class="node-row">
          <div class="node-row-header">
            <div class="node-identity">
              <span class="badge ${node.online ? "online" : "offline"}">${node.online ? "在线" : node.status === "offline" ? "已下线" : "超时"}</span>
              <div class="node-title"><strong>${htmlEscape(node.label || "未命名节点")}</strong><span>${htmlEscape(node.argoDomain || "-")}</span></div>
            </div>
            <div class="node-last-seen">最后心跳<br><strong>${htmlEscape(dashboardTime(node.lastSeen || node.lastEventAt))}</strong></div>
          </div>
          <div class="heartbeat-strip${node.online ? " heartbeat-active" : ""}" aria-label="最近心跳记录">${heartbeatSegments(node)}</div>
          <div class="heartbeat-scale"><span>现在</span><span>${ttlMinutes} 分钟前</span></div>
          <div class="node-fields">
            <div><span>来源 IP</span><strong>${htmlEscape(node.sourceIp || "-")}</strong></div>
            <div><span>地区</span><strong>${htmlEscape(node.country || node.countryName || "-")}</strong></div>
            <div><span>Provider</span><strong>${htmlEscape(node.provider || "-")}</strong></div>
            <div><span>操作系统</span><strong>${htmlEscape(runtime.system)}</strong></div>
            <div><span>系统架构</span><strong>${htmlEscape(runtime.arch)}</strong></div>
            <div><span>CPU / 内存</span><strong>${htmlEscape(runtime.resources)}</strong></div>
          </div>
        </article>`;
      }).join("")
      : '<div class="empty">暂无在线机器</div>';

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
    main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 20px 0 44px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 2px 0 24px; }
    .brand { display: inline-flex; align-items: center; gap: 12px; color: inherit; text-decoration: none; }
    .brand img { width: 38px; height: 38px; border-radius: 50%; }
    .brand-name { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
    .brand-context { margin-left: 8px; color: var(--muted); font-size: 14px; font-weight: 500; }
    .live-meta { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
    .live-dot { width: 9px; height: 9px; border-radius: 50%; background: #22a652; box-shadow: 0 0 0 4px #22a6521c; }
    .hero { display: flex; align-items: center; gap: 13px; padding: 11px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
    .hero > div:last-child { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 13px; row-gap: 2px; min-width: 0; }
    .hero-icon { display: grid; flex: 0 0 32px; place-items: center; width: 32px; height: 32px; border-radius: 50%; color: var(--green); background: var(--green-soft); font-size: 18px; font-weight: 800; }
    .hero-icon.attention { color: var(--amber); background: var(--amber-soft); }
    .eyebrow { margin: 0 0 2px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .hero .eyebrow { flex: 0 0 100%; }
    h1 { margin: 0; font-size: clamp(20px, 3vw, 25px); letter-spacing: -.035em; line-height: 1.15; }
    .hero-detail { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.4; }
    .section { margin-top: 30px; }
    .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
    h2 { margin: 0; font-size: 21px; letter-spacing: -.02em; }
    .count { color: var(--muted); font-size: 13px; }
    .node-toolbar { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
    .filter-search { display: flex; align-items: center; flex: 1 1 320px; gap: 8px; min-width: 0; padding: 9px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--muted); }
    .filter-search span { font-size: 16px; line-height: 1; }
    .filter-search input, .node-toolbar select { min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: inherit; font-size: 13px; }
    .filter-search input { width: 100%; }
    .node-toolbar select { flex: 0 0 110px; padding: 9px 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
    .filter-clear { padding: 9px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--muted); cursor: pointer; font: inherit; font-size: 13px; }
    .filter-clear:hover { color: var(--ink); border-color: #c5cad1; }
    .filter-result { flex: 0 0 auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .service-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
    .service-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; min-width: 0; padding: 18px; border-right: 1px solid var(--line); }
    .service-row:last-child { border-right: 0; }
    .service-main { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
    .service-copy { min-width: 0; }
    .service-name { display: block; font-size: 14px; font-weight: 650; }
    .service-description { display: block; margin-top: 4px; overflow: hidden; color: var(--muted); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .service-state { flex: 0 0 auto; min-width: 42px; padding-top: 1px; color: var(--muted); font-size: 13px; font-weight: 700; white-space: nowrap; }
    .service-state.operational { color: var(--green); }
    .service-state.attention { color: var(--amber); }
    .service-state.waiting { color: var(--muted); }
    .node-card { overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
    .node-list { display: grid; }
    .node-row { min-width: 0; padding: 14px 18px; border-bottom: 1px solid var(--line); }
    .node-row:last-child { border-bottom: 0; }
    .node-row-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
    .node-identity { display: flex; align-items: flex-start; gap: 14px; min-width: 0; }
    .node-title { display: grid; min-width: 0; gap: 4px; }
    .node-title strong { overflow-wrap: anywhere; font-size: 15px; line-height: 1.35; }
    .node-title span { overflow-wrap: anywhere; color: var(--muted); font-size: 13px; }
    .node-last-seen { flex: 0 0 auto; color: var(--muted); font-size: 12px; line-height: 1.5; text-align: right; }
    .node-last-seen strong { color: var(--ink); font-size: 13px; font-weight: 600; }
    .heartbeat-strip { position: relative; display: grid; grid-template-columns: repeat(72, minmax(2px, 1fr)); align-items: end; gap: 3px; height: 24px; margin-top: 11px; overflow: hidden; isolation: isolate; }
    .heartbeat-strip.heartbeat-active::after { position: absolute; z-index: 2; top: -5px; bottom: -5px; left: -24%; width: 22%; content: ""; pointer-events: none; background: linear-gradient(90deg, transparent, rgba(239, 255, 246, .14) 28%, rgba(255, 255, 255, .78) 50%, rgba(239, 255, 246, .14) 72%, transparent); filter: blur(2px); animation: heartbeat-charge 3.8s linear infinite; }
    .pulse { position: relative; z-index: 1; display: block; min-width: 0; height: 18px; border-radius: 3px; background: #dff4e6; }
    .pulse-ok { height: 24px; background: #44d483; }
    .pulse-timeout { height: 24px; background: #e05252; }
    .pulse-empty { background: #eef0f2; }
    @keyframes heartbeat-charge { 0% { opacity: 0; transform: translateX(0); } 12% { opacity: .45; } 82% { opacity: .45; } 100% { opacity: 0; transform: translateX(565%); } }
    .heartbeat-scale { display: flex; justify-content: space-between; margin-top: 3px; color: var(--muted); font-size: 10px; }
    .node-fields { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin-top: 11px; padding-top: 10px; border-top: 1px solid #f0f1f2; }
    .node-fields div { display: grid; min-width: 0; gap: 5px; }
    .node-fields span { color: var(--muted); font-size: 11px; }
    .node-fields strong { overflow-wrap: anywhere; font-size: 13px; font-weight: 600; }
    .badge { display: inline-flex; align-items: center; gap: 7px; color: var(--green); font-size: 13px; font-weight: 650; }
    .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #22a652; }
    .badge.offline { color: #6b7280; }
    .badge.offline::before { background: #9ca3af; }
    .empty { padding: 34px; text-align: center; color: var(--muted); }
    .footer { margin: 18px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
    @media (max-width: 640px) {
      main { width: min(100% - 28px, 1120px); padding-top: 14px; }
      .topbar { align-items: flex-start; padding-bottom: 26px; }
      .brand-context { display: block; margin: 3px 0 0; }
      .live-meta { padding-top: 7px; }
      .hero { align-items: flex-start; padding: 12px 14px; }
      .hero > div:last-child { display: block; }
      .hero .eyebrow { margin-bottom: 3px; }
      .hero-detail { margin-top: 4px; }
      .section { margin-top: 26px; }
      .service-list { grid-template-columns: 1fr; }
      .service-row { align-items: flex-start; padding: 16px; }
      .service-row { border-right: 0; border-bottom: 1px solid var(--line); }
      .service-row:last-child { border-bottom: 0; }
      .service-state { padding-top: 1px; }
      .node-row { padding: 14px 16px; }
      .node-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .heartbeat-strip { gap: 2px; }
      .node-toolbar { align-items: stretch; flex-wrap: wrap; }
      .filter-search { flex-basis: 100%; }
      .node-toolbar select { flex: 1 1 0; }
      .filter-result { align-self: center; }
    }
    @media (prefers-reduced-motion: reduce) {
      .heartbeat-strip.heartbeat-active::after { animation: none; opacity: 0; }
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
        <span id="dashboard-count" class="count">${onlineCount} 台在线${timedOutCount > 0 ? "，" + timedOutCount + " 台超时" : ""}</span>
      </div>
      <div class="service-list">
        <div class="service-row">
          <div class="service-main"><span id="heartbeat-state" class="service-state ${heartbeatStateClass}">${heartbeatState}</span><span class="service-copy"><span class="service-name">TeamNode 心跳</span><span class="service-description" id="heartbeat-description">${heartbeatDescription}</span></span></div>
        </div>
        <div class="service-row">
          <div class="service-main"><span id="node-state" class="service-state ${nodeStateClass}">${nodeState}</span><span class="service-copy"><span class="service-name">节点连接</span><span class="service-description" id="node-description">${nodeDescription}</span></span></div>
        </div>
        <div class="service-row">
          <div class="service-main"><span class="service-state operational">正常</span><span class="service-copy"><span class="service-name">监控面板</span><span class="service-description">Worker API 和节点列表可用</span></span></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <div><p class="eyebrow">Online nodes</p><h2>在线机器</h2></div>
        <span id="node-count" class="count">${visibleCount} 台</span>
      </div>
      <div class="node-toolbar" role="search" aria-label="筛选在线机器">
        <label class="filter-search">
          <span aria-hidden="true">⌕</span>
          <input id="node-filter-search" type="search" placeholder="搜索名称、IP、域名、系统或架构" autocomplete="off">
        </label>
        <select id="node-filter-status" aria-label="状态筛选">
          <option value="all">全部状态</option>
          <option value="online">在线</option>
          <option value="timedOut">超时</option>
        </select>
        <button id="node-filter-clear" class="filter-clear" type="button" hidden>清除</button>
        <span id="node-filter-result" class="filter-result"></span>
      </div>
      <div class="node-card">
        <div id="node-rows" class="node-list">${rows}</div>
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
      const filterSearchElement = document.getElementById("node-filter-search");
      const filterStatusElement = document.getElementById("node-filter-status");
      const filterClearElement = document.getElementById("node-filter-clear");
      const filterResultElement = document.getElementById("node-filter-result");
      const heartbeatDescriptionElement = document.getElementById("heartbeat-description");
      const heartbeatStateElement = document.getElementById("heartbeat-state");
      const nodeDescriptionElement = document.getElementById("node-description");
      const nodeStateElement = document.getElementById("node-state");
      const lastUpdatedElement = document.getElementById("last-updated");
      const statusElement = document.getElementById("dashboard-status");
      let refreshing = false;
      let currentNodes = [];

      function escapeHtml(value) {
        const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
        return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
      }

      function formatTime(value) {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
        return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
      }

      function renderHeartbeatSegments(node) {
        const history = (Array.isArray(node?.heartbeatHistory) ? node.heartbeatHistory : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .slice(-72);
        const pulseClass = node?.timedOut ? "pulse-timeout" : "pulse-ok";
        return Array.from({ length: 72 }, (_, index) => {
          const timestamp = history[index];
          if (!timestamp) return '<span class="pulse pulse-empty" aria-hidden="true"></span>';
          const formatted = escapeHtml(formatTime(timestamp));
          return '<span class="pulse ' + pulseClass + '" title="心跳 ' + formatted + '" aria-label="心跳 ' + formatted + '"></span>';
        }).join("");
      }

      function runtimeSummary(node) {
        const info = node?.runtimeInfo || {};
        const system = [info.osType || info.platform, info.osRelease].filter(Boolean).join(" ") || "-";
        const resources = [
          Number.isFinite(Number(info.cpuCores)) ? info.cpuCores + " 核" : "",
          Number.isFinite(Number(info.memoryMb)) ? info.memoryMb + " MB" : ""
        ].filter(Boolean).join(" / ") || "-";
        return { system, arch: info.arch || "-", resources };
      }

      function nodeSearchText(node) {
        const info = node?.runtimeInfo || {};
        return [
          node?.label,
          node?.sourceIp,
          node?.argoDomain,
          node?.country,
          node?.countryName,
          node?.provider,
          info.platform,
          info.arch,
          info.osType,
          info.osRelease
        ].filter(Boolean).join(" ").toLowerCase();
      }

      function filteredNodes() {
        const query = filterSearchElement.value.trim().toLowerCase();
        const status = filterStatusElement.value;
        return currentNodes.filter((node) => {
          if (status === "online" && !node.online) return false;
          if (status === "timedOut" && !node.timedOut) return false;
          return !query || nodeSearchText(node).includes(query);
        });
      }

      function renderFilteredNodes() {
        const nodes = filteredNodes();
        const hasFilter = Boolean(filterSearchElement.value.trim()) || filterStatusElement.value !== "all";
        rowsElement.innerHTML = renderRows(nodes);
        filterClearElement.hidden = !hasFilter;
        filterResultElement.textContent = hasFilter
          ? "显示 " + nodes.length + " / " + currentNodes.length + " 台"
          : currentNodes.length + " 台";
      }

      function renderRows(nodes) {
        if (!nodes.length) {
          return '<div class="empty">暂无在线机器</div>';
        }

        return nodes.map((node) => {
          const status = node.online ? "在线" : (node.status === "offline" ? "已下线" : "超时");
          const statusClass = node.online ? "online" : "offline";
          const heartbeatTime = escapeHtml(formatTime(node.lastSeen || node.lastEventAt));
          const runtime = runtimeSummary(node);
          return "<article class=\"node-row\">"
            + "<div class=\"node-row-header\"><div class=\"node-identity\">"
            + "<span class=\"badge " + statusClass + "\">" + status + "</span>"
            + "<div class=\"node-title\"><strong>" + escapeHtml(node.label || "未命名节点") + "</strong><span>" + escapeHtml(node.argoDomain || "-") + "</span></div>"
            + "</div><div class=\"node-last-seen\">最后心跳<br><strong>" + heartbeatTime + "</strong></div></div>"
            + "<div class=\"heartbeat-strip" + (node.online ? " heartbeat-active" : "") + "\" aria-label=\"最近心跳记录\">" + renderHeartbeatSegments(node) + "</div>"
            + "<div class=\"heartbeat-scale\"><span>现在</span><span>" + Math.max(1, Math.round(Number(window.__onlineTtlMs || 600000) / 60000)) + " 分钟前</span></div>"
            + "<div class=\"node-fields\">"
            + "<div><span>来源 IP</span><strong>" + escapeHtml(node.sourceIp || "-") + "</strong></div>"
            + "<div><span>地区</span><strong>" + escapeHtml(node.country || node.countryName || "-") + "</strong></div>"
            + "<div><span>Provider</span><strong>" + escapeHtml(node.provider || "-") + "</strong></div>"
            + "<div><span>操作系统</span><strong>" + escapeHtml(runtime.system) + "</strong></div>"
            + "<div><span>系统架构</span><strong>" + escapeHtml(runtime.arch) + "</strong></div>"
            + "<div><span>CPU / 内存</span><strong>" + escapeHtml(runtime.resources) + "</strong></div>"
            + "</div></article>";
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

          const visibleNodes = data.nodes.filter((node) => node && (node.online || node.timedOut));
          const onlineNodes = visibleNodes.filter((node) => node.online);
          const timedOutNodes = visibleNodes.filter((node) => node.timedOut);
          const ttlMinutes = Math.max(1, Math.round(Number(data.onlineTtlMs || 600000) / 60000));
          const operational = onlineNodes.length > 0 && timedOutNodes.length === 0;
          window.__onlineTtlMs = data.onlineTtlMs || 600000;
          currentNodes = visibleNodes;
          renderFilteredNodes();
          overviewIconElement.className = "hero-icon " + (operational ? "operational" : "attention");
          overviewIconElement.textContent = operational ? "✓" : "!";
          overviewLabelElement.textContent = timedOutNodes.length > 0
            ? "部分节点心跳超时"
            : operational ? "全部系统运行正常" : "暂无在线机器";
          overviewDetailElement.textContent = timedOutNodes.length > 0
            ? timedOutNodes.length + " 台机器已超时并标记为灰色；超过 " + ttlMinutes + " 分钟未收到心跳后自动移除。"
            : operational
              ? onlineNodes.length + " 台机器正在发送心跳，最近 " + ttlMinutes + " 分钟内保持在线。"
              : "等待机器发送心跳；超过 " + ttlMinutes + " 分钟未收到心跳的机器会自动移出列表。";
          dashboardCountElement.textContent = onlineNodes.length + " 台在线" + (timedOutNodes.length > 0 ? "，" + timedOutNodes.length + " 台超时" : "");
          nodeCountElement.textContent = visibleNodes.length + " 台";
          heartbeatDescriptionElement.textContent = timedOutNodes.length > 0
            ? timedOutNodes.length + " 台机器心跳超时，恢复后会自动变绿"
            : onlineNodes.length > 0 ? onlineNodes.length + " 台机器正在上报状态" : "当前没有收到在线机器的心跳";
          heartbeatStateElement.textContent = timedOutNodes.length > 0 ? "有超时" : onlineNodes.length > 0 ? "正常" : "等待中";
          heartbeatStateElement.className = "service-state " + (timedOutNodes.length > 0 ? "attention" : onlineNodes.length > 0 ? "operational" : "waiting");
          nodeDescriptionElement.textContent = timedOutNodes.length > 0
            ? timedOutNodes.length + " 台节点暂时不可用，仍保留 5 分钟"
            : onlineNodes.length > 0 ? "在线节点可继续提供订阅和连接" : "在线节点恢复后会显示在下方";
          nodeStateElement.textContent = timedOutNodes.length > 0 ? "部分异常" : onlineNodes.length > 0 ? "正常" : "等待中";
          nodeStateElement.className = "service-state " + (timedOutNodes.length > 0 ? "attention" : onlineNodes.length > 0 ? "operational" : "waiting");
          lastUpdatedElement.textContent = "刚刚更新";
          statusElement.textContent = "最后更新：" + new Date().toLocaleString() + "；每 30 秒自动更新节点内容，不会刷新整个页面。来源 IP 为 Cloudflare 看到的设备出口 IP，如果设备经过 NAT 或代理，这可能是 NAT/代理出口地址。";
        } catch (error) {
          statusElement.textContent = "内容刷新失败（" + String(error?.message || error) + "），保留上次数据显示。";
        } finally {
          refreshing = false;
        }
      }

      filterSearchElement.addEventListener("input", renderFilteredNodes);
      filterStatusElement.addEventListener("change", renderFilteredNodes);
      filterClearElement.addEventListener("click", () => {
        filterSearchElement.value = "";
        filterStatusElement.value = "all";
        renderFilteredNodes();
        filterSearchElement.focus();
      });

      refreshNodes();
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
      const lastSeen = Number(event.lastSeen || Date.now());
      const previousHistory = Array.isArray(previous.heartbeatHistory)
        ? previous.heartbeatHistory.filter((value) => Number.isFinite(Number(value)))
        : [];
      const lastHistoryValue = previousHistory[previousHistory.length - 1];
      const heartbeatHistory = lastHistoryValue === lastSeen
        ? previousHistory
        : [...previousHistory, lastSeen].slice(-HEARTBEAT_HISTORY_LIMIT);
      const record = {
        ...previous,
        ...event,
        uuid,
        status: "online",
        lastSeen,
        lastEventAt: Number(event.lastEventAt || Date.now()),
        updatedAt: Number(event.updatedAt || Date.now()),
        heartbeatHistory
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
