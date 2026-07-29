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
const TIMEZONE_COLLAPSE_THRESHOLD_MINUTES = 15;
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
    timezone: String(payload?.timezone || "").slice(0, 64),
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

function validTimeZone(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return null;
  }
}

function timeParts(value, timeZone) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    clock: `${values.hour}:${values.minute}:${values.second}`
  };
}

function timeZoneOffsetMinutes(value, timeZone) {
  const parts = timeParts(value, timeZone);
  if (!parts) return null;
  const [hour, minute, second] = parts.clock.split(":").map(Number);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    minute,
    second
  );
  const timestamp = Math.trunc(Number(value) / 1000) * 1000;
  return Number.isFinite(localAsUtc) && Number.isFinite(timestamp)
    ? Math.round((localAsUtc - timestamp) / 60000)
    : null;
}

function heartbeatTimeMarkup(node, value) {
  const china = timeParts(value, "Asia/Shanghai");
  const localZone = validTimeZone(node?.timezone);
  const local = localZone ? timeParts(value, localZone) : null;
  if (!china) {
    return `<span>最后心跳</span><strong>${htmlEscape(dashboardTime(value))}</strong>`;
  }

  if (!localZone || !local) {
    const sharedPrefix = `${china.year}-${china.month}`;
    const chinaText = `${china.day} ${china.clock}`;
    return `<div class="node-time-heading"><span>最后心跳</span><span class="node-time-shared">${htmlEscape(sharedPrefix)}</span></div><div class="node-time-pair" title="节点未上报时区，无法计算节点时间"><span><b>中国</b><strong>${htmlEscape(chinaText)}</strong><small>Asia/Shanghai</small></span><span><b>节点</b><strong>-</strong><small>未上报时区</small></span></div>`;
  }

  const sameYear = china.year === local.year;
  const sameYearMonth = sameYear && china.month === local.month;
  const sharedPrefix = sameYearMonth ? `${china.year}-${china.month}` : sameYear ? china.year : "";
  const chinaText = sameYearMonth
    ? `${china.day} ${china.clock}`
    : sameYear ? `${china.month}-${china.day} ${china.clock}` : `${china.year}-${china.month}-${china.day} ${china.clock}`;
  const localText = sameYearMonth
    ? `${local.day} ${local.clock}`
    : sameYear ? `${local.month}-${local.day} ${local.clock}` : `${local.year}-${local.month}-${local.day} ${local.clock}`;
  const sharedMarkup = sharedPrefix ? `<span class="node-time-shared">${htmlEscape(sharedPrefix)}</span>` : "";
  const chinaOffset = timeZoneOffsetMinutes(value, "Asia/Shanghai");
  const localOffset = timeZoneOffsetMinutes(value, localZone);
  const closeToChina = Number.isFinite(chinaOffset) && Number.isFinite(localOffset)
    && Math.abs(chinaOffset - localOffset) <= TIMEZONE_COLLAPSE_THRESHOLD_MINUTES;
  if (closeToChina) {
    return `<div class="node-time-heading"><span>最后心跳</span>${sharedMarkup}</div><div class="node-time-pair node-time-single" title="中国时区：Asia/Shanghai；节点时区：${htmlEscape(localZone)} 与中国时间接近"><span><b>中国</b><strong>${htmlEscape(chinaText)}</strong><small>Asia/Shanghai</small></span></div>`;
  }
  return `<div class="node-time-heading"><span>最后心跳</span>${sharedMarkup}</div><div class="node-time-pair" title="中国时区：Asia/Shanghai；节点时区：${htmlEscape(localZone)}"><span><b>中国</b><strong>${htmlEscape(chinaText)}</strong><small>Asia/Shanghai</small></span><span><b>节点</b><strong>${htmlEscape(localText)}</strong><small>${htmlEscape(localZone)}</small></span></div>`;
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
    const overviewClass = isOperational ? "operational" : timedOutCount > 0 ? "attention" : "waiting";
    const overviewSymbol = isOperational ? "✓" : timedOutCount > 0 ? "!" : "…";
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
        const nodeStatusClass = node.online ? "online" : node.timedOut ? "timed-out" : "offline";
        return `
        <article class="node-row node-row-${nodeStatusClass}">
          <div class="node-row-header">
            <div class="node-identity">
              <span class="badge ${node.online ? "online" : "offline"}">${node.online ? "在线" : node.status === "offline" ? "已下线" : "超时"}</span>
              <div class="node-title"><strong>${htmlEscape(node.label || "未命名节点")}</strong><span>${htmlEscape(node.argoDomain || "-")}</span></div>
            </div>
            <div class="node-last-seen">${heartbeatTimeMarkup(node, node.lastSeen || node.lastEventAt)}</div>
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
      --accent: #1478c8;
      --accent-soft: #eaf4ff;
      --soft-surface: #f3f6f8;
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
    .system-status-overview { display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: center; justify-content: center; gap: 10px; min-width: 0; padding: 0; }
    .system-status-overview-copy { display: grid; min-width: 0; gap: 2px; align-content: center; text-align: center; }
    .system-status-summary { display: grid; justify-items: center; gap: 2px; min-width: 0; text-align: center; }
    .hero-icon { display: grid; flex: 0 0 32px; place-items: center; width: 32px; height: 32px; border-radius: 50%; color: var(--green); background: var(--green-soft); font-size: 18px; font-weight: 800; }
    .hero-icon.attention { color: var(--amber); background: var(--amber-soft); }
    .hero-icon.waiting { color: var(--muted); background: #f0f2f4; }
    .eyebrow { margin: 0 0 2px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(16px, 2vw, 20px); letter-spacing: -.025em; line-height: 1.25; }
    .system-status-summary h1 { font-size: 13px; font-weight: 650; letter-spacing: 0; line-height: 1.35; }
    .hero-detail { max-width: 220px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
    .section { margin-top: 30px; }
    .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
    .system-status-layout { display: grid; grid-template-columns: minmax(320px, .95fr) minmax(0, 2.05fr); align-items: stretch; gap: 18px; padding: 14px; background: var(--soft-surface); border: 1px solid var(--line); border-radius: 12px; }
    .system-status-heading { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 14px; min-width: 0; padding: 0 2px; }
    .system-status-heading > div:first-child { min-width: 0; }
    .section-title { display: flex; align-items: baseline; gap: 10px; }
    h2 { margin: 0; font-size: 21px; letter-spacing: -.02em; }
    .count { color: var(--muted); font-size: 13px; }
    .node-section-head { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: end; gap: 16px; margin-bottom: 12px; padding: 10px 12px; background: var(--soft-surface); border: 1px solid var(--line); border-radius: 12px; }
    .node-section-title { min-width: 0; }
    .node-section-title .eyebrow { margin-bottom: 3px; }
    .node-toolbar { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .filter-search { display: flex; align-items: center; flex: 0 1 620px; width: min(100%, 620px); gap: 8px; min-width: 0; margin-right: auto; padding: 9px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--muted); }
    .filter-search span { font-size: 16px; line-height: 1; }
    .filter-search input { min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: inherit; font-size: 13px; }
    .filter-search input { width: 100%; }
    .filter-status { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 2px; padding: 3px; background: #f5f6f7; border: 1px solid var(--line); border-radius: 9px; }
    .filter-status-option { height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; white-space: nowrap; }
    .filter-status-option:hover { color: var(--ink); }
    .filter-status-option[aria-pressed="true"], .node-view-option[aria-pressed="true"] { background: var(--accent); box-shadow: 0 2px 7px rgba(20, 120, 200, .25); color: #fff; }
    .filter-status-option[data-status="online"][aria-pressed="true"], .filter-status-option[data-status="timedOut"][aria-pressed="true"] { color: #fff; }
    .node-view-toggle { padding: 3px; }
    .node-view-option { display: grid; place-items: center; width: 34px; height: 30px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
    .node-view-option:hover { color: var(--ink); }
    .node-view-option svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
    .filter-status-option:focus-visible, .node-view-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .filter-result { flex: 0 0 72px; min-width: 72px; color: var(--muted); font-size: 12px; text-align: right; white-space: nowrap; }
    .service-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
    .service-row { display: flex; align-items: center; justify-content: center; gap: 14px; min-width: 0; padding: 16px; border-right: 1px solid var(--line); }
    .service-row:last-child { border-right: 0; }
    .service-main { display: flex; flex: 1; align-items: center; justify-content: center; gap: 10px; min-width: 0; text-align: center; }
    .service-copy { flex: 0 1 210px; min-width: 0; text-align: center; }
    .service-name { display: block; font-size: 13px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
    .service-description { display: block; margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; white-space: normal; }
    .service-state { flex: 0 0 auto; min-width: 0; color: var(--muted); font-size: 12px; font-weight: 700; line-height: 1.3; white-space: nowrap; }
    .service-state.operational { color: var(--green); }
    .service-state.attention { color: var(--amber); }
    .service-state.waiting { color: var(--muted); }
    .node-card { overflow: visible; background: transparent; border: 0; border-radius: 0; }
    .node-list { display: grid; gap: 8px; padding: 0; background: transparent; }
    .node-list.node-cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; padding: 0; background: transparent; }
    .node-row { position: relative; isolation: isolate; min-width: 0; padding: 14px 18px; border: 1px solid var(--line); border-left: 3px solid var(--line); border-radius: 10px; background: var(--surface); }
    .node-row > * { position: relative; z-index: 1; }
    .node-row::after { position: absolute; z-index: 0; inset: -1px; padding: 2px; border-radius: inherit; content: ""; pointer-events: none; background: conic-gradient(from 0deg, transparent 0deg 300deg, var(--node-border-runner) 320deg 350deg, transparent 360deg); mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude; -webkit-mask-composite: xor; opacity: .78; animation: node-border-run 4.5s linear infinite; }
    .node-row-online { --node-border-runner: #22a652; border-color: #bfe8ce; border-left-color: #22a652; }
    .node-row-timed-out { --node-border-runner: #e05252; border-color: #f0caca; border-left-color: #e05252; }
    .node-row-offline { --node-border-runner: #9ca3af; border-color: #d9dde2; border-left-color: #9ca3af; }
    .node-cards .node-row { padding: 15px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
    .node-cards .node-row.node-row-online { border-color: #bfe8ce; border-left-color: #22a652; }
    .node-cards .node-row.node-row-timed-out { border-color: #f0caca; border-left-color: #e05252; }
    .node-cards .node-row.node-row-offline { border-color: #d9dde2; border-left-color: #9ca3af; }
    .node-cards .node-row-header { display: grid; gap: 12px; }
    .node-cards .node-last-seen { text-align: left; }
    .node-cards .node-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .node-row-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
    .node-identity { display: flex; align-items: flex-start; gap: 14px; min-width: 0; }
    .node-title { display: grid; min-width: 0; gap: 4px; }
    .node-title strong { overflow-wrap: anywhere; font-size: 15px; line-height: 1.35; }
    .node-title span { overflow-wrap: anywhere; color: var(--muted); font-size: 13px; }
    .node-last-seen { flex: 0 0 auto; color: var(--muted); font-size: 11px; line-height: 1.45; text-align: right; }
    .node-time-heading { display: grid; grid-template-columns: max-content 1fr; align-items: baseline; column-gap: 6px; width: 100%; text-align: left; }
    .node-time-pair { display: grid; width: max-content; gap: 1px; margin: 2px 0 0 auto; color: var(--ink); font-size: 11px; font-weight: 600; text-align: left; }
    .node-time-pair > span { display: grid; grid-template-columns: 52px auto 1fr; align-items: baseline; column-gap: 5px; }
    .node-time-pair b { color: var(--muted); font-size: 10px; font-weight: 700; }
    .node-time-pair strong { color: var(--ink); font-size: 11px; font-weight: 600; white-space: nowrap; }
    .node-time-pair small { color: var(--muted); font-size: 9px; font-weight: 500; white-space: nowrap; }
    .node-time-shared { color: var(--muted); font-size: 10px; font-weight: 600; }
    .node-last-seen strong { color: var(--ink); font-size: 13px; font-weight: 600; }
    .heartbeat-strip { position: relative; display: grid; grid-template-columns: repeat(72, minmax(2px, 1fr)); align-items: end; gap: 3px; height: 24px; margin-top: 11px; overflow: hidden; isolation: isolate; }
    .heartbeat-strip.heartbeat-short { grid-template-columns: repeat(24, minmax(2px, 1fr)); }
    .heartbeat-strip.heartbeat-active::after { position: absolute; z-index: 2; top: -5px; bottom: -5px; left: -24%; width: 22%; content: ""; pointer-events: none; background: linear-gradient(90deg, transparent, rgba(239, 255, 246, .14) 28%, rgba(255, 255, 255, .78) 50%, rgba(239, 255, 246, .14) 72%, transparent); filter: blur(2px); animation: heartbeat-charge 3.8s linear infinite; }
    .pulse { position: relative; z-index: 1; display: block; min-width: 0; height: 18px; border-radius: 3px; background: #dff4e6; }
    .pulse-ok { height: 24px; background: #44d483; }
    .pulse-timeout { height: 24px; background: #e05252; }
    .pulse-empty { background: #eef0f2; }
    @keyframes node-border-run { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
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
      .system-status-layout { padding: 14px; }
      .system-status-overview { padding: 0; }
      .system-status-heading { grid-template-columns: 1fr; gap: 10px; }
      .system-status-overview-copy { gap: 3px; }
      .system-status-summary { display: grid; text-align: center; }
      .hero-detail { margin-top: 4px; }
      .section { margin-top: 26px; }
      .system-status-layout { grid-template-columns: 1fr; gap: 14px; }
      .service-list { grid-template-columns: 1fr; }
      .service-row { align-items: flex-start; padding: 16px; }
      .service-row { border-right: 0; border-bottom: 1px solid var(--line); }
      .service-row:last-child { border-bottom: 0; }
      .node-row { padding: 14px 16px; }
      .node-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .heartbeat-strip { gap: 2px; }
      .node-list.node-cards { grid-template-columns: 1fr; padding: 0; }
      .node-section-head { grid-template-columns: 1fr; align-items: stretch; gap: 10px; padding: 12px 10px; }
      .node-toolbar { align-items: stretch; flex-wrap: wrap; }
      .filter-search { flex-basis: 100%; width: 100%; max-width: none; margin-right: 0; }
      .filter-status { flex: 1 1 auto; }
      .node-view-toggle { flex: 0 0 auto; }
      .filter-status-option { flex: 1 1 0; }
      .filter-result { align-self: center; }
    }
    @media (prefers-reduced-motion: reduce) {
      .node-row::after { animation: none; opacity: .35; }
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

    <section class="section">
      <div class="system-status-layout">
        <div class="system-status-heading">
          <div><p class="eyebrow">System status</p><h2>系统状态</h2></div>
          <div class="system-status-overview" aria-live="polite">
            <div id="overview-icon" class="hero-icon ${overviewClass}" aria-label="${overviewLabel}">${overviewSymbol}</div>
            <div class="system-status-overview-copy">
              <div class="system-status-summary">
                <h1 id="overview-label">${overviewLabel}</h1>
                <p id="overview-detail" class="hero-detail">${overviewDetail}</p>
              </div>
            </div>
          </div>
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
      </div>
    </section>

    <section class="section">
      <div class="node-section-head">
        <div class="node-section-title">
          <p class="eyebrow">Online nodes</p>
          <div class="section-title"><h2>在线机器</h2><span id="node-count" class="count">${visibleCount} 台</span></div>
        </div>
        <div class="node-toolbar" role="search" aria-label="筛选在线机器">
          <label class="filter-search">
            <span aria-hidden="true">⌕</span>
            <input id="node-filter-search" type="search" placeholder="搜索名称、IP、域名、系统或架构" autocomplete="off">
          </label>
          <span id="node-filter-result" class="filter-result"></span>
          <div id="node-filter-status" class="filter-status" role="group" aria-label="状态筛选">
            <button class="filter-status-option" type="button" data-status="all" aria-pressed="true">全部</button>
            <button class="filter-status-option" type="button" data-status="online" aria-pressed="false">在线</button>
            <button class="filter-status-option" type="button" data-status="timedOut" aria-pressed="false">超时</button>
          </div>
          <div id="node-filter-view" class="filter-status node-view-toggle" role="group" aria-label="节点视图">
            <button class="node-view-option" type="button" data-view="list" aria-pressed="true" aria-label="列表视图" title="列表视图">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"></path><path d="M4 6h.01M4 12h.01M4 18h.01"></path></svg>
            </button>
            <button class="node-view-option" type="button" data-view="cards" aria-pressed="false" aria-label="卡片视图" title="卡片视图">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"></rect><rect x="14" y="4" width="6" height="6" rx="1"></rect><rect x="4" y="14" width="6" height="6" rx="1"></rect><rect x="14" y="14" width="6" height="6" rx="1"></rect></svg>
            </button>
          </div>
        </div>
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
      const nodeCountElement = document.getElementById("node-count");
      const filterSearchElement = document.getElementById("node-filter-search");
      const filterStatusElement = document.getElementById("node-filter-status");
      const filterViewElement = document.getElementById("node-filter-view");
      const filterResultElement = document.getElementById("node-filter-result");
      const heartbeatDescriptionElement = document.getElementById("heartbeat-description");
      const heartbeatStateElement = document.getElementById("heartbeat-state");
      const nodeDescriptionElement = document.getElementById("node-description");
      const nodeStateElement = document.getElementById("node-state");
      const lastUpdatedElement = document.getElementById("last-updated");
      const statusElement = document.getElementById("dashboard-status");
      let refreshing = false;
      let currentNodes = [];
      let selectedStatus = "all";
      let selectedView = "list";
      let searchTimer = null;
      const timezoneCollapseThresholdMinutes = 15;

      function escapeHtml(value) {
        const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
        return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
      }

      function formatTime(value) {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
        return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
      }

      function formatTimeParts(value, timeZone) {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
        try {
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
            hourCycle: "h23"
          }).formatToParts(new Date(timestamp));
          const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
          return {
            year: values.year,
            month: values.month,
            day: values.day,
            clock: values.hour + ":" + values.minute + ":" + values.second
          };
        } catch {
          return null;
        }
      }

      function timeZoneOffsetMinutes(value, timeZone) {
        const parts = formatTimeParts(value, timeZone);
        if (!parts) return null;
        const clockParts = parts.clock.split(":").map(Number);
        const localAsUtc = Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1,
          Number(parts.day),
          clockParts[0],
          clockParts[1],
          clockParts[2]
        );
        const timestamp = Math.trunc(Number(value) / 1000) * 1000;
        return Number.isFinite(localAsUtc) && Number.isFinite(timestamp)
          ? Math.round((localAsUtc - timestamp) / 60000)
          : null;
      }

      function renderNodeTimePair(node, value) {
        const china = formatTimeParts(value, "Asia/Shanghai");
        const requestedZone = String(node?.timezone || "").trim();
        const localZone = requestedZone && formatTimeParts(value, requestedZone) ? requestedZone : "";
        const local = localZone ? formatTimeParts(value, localZone) : null;
        if (!china) {
          return "<span>最后心跳</span><strong>" + escapeHtml(formatTime(value)) + "</strong>";
        }

        if (!localZone || !local) {
          const sharedPrefix = china.year + "-" + china.month;
          const chinaText = china.day + " " + china.clock;
          return '<div class="node-time-heading"><span>最后心跳</span><span class="node-time-shared">' + escapeHtml(sharedPrefix) + '</span></div><div class="node-time-pair" title="节点未上报时区，无法计算节点时间">'
            + '<span><b>中国</b><strong>' + escapeHtml(chinaText) + '</strong><small>Asia/Shanghai</small></span>'
            + '<span><b>节点</b><strong>-</strong><small>未上报时区</small></span>'
            + '</div>';
        }

        const sameYear = china.year === local.year;
        const sameYearMonth = sameYear && china.month === local.month;
        const sharedPrefix = sameYearMonth ? china.year + "-" + china.month : sameYear ? china.year : "";
        const chinaText = sameYearMonth
          ? china.day + " " + china.clock
          : sameYear ? china.month + "-" + china.day + " " + china.clock : china.year + "-" + china.month + "-" + china.day + " " + china.clock;
        const localText = sameYearMonth
          ? local.day + " " + local.clock
          : sameYear ? local.month + "-" + local.day + " " + local.clock : local.year + "-" + local.month + "-" + local.day + " " + local.clock;
        const sharedMarkup = sharedPrefix ? '<span class="node-time-shared">' + escapeHtml(sharedPrefix) + "</span>" : "";
        const chinaOffset = timeZoneOffsetMinutes(value, "Asia/Shanghai");
        const localOffset = timeZoneOffsetMinutes(value, localZone);
        const closeToChina = Number.isFinite(chinaOffset) && Number.isFinite(localOffset)
          && Math.abs(chinaOffset - localOffset) <= timezoneCollapseThresholdMinutes;
        if (closeToChina) {
          return '<div class="node-time-heading"><span>最后心跳</span>' + sharedMarkup + '</div><div class="node-time-pair node-time-single" title="中国时区：Asia/Shanghai；节点时区：' + escapeHtml(localZone) + ' 与中国时间接近"><span><b>中国</b><strong>' + escapeHtml(chinaText) + '</strong><small>Asia/Shanghai</small></span></div>';
        }
        return '<div class="node-time-heading"><span>最后心跳</span>' + sharedMarkup + '</div><div class="node-time-pair" title="中国时区：Asia/Shanghai；节点时区：' + escapeHtml(localZone) + '">'
          + '<span><b>中国</b><strong>' + escapeHtml(chinaText) + '</strong><small>Asia/Shanghai</small></span>'
          + '<span><b>节点</b><strong>' + escapeHtml(localText) + '</strong><small>' + escapeHtml(localZone) + '</small></span>'
          + '</div>';
      }

      function renderHeartbeatSegments(node, limit = 72) {
        const segmentLimit = Math.max(1, Math.min(72, Math.round(Number(limit) || 72)));
        const history = (Array.isArray(node?.heartbeatHistory) ? node.heartbeatHistory : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .slice(-segmentLimit);
        const pulseClass = node?.timedOut ? "pulse-timeout" : "pulse-ok";
        return Array.from({ length: segmentLimit }, (_, index) => {
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
          info.osRelease,
          node?.timezone
        ].filter(Boolean).join(" ").toLowerCase();
      }

      function normalizeSearchValue(value) {
        return String(value || "")
          .toLocaleLowerCase("zh-CN")
          .replace(/[\s_./:-]+/g, "");
      }

      function fuzzySearchMatch(text, query) {
        const normalizedText = normalizeSearchValue(text);
        const normalizedQuery = normalizeSearchValue(query);
        if (!normalizedQuery) return true;
        if (normalizedText.includes(normalizedQuery)) return true;

        let queryIndex = 0;
        for (const character of normalizedText) {
          if (character === normalizedQuery[queryIndex]) {
            queryIndex += 1;
            if (queryIndex === normalizedQuery.length) return true;
          }
        }
        return false;
      }

      function setStatusFilter(status) {
        selectedStatus = ["all", "online", "timedOut"].includes(status) ? status : "all";
        filterStatusElement.querySelectorAll("[data-status]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.status === selectedStatus));
        });
      }

      function setNodeView(view) {
        selectedView = ["list", "cards"].includes(view) ? view : "list";
        filterViewElement.querySelectorAll("[data-view]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.view === selectedView));
        });
      }

      function filteredNodes() {
        const query = filterSearchElement.value.trim().toLowerCase();
        return currentNodes.filter((node) => {
          if (selectedStatus === "online" && !node.online) return false;
          if (selectedStatus === "timedOut" && !node.timedOut) return false;
          return fuzzySearchMatch(nodeSearchText(node), query);
        });
      }

      function renderFilteredNodes() {
        const nodes = filteredNodes();
        rowsElement.className = selectedView === "cards" ? "node-list node-cards" : "node-list";
        rowsElement.innerHTML = renderRows(nodes);
        const hasFilter = Boolean(filterSearchElement.value.trim()) || selectedStatus !== "all";
        filterResultElement.textContent = hasFilter
          ? "显示 " + nodes.length + " / " + currentNodes.length + " 台"
          : currentNodes.length + " 台";
      }

      function scheduleFilteredNodes() {
        if (searchTimer !== null) window.clearTimeout(searchTimer);
        if (!filterSearchElement.value.trim()) {
          renderFilteredNodes();
          return;
        }
        searchTimer = window.setTimeout(() => {
          searchTimer = null;
          renderFilteredNodes();
        }, 250);
      }

      function renderRows(nodes) {
        if (!nodes.length) {
          return '<div class="empty">暂无在线机器</div>';
        }

        return nodes.map((node) => {
          const status = node.online ? "在线" : (node.status === "offline" ? "已下线" : "超时");
          const statusClass = node.online ? "online" : "offline";
          const nodeStatusClass = node.online ? "online" : node.timedOut ? "timed-out" : "offline";
          const runtime = runtimeSummary(node);
          const heartbeatLimit = selectedView === "cards" ? 24 : 72;
          const heartbeatWindowMinutes = Math.max(1, Math.round((Number(window.__onlineTtlMs || 600000) / 60000) * heartbeatLimit / 72));
          return '<article class="node-row node-row-' + nodeStatusClass + '">'
            + '<div class="node-row-header"><div class="node-identity">'
            + '<span class="badge ' + statusClass + '">' + status + '</span>'
            + '<div class="node-title"><strong>' + escapeHtml(node.label || "未命名节点") + '</strong><span>' + escapeHtml(node.argoDomain || "-") + '</span></div>'
            + '</div><div class="node-last-seen">' + renderNodeTimePair(node, node.lastSeen || node.lastEventAt) + '</div></div>'
            + '<div class="heartbeat-strip' + (node.online ? " heartbeat-active" : "") + (heartbeatLimit < 72 ? " heartbeat-short" : "") + '" aria-label="最近心跳记录">' + renderHeartbeatSegments(node, heartbeatLimit) + '</div>'
            + '<div class="heartbeat-scale"><span>现在</span><span>' + heartbeatWindowMinutes + ' 分钟前</span></div>'
            + '<div class="node-fields">'
            + '<div><span>来源 IP</span><strong>' + escapeHtml(node.sourceIp || "-") + '</strong></div>'
            + '<div><span>地区</span><strong>' + escapeHtml(node.country || node.countryName || "-") + '</strong></div>'
            + '<div><span>Provider</span><strong>' + escapeHtml(node.provider || "-") + '</strong></div>'
            + '<div><span>操作系统</span><strong>' + escapeHtml(runtime.system) + '</strong></div>'
            + '<div><span>系统架构</span><strong>' + escapeHtml(runtime.arch) + '</strong></div>'
            + '<div><span>CPU / 内存</span><strong>' + escapeHtml(runtime.resources) + '</strong></div>'
            + '</div></article>';
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
          const overviewStatus = operational ? "operational" : timedOutNodes.length > 0 ? "attention" : "waiting";
          overviewIconElement.className = "hero-icon " + overviewStatus;
          overviewIconElement.textContent = operational ? "✓" : timedOutNodes.length > 0 ? "!" : "…";
          overviewIconElement.setAttribute("aria-label", timedOutNodes.length > 0 ? "部分节点心跳超时" : operational ? "全部系统运行正常" : "等待机器心跳");
          overviewLabelElement.textContent = timedOutNodes.length > 0
            ? "部分节点心跳超时"
            : operational ? "全部系统运行正常" : "暂无在线机器";
          overviewDetailElement.textContent = timedOutNodes.length > 0
            ? timedOutNodes.length + " 台机器已超时并标记为灰色；超过 " + ttlMinutes + " 分钟未收到心跳后自动移除。"
            : operational
              ? onlineNodes.length + " 台机器正在发送心跳，最近 " + ttlMinutes + " 分钟内保持在线。"
              : "等待机器发送心跳；超过 " + ttlMinutes + " 分钟未收到心跳的机器会自动移出列表。";
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

      filterSearchElement.addEventListener("input", scheduleFilteredNodes);
      filterSearchElement.addEventListener("search", renderFilteredNodes);
      filterStatusElement.querySelectorAll("[data-status]").forEach((button) => {
        button.addEventListener("click", () => {
          setStatusFilter(button.getAttribute("data-status"));
          renderFilteredNodes();
        });
      });
      filterViewElement.querySelectorAll("[data-view]").forEach((button) => {
        button.addEventListener("click", () => {
          setNodeView(button.getAttribute("data-view"));
          renderFilteredNodes();
        });
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
  const derivedRelayToken = await deriveRelayToken(syncSecret, uuid);
  const presentedToken = request.headers.get("x-teamnode-sync-relay-token") || "";
  // 派生令牌是当前默认方案。保留固定令牌仅用于旧版本兼容，不能让旧的
  // TEAMNODE_SYNC_RELAY_TOKEN 配置覆盖或阻断新机器通过兑换密码获得的令牌。
  const relayTokenValid = constantTimeEqual(presentedToken, derivedRelayToken)
    || (configuredRelayToken && constantTimeEqual(presentedToken, configuredRelayToken));
  if (!relayTokenValid) {
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
