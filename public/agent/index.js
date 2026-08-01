const express = require("express");
const app = express();
const http = require("http");
const https = require("https");
const axios = require("axios");
const crypto = require("crypto");
const dns = require("dns");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const UPLOAD_URL = process.env.UPLOAD_URL || ""; // 节点或订阅自动上传地址，例如：https://merge.xxx.com
const PROJECT_URL = process.env.PROJECT_URL || ""; // 项目分配的访问地址，例如：https://google.com
const AUTO_ACCESS = process.env.AUTO_ACCESS || false; // 是否开启自动保活，需要同时配置 PROJECT_URL
const FILE_PATH = process.env.FILE_PATH || ".tmp"; // 运行目录，也是订阅文件保存目录
const SUB_PATH = process.env.SUB_PATH || "sub"; // 订阅路径
// 平台代理模式由 Railway 等平台在边缘终止 TLS，再将普通 HTTP/WebSocket 转发到 ARGO_PORT。
const PLATFORM_PROXY_MODE = parseBoolean(
  process.env.PLATFORM_PROXY_MODE ?? process.env.PLATFORM_MODE,
  false
);
const PLATFORM_PUBLIC_DOMAIN = process.env.PLATFORM_PUBLIC_DOMAIN
  || process.env.RAILWAY_PUBLIC_DOMAIN
  || process.env.BOXD_PUBLIC_DOMAIN
  || process.env.PUBLIC_DOMAIN
  || "";
const PORT = process.env.SERVER_PORT || (PLATFORM_PROXY_MODE ? 3000 : process.env.PORT || 3000); // 容器内部网页端口
const XRAY_LOG_LEVEL = process.env.XRAY_LOG_LEVEL || "warning";
const XRAY_ACCESS_LOG_ENABLED = parseBoolean(process.env.XRAY_ACCESS_LOG_ENABLED, false);
const XRAY_SNIFFING_ENABLED = parseBoolean(process.env.XRAY_SNIFFING_ENABLED, false);
const CLOUDFLARED_LOG_LEVEL = process.env.CLOUDFLARED_LOG_LEVEL || "info";
const CLOUDFLARED_PROTOCOL = process.env.CLOUDFLARED_PROTOCOL || "http2";
const TUNNEL_PREFLIGHT_BLOCKED = parseBoolean(process.env.TUNNEL_PREFLIGHT_BLOCKED, false);
const CLOUDFLARED_CONNECTIVITY_TIMEOUT_MS = Number.parseInt(process.env.CLOUDFLARED_CONNECTIVITY_TIMEOUT_MS || "3000", 10);
const CLOUDFLARED_CONNECTIVITY_CACHE_MS = Number.parseInt(process.env.CLOUDFLARED_CONNECTIVITY_CACHE_MS || "30000", 10);
const CLOUDFLARED_TUNNEL_PORT = 7844;
const CLOUDFLARED_EDGE_HOSTS = [
  "region1.v2.argotunnel.com",
  "region2.v2.argotunnel.com"
];
const NGINX_LOG_LEVEL = process.env.NGINX_LOG_LEVEL || "warn";
const DIRECT_NGINX_ACCESS_LOG_ENABLED = parseBoolean(process.env.DIRECT_NGINX_ACCESS_LOG_ENABLED, false);
const UUID = process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913"; // 用户 UUID
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || (PLATFORM_PROXY_MODE ? PLATFORM_PUBLIC_DOMAIN : ""); // 平台模式可由平台域名环境变量自动提供
const ARGO_AUTH = process.env.ARGO_AUTH || ""; // 固定隧道密钥 JSON 或 token，留空则启用临时隧道
const ARGO_PORT = process.env.ARGO_PORT || 8001; // 固定隧道端口，使用 token 时需和 Cloudflare 后台一致
const ARGO_GATEWAY_HOST = process.env.ARGO_GATEWAY_HOST || "127.0.0.1";
// These listeners are internal application ports. They must never be offered
// to the Worker as direct public-ingress heartbeat candidates.
const LOCAL_SERVICE_PORTS = new Set(
  [PORT, ARGO_PORT]
    .map((value) => Number.parseInt(String(value), 10))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
);
const DIRECT_MODE = parseBoolean(process.env.DIRECT_MODE, false);
const PLATFORM_PUBLIC_PORT = Number.parseInt(process.env.PLATFORM_PUBLIC_PORT || "443", 10);
const DIRECT_PORT = Number.parseInt(process.env.DIRECT_PORT || "443", 10);
const DIRECT_HTTP_PORT = Number.parseInt(process.env.DIRECT_HTTP_PORT || "80", 10);
const DIRECT_TLS_ENABLED = parseBoolean(process.env.DIRECT_TLS_ENABLED, true);
const AUTO_DIRECT_FALLBACK = parseBoolean(process.env.AUTO_DIRECT_FALLBACK, true);
const NODEJS_ARGO_ENV_FILE = process.env.NODEJS_ARGO_ENV_FILE || "";
const DIRECT_PORT_CANDIDATES = [...new Set(
  String(process.env.DIRECT_PORT_CANDIDATES || "80,443,8080,8443,8880,2053,2083,2087,2096")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535 && !LOCAL_SERVICE_PORTS.has(port))
)].slice(0, 12);
const DIRECT_PORT_SCAN_PORTS = String(
  process.env.DIRECT_PORT_SCAN_PORTS || "8000,8008,8081,8088,8090,8181,8444,8888,9000,9443,10000,11550-11570,20000,30000,40000,50000,60000"
);
const DIRECT_PORT_SCAN_RANGE = String(process.env.DIRECT_PORT_SCAN_RANGE || "1024-65535");
const DIRECT_PORT_SCAN_MAX = Number.parseInt(process.env.DIRECT_PORT_SCAN_MAX || "256", 10);
const DIRECT_PORT_PROBE_BATCH_SIZE = 12;
const DIRECT_FALLBACK_FAILURE_THRESHOLD = Number.parseInt(process.env.DIRECT_FALLBACK_FAILURE_THRESHOLD || "2", 10);
const DIRECT_CERT_FILE = process.env.DIRECT_CERT_FILE || "";
const DIRECT_KEY_FILE = process.env.DIRECT_KEY_FILE || "";
const DIRECT_LETSENCRYPT_EMAIL = process.env.DIRECT_LETSENCRYPT_EMAIL || "admin@lemon.vin";
const CF_DNS_ENABLED = parseBoolean(process.env.CF_DNS_ENABLED, false);
const CF_API_TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_KEY || "";
const CF_DNS_ZONE_ID = process.env.CF_DNS_ZONE_ID || "";
const CF_DNS_ZONE_NAME = process.env.CF_DNS_ZONE_NAME || "";
const CF_DNS_RECORD_NAME = process.env.CF_DNS_RECORD_NAME || ARGO_DOMAIN;
const CF_DNS_PUBLIC_IP = process.env.CF_DNS_PUBLIC_IP || "";
const CF_DNS_TTL = Number.parseInt(process.env.CF_DNS_TTL || "120", 10);
const CF_DNS_SYNC_INTERVAL_MS = Number.parseInt(process.env.CF_DNS_SYNC_INTERVAL_MS || "300000", 10);
const CF_DNS_REPLACE_CNAME = parseBoolean(process.env.CF_DNS_REPLACE_CNAME, true);
const CFIP = process.env.CFIP || ((DIRECT_MODE || PLATFORM_PROXY_MODE) ? ARGO_DOMAIN : "www.cloudflare.com"); // 节点优选域名或优选 IP
const CFPORT = process.env.CFPORT || (DIRECT_MODE ? DIRECT_PORT : PLATFORM_PROXY_MODE ? PLATFORM_PUBLIC_PORT : 443); // 节点端口
const NAME = process.env.NAME || ""; // 节点名称前缀
const TEAMNODE_SYNC_BASE_URL = process.env.TEAMNODE_SYNC_BASE_URL || "https://teamnode.lemon.vin";
const TEAMNODE_SYNC_KEY_ID = process.env.TEAMNODE_SYNC_KEY_ID || "nodejs-argo-prod";
const TEAMNODE_SYNC_SECRET = process.env.TEAMNODE_SYNC_SECRET || "";
const TEAMNODE_SYNC_RELAY_TOKEN = process.env.TEAMNODE_SYNC_RELAY_TOKEN || "";
const TEAMNODE_SYNC_GROUP_KEY = process.env.TEAMNODE_SYNC_GROUP_KEY || "basic";
const TEAMNODE_SYNC_PROVIDER = process.env.TEAMNODE_SYNC_PROVIDER || "";
const TEAMNODE_SYNC_LABEL_PREFIX = process.env.TEAMNODE_SYNC_LABEL_PREFIX || "";
const TEAMNODE_SYNC_TIMEOUT_MS = Number.parseInt(process.env.TEAMNODE_SYNC_TIMEOUT_MS || "10000", 10);
const TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS = Number.parseInt(process.env.TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS || "300000", 10);
const TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS = Number.parseInt(process.env.TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS || "15000", 10);
const TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT = parseBoolean(
  process.env.TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT,
  false
);
const TEAMNODE_SYNC_SHUTDOWN_TIMEOUT_MS = 3000;
// 直连入口最终写入 Cloudflare A 记录，并由 Nginx 监听 IPv4。直连探测请求
// 必须从本机 IPv4 出口访问 Worker，确保 CF-Connecting-IP 与实际入口一致。
const TEAMNODE_IPV4_HTTPS_AGENT = new https.Agent({ family: 4, keepAlive: false });
const TUNNEL_TEST_COMMANDS_PATH = "/api/internal/nodejs-argo/tunnel-test-commands";
const TUNNEL_TEST_RESULTS_PATH = "/api/internal/nodejs-argo/tunnel-test-results";
const PUBLIC_ROUTE_PROBE_PATH = "/api/internal/nodejs-argo/public-route-probe";
const PUBLIC_ROUTE_PROBE_ATTEMPTS = 5;
const PUBLIC_ROUTE_PROBE_RETRY_DELAY_MS = 3000;
const STARTUP_TUNNEL_PROBE_ATTEMPTS = Number.parseInt(process.env.STARTUP_TUNNEL_PROBE_ATTEMPTS || "5", 10);
const STARTUP_TUNNEL_PROBE_RETRY_DELAY_MS = Number.parseInt(process.env.STARTUP_TUNNEL_PROBE_RETRY_DELAY_MS || "4000", 10);

// Docker 镜像内置二进制目录
const BIN_PATH = process.env.BIN_PATH || "/usr/local/bin";
const XRAY_BIN = process.env.XRAY_BIN || path.join(BIN_PATH, "xray");
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || path.join(BIN_PATH, "cloudflared");

const ARGO_WS_TARGETS = Object.freeze({
  "/vless-argo": 3002,
  "/vmess-argo": 3003,
  "/trojan-argo": 3004
});
let argoGatewayServer = null;
let appServer = null;

if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH);
  console.log(`${FILE_PATH} 已创建`);
} else {
  console.log(`${FILE_PATH} 已存在`);
}

// 全局路径常量
const webPath = XRAY_BIN;
const botPath = CLOUDFLARED_BIN;
const webName = path.basename(webPath, path.extname(webPath));
const botName = path.basename(botPath, path.extname(botPath));
const subPath = path.join(FILE_PATH, "sub.txt");
const listPath = path.join(FILE_PATH, "list.txt");
const bootLogPath = path.join(FILE_PATH, "boot.log");
const configPath = path.join(FILE_PATH, "config.json");
const nginxBootLogPath = path.join(FILE_PATH, "nginx-boot.log");
const xrayBootLogPath = path.join(FILE_PATH, "xray-boot.log");
const cloudflaredBootLogPath = path.join(FILE_PATH, "cloudflared-boot.log");
const xrayAccessLogPath = path.join(FILE_PATH, "xray-access.log");
const xrayErrorLogPath = path.join(FILE_PATH, "xray-error.log");
const cloudflaredLogPath = path.join(FILE_PATH, "cloudflared.log");
const directNginxConfigPath = path.join(FILE_PATH, "nginx-direct.conf");
const directNginxAccessLogPath = path.join(FILE_PATH, "nginx-access.log");
const directNginxErrorLogPath = path.join(FILE_PATH, "nginx-error.log");
const directNginxPidPath = path.join(FILE_PATH, "nginx.pid");
const directAcmePath = path.join(FILE_PATH, "acme");
const tunnelJsonPath = path.join(FILE_PATH, "tunnel.json");
const tunnelYamlPath = path.join(FILE_PATH, "tunnel.yml");
const noRouteMarkerPath = path.resolve(FILE_PATH, ".no-route");
const routeReadyMarkerPath = path.resolve(FILE_PATH, ".route-ready");
const routeProbeProgressPath = path.resolve(FILE_PATH, ".route-probe-progress");
const NO_ROUTE_EXIT_CODE = 78;
const NGINX_BIN = process.env.NGINX_BIN || "/usr/sbin/nginx";
const CERTBOT_BIN = process.env.CERTBOT_BIN || "/usr/bin/certbot";

try {
  fs.rmSync(routeReadyMarkerPath, { force: true });
  fs.rmSync(routeProbeProgressPath, { force: true });
} catch {
  // 后续公网验证通过后仍会覆盖成功标记。
}

let teamnodeSyncTimer = null;
let tunnelTestCommandPollTimer = null;
let tunnelTestCommandPollPromise = null;
let teamnodeSyncRegistered = false;
let teamnodeSyncContext = null;
let teamnodeShutdownPromise = null;
let directCertificateRenewalTimer = null;
let cloudflareDnsSyncTimer = null;
let processShutdownRequested = false;
let tunnelConnectivityCache = null;
let publicRouteProbeCache = null;
let tunnelFailureStreak = 0;
let directFallbackPromise = null;
let xrayProcessId = null;
let cloudflaredProcessId = null;
let bootInstanceId = createRandomToken();
const PROVIDER_CODE_OVERRIDES = {
  SG: "sin"
};

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const TEAMNODE_SYNC_ENABLED = parseBoolean(
  process.env.TEAMNODE_SYNC_ENABLED,
  Boolean(TEAMNODE_SYNC_SECRET || TEAMNODE_SYNC_RELAY_TOKEN)
);

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeRequestPath(value) {
  const raw = String(value || "/").trim() || "/";
  const withoutQuery = raw.split("?")[0] || "/";
  const collapsed = withoutQuery.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }
  return collapsed || "/";
}

function sha256Hex(value = "") {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function createRandomToken() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function createTeamNodeSyncHeaders({ method = "GET", path: requestPath = "/", rawBody = "", eventPrefix = "nodejs_argo" }) {
  const timestamp = Date.now().toString();
  const nonce = createRandomToken();
  const eventId = `${eventPrefix}_${createRandomToken().replace(/-/g, "")}`;
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  const normalizedPath = normalizeRequestPath(requestPath);
  const signaturePayload = [
    normalizedMethod,
    normalizedPath,
    sha256Hex(rawBody),
    timestamp,
    nonce,
    eventId
  ].join("\n");
  const signature = TEAMNODE_SYNC_SECRET
    ? crypto
      .createHmac("sha256", String(TEAMNODE_SYNC_SECRET))
      .update(signaturePayload, "utf8")
      .digest("hex")
    : "";

  return {
    eventId,
    nonce,
    timestamp,
    signature,
    headers: {
      "x-sync-key-id": TEAMNODE_SYNC_KEY_ID,
      "x-sync-timestamp": timestamp,
      "x-sync-nonce": nonce,
      "x-event-id": eventId,
      ...(signature ? { "x-sync-signature": signature } : {}),
      ...(TEAMNODE_SYNC_RELAY_TOKEN
        ? { "x-teamnode-sync-relay-token": TEAMNODE_SYNC_RELAY_TOKEN }
        : {})
    }
  };
}

function isTeamNodeSyncConfigured() {
  return Boolean(
    TEAMNODE_SYNC_ENABLED
    && normalizeBaseUrl(TEAMNODE_SYNC_BASE_URL)
    && TEAMNODE_SYNC_KEY_ID
    && (TEAMNODE_SYNC_SECRET || TEAMNODE_SYNC_RELAY_TOKEN)
  );
}

function extractRiskScore(data) {
  const candidates = [
    data?.security?.risk_score,
    data?.security?.riskScore,
    data?.risk_score,
    data?.riskScore,
    data?.score
  ];

  for (const candidate of candidates) {
    const score = Number(candidate);
    if (Number.isFinite(score)) return score;
  }

  return null;
}

function resolveIpPlatform(data = {}) {
  const radar = data?.network?.radar || {};
  const candidates = [
    radar.aka,
    radar.name,
    data?.network?.org
  ];

  for (const candidate of candidates) {
    const platform = String(candidate || "").trim();
    if (platform) return platform;
  }

  return "Unknown";
}

async function getIpRiskInfo() {
  const response = await axios.get("https://api.ipbot.com/", {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 5000
  });

  const data = response.data || {};
  const score = extractRiskScore(data);
  return {
    ip: data?.ip || null,
    score,
    riskScore: score,
    security: {
      risk_score: data?.security?.risk_score ?? null,
      risk_reasons: data?.security?.risk_reasons || [],
      usage_type: data?.security?.usage_type || null,
      is_datacenter: data?.security?.is_datacenter ?? null,
      is_proxy: data?.security?.is_proxy ?? null,
      threat_level: data?.security?.threat_level || null,
      threat_lists: data?.security?.threat_lists || []
    },
    platform: resolveIpPlatform(data),
    network: {
      asn: data?.network?.asn || null,
      org: data?.network?.org || null,
      radarName: data?.network?.radar?.name || null,
      radarAka: data?.network?.radar?.aka || null,
      radarWebsite: data?.network?.radar?.website || null,
      confidenceLevel: data?.network?.radar?.confidence_level ?? null
    },
    location: {
      country: data?.location?.country || null,
      countryCode: data?.location?.country_code || null,
      region: data?.location?.region || null,
      city: data?.location?.city || null,
      timezone: data?.location?.timezone || null
    }
  };
}

async function resolveTeamNodeIpRiskInfo() {
  if (!isTeamNodeSyncConfigured()) return false;

  try {
    const riskInfo = await getIpRiskInfo();
    const scoreText = riskInfo.score === null ? "未知" : riskInfo.score;
    const locationText = [
      riskInfo.location?.countryCode,
      riskInfo.location?.city
    ].filter(Boolean).join("-");
    const reasonsText = Array.isArray(riskInfo.security?.risk_reasons) && riskInfo.security.risk_reasons.length > 0
      ? riskInfo.security.risk_reasons.join(",")
      : "无";
    console.log(`IP 风控检测：IP=${riskInfo.ip || "Unknown"}，平台=${riskInfo.platform || "Unknown"}，地区=${locationText || "Unknown"}，security.risk_score=${scoreText}，usage_type=${riskInfo.security?.usage_type || "Unknown"}，is_datacenter=${riskInfo.security?.is_datacenter}，is_proxy=${riskInfo.security?.is_proxy}，risk_reasons=${reasonsText}`);
    return riskInfo;
  } catch (error) {
    console.error(`IP 风控检测失败，将继续 TeamNode 同步：${error?.message || error}`);
    return null;
  }
}

function sanitizeNodeNamePart(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildIpRiskNodeSuffix(ipRisk) {
  if (!ipRisk) return "";

  const platform = sanitizeNodeNamePart(ipRisk.platform || ipRisk.network?.org || "Unknown");
  const score = ipRisk.score === null || ipRisk.score === undefined ? "未知" : ipRisk.score;
  return sanitizeNodeNamePart(`${platform}-risk${score}`);
}

async function resolveNodeIpRiskInfo() {
  try {
    const riskInfo = await getIpRiskInfo();
    const scoreText = riskInfo.score === null ? "未知" : riskInfo.score;
    console.log(`节点风控展示：${riskInfo.ip || "Unknown"}，${riskInfo.platform || "Unknown"}，security.risk_score=${scoreText}`);
    return riskInfo;
  } catch (error) {
    console.error(`节点风控展示检测失败，将使用原节点名称：${error?.message || error}`);
    return null;
  }
}

function normalizeCountryCode(value) {
  return String(value || "").trim().toUpperCase();
}

function resolveCountryLabel(meta = {}) {
  const countryCode = normalizeCountryCode(meta.countryCode);
  if (countryCode && typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
    try {
      const displayNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
      const localized = String(displayNames.of(countryCode) || "").trim();
      if (localized && localized.toLowerCase() !== countryCode.toLowerCase()) {
        return localized;
      }
    } catch {
      // Ignore locale lookup failures and fall back to API text.
    }
  }

  const countryName = String(meta.countryName || "").trim();
  if (countryName && !/^unknown$/i.test(countryName)) {
    return countryName;
  }

  return countryCode || "未知地区";
}

function resolveTeamNodeProvider(meta = {}) {
  const configured = String(TEAMNODE_SYNC_PROVIDER || "").trim().toLowerCase();
  if (configured) {
    return configured;
  }

  const countryCode = normalizeCountryCode(meta.countryCode);
  if (!countryCode || /^unknown$/i.test(countryCode)) {
    return "auto";
  }

  return String(PROVIDER_CODE_OVERRIDES[countryCode] || countryCode).trim().toLowerCase() || "auto";
}

function buildDefaultNodeName(meta = {}) {
  const nodeSuffix = String(resolveCountryLabel(meta) || meta.display || "Unknown").trim() || "Unknown";
  return NAME ? `${NAME}-${nodeSuffix}` : nodeSuffix;
}

function buildTeamNodeLabel(nodeName, argoDomain, meta = {}) {
  const prefix = String(TEAMNODE_SYNC_LABEL_PREFIX || "").trim();
  const suffix = String(nodeName || resolveCountryLabel(meta) || argoDomain || "node").trim();
  if (!prefix) {
    return suffix.slice(0, 128);
  }
  if (suffix.toLowerCase().startsWith(`${prefix.toLowerCase()}-`)) {
    return suffix.slice(0, 128);
  }
  return `${prefix}-${suffix}`.slice(0, 128);
}

function getRuntimeInfo() {
  const cpuCount = os.cpus().length;
  const totalMemoryMb = Math.round(os.totalmem() / (1024 * 1024));
  return {
    platform: String(process.platform || "").slice(0, 32),
    arch: String(process.arch || "").slice(0, 32),
    osType: String(os.type() || "").slice(0, 64),
    osRelease: String(os.release() || "").slice(0, 128),
    cpuCores: Number.isFinite(cpuCount) ? cpuCount : null,
    memoryMb: Number.isFinite(totalMemoryMb) ? totalMemoryMb : null
  };
}

function appendRouteProbeProgress(message) {
  const text = String(message || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 1024);
  if (!text) return;
  try {
    fs.appendFileSync(routeProbeProgressPath, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`无法写入公网路由心跳进度：${error.message}`);
  }
}

function tunnelConnectivityProtocols(protocol = getCloudflaredProtocol()) {
  if (protocol === "quic") return ["UDP"];
  if (protocol === "http2") return ["TCP"];
  return ["TCP", "UDP"];
}

function normalizeTunnelConnectivityReason(error) {
  const code = String(error?.code || "").toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) return "dns_error";
  if (["ECONNABORTED", "ETIMEDOUT"].includes(code)) return "edge_timeout";
  return "edge_request_failed";
}

function probeTcpPort(host, port, timeoutMs, address = host, family = undefined) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({
      host: address,
      port,
      ...(family ? { family } : {})
    });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ...result,
        host,
        address,
        port,
        latencyMs: Math.max(0, Date.now() - startedAt)
      });
    };

    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "timeout" }));
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", (error) => finish({
      ok: false,
      error: String(error?.code || error?.message || "connect_error").slice(0, 64)
    }));
  });
}

async function resolveCloudflareTunnelAddresses(host) {
  try {
    const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (Array.isArray(addresses) && addresses.length > 0) {
      return addresses.map((entry) => ({
        address: String(entry.address),
        family: Number(entry.family) === 6 ? 6 : 4
      }));
    }
  } catch {
    // 解析失败交给后续探测返回具体错误，不把它误报为端口已开放。
  }
  return [{ address: host, family: undefined }];
}

async function probeCloudflareTunnelPort(protocol) {
  if (protocol === "quic") {
    return {
      status: "not_checked",
      host: null,
      port: CLOUDFLARED_TUNNEL_PORT,
      latencyMs: null
    };
  }

  const timeoutMs = Number.isFinite(CLOUDFLARED_CONNECTIVITY_TIMEOUT_MS)
    && CLOUDFLARED_CONNECTIVITY_TIMEOUT_MS > 0
    ? CLOUDFLARED_CONNECTIVITY_TIMEOUT_MS
    : 3000;
  const probes = (await Promise.all(CLOUDFLARED_EDGE_HOSTS.map(async (host) => {
    const addresses = await resolveCloudflareTunnelAddresses(host);
    return Promise.all(addresses.map(({ address, family }) => (
      probeTcpPort(host, CLOUDFLARED_TUNNEL_PORT, timeoutMs, address, family)
    )));
  }))).flat();
  const successfulProbe = probes.find((probe) => probe.ok);
  if (successfulProbe) {
    return {
      status: "open",
      host: successfulProbe.host,
      port: CLOUDFLARED_TUNNEL_PORT,
      latencyMs: successfulProbe.latencyMs
    };
  }

  return {
    status: "blocked",
    host: probes[0]?.host || null,
    port: CLOUDFLARED_TUNNEL_PORT,
    latencyMs: probes.reduce((lowest, probe) => Math.min(lowest, probe.latencyMs), Number.POSITIVE_INFINITY)
  };
}

async function checkCloudflareTunnelConnectivity(argoDomain, { force = false } = {}) {
  const checkedAt = Date.now();
  const protocol = getCloudflaredProtocol();
  const requiredProtocols = tunnelConnectivityProtocols(protocol);
  const baseResult = {
    status: "unknown",
    checkedAt,
    protocol,
    port: CLOUDFLARED_TUNNEL_PORT,
    requiredProtocols,
    portStatus: "unknown",
    httpStatus: null,
    latencyMs: null,
    reason: "not_checked"
  };
  const domain = String(argoDomain || "").trim();

  if (DIRECT_MODE || PLATFORM_PROXY_MODE) {
    return {
      ...baseResult,
      status: "not_applicable",
      reason: "not_cloudflare_tunnel",
      mode: DIRECT_MODE ? "direct" : "platform",
      directPort: DIRECT_MODE ? DIRECT_PORT : Number.parseInt(ARGO_PORT, 10),
      directHttpPort: DIRECT_MODE ? DIRECT_HTTP_PORT : null,
      tlsEnabled: DIRECT_MODE ? DIRECT_TLS_ENABLED : true
    };
  }
  if (!domain) {
    return { ...baseResult, reason: "endpoint_missing" };
  }

  const cacheKey = `${domain}|${protocol}`;
  const cacheAge = tunnelConnectivityCache
    ? checkedAt - Number(tunnelConnectivityCache.value?.checkedAt || 0)
    : Number.POSITIVE_INFINITY;
  if (!force && tunnelConnectivityCache?.key === cacheKey && cacheAge >= 0 && cacheAge < CLOUDFLARED_CONNECTIVITY_CACHE_MS) {
    return tunnelConnectivityCache.value;
  }

  const portProbe = await probeCloudflareTunnelPort(protocol);
  const portResult = {
    port: portProbe.port,
    portStatus: portProbe.status,
    portHost: portProbe.host,
    latencyMs: portProbe.latencyMs
  };
  const startedAt = Date.now();
  try {
    const response = await axios.get(`https://${domain}/`, {
      headers: { "User-Agent": "nodejs-argo-tunnel-health/1.0" },
      timeout: Number.isFinite(CLOUDFLARED_CONNECTIVITY_TIMEOUT_MS) && CLOUDFLARED_CONNECTIVITY_TIMEOUT_MS > 0
        ? CLOUDFLARED_CONNECTIVITY_TIMEOUT_MS
        : 3000,
      maxContentLength: 64 * 1024,
      maxBodyLength: 64 * 1024,
      validateStatus: () => true
    });
    const bodyText = typeof response.data === "string" ? response.data.slice(0, 512) : "";
    const isTunnelInactive = response.status === 530 || /error\s*code:\s*1033/i.test(bodyText);
    const responseHeaders = response.headers || {};
    const isCloudflareEdge = Boolean(responseHeaders["cf-ray"])
      || /cloudflare/i.test(String(responseHeaders.server || ""));
    const endpointNotTunnel = !isCloudflareEdge && !isTunnelInactive;
    const edgeStatus = isTunnelInactive || endpointNotTunnel
      ? "offline"
      : response.status >= 500 ? "degraded" : "connected";
    const value = {
      ...baseResult,
      ...portResult,
      // Tunnel 的公网响应证明实际路线已经建立；不要因为单个
      // Cloudflare 地址的原始 TCP 探测失败而覆盖真实 Tunnel 状态。
      portStatus: edgeStatus === "connected" && portProbe.status === "blocked"
        ? "open"
        : portProbe.status,
      status: edgeStatus,
      httpStatus: Number.isFinite(Number(response.status)) ? Number(response.status) : null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      reason: isTunnelInactive
        ? "tunnel_inactive"
        : endpointNotTunnel
          ? "endpoint_not_cloudflare"
          : response.status >= 500 ? "origin_error" : "edge_reachable"
    };
    tunnelConnectivityCache = { key: cacheKey, value };
    return value;
  } catch (error) {
    const value = {
      ...baseResult,
      ...portResult,
      status: "offline",
      latencyMs: Math.max(0, Date.now() - startedAt),
      reason: normalizeTunnelConnectivityReason(error)
    };
    tunnelConnectivityCache = { key: cacheKey, value };
    return value;
  }
}

async function postTeamNodeSync(relativePath, payload, eventPrefix, { forceIpv4 = false } = {}) {
  const baseUrl = normalizeBaseUrl(TEAMNODE_SYNC_BASE_URL);
  if (!baseUrl) return null;

  const requestUrl = new URL(relativePath, `${baseUrl}/`);
  const rawBody = JSON.stringify(payload || {});
  const { headers } = createTeamNodeSyncHeaders({
    method: "POST",
    path: requestUrl.pathname,
    rawBody,
    eventPrefix
  });

  return axios.post(requestUrl.toString(), payload, {
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    timeout: Number.isFinite(TEAMNODE_SYNC_TIMEOUT_MS) && TEAMNODE_SYNC_TIMEOUT_MS > 0
      ? TEAMNODE_SYNC_TIMEOUT_MS
      : 10000,
    ...(forceIpv4 ? { httpsAgent: TEAMNODE_IPV4_HTTPS_AGENT } : {})
  });
}

function buildTeamNodePayload(context, { includeContent = true, runtimeStatus = "starting" } = {}) {
  if (!context || !context.argoDomain) return null;

  const payload = {
    groupKey: TEAMNODE_SYNC_GROUP_KEY,
    label: buildTeamNodeLabel(context.nodeName, context.argoDomain, context.meta),
    provider: resolveTeamNodeProvider(context.meta),
    uuid: UUID,
    argoDomain: context.argoDomain,
    projectUrl: PROJECT_URL || null,
    subPath: SUB_PATH || null,
    runtimeStatus,
    countryCode: context.meta?.countryCode || null,
    countryName: context.meta?.countryName || null,
    ispName: context.meta?.ispName || null,
    timezone: context.ipRisk?.location?.timezone || context.meta?.timezone || null,
    runtimeInfo: getRuntimeInfo(),
    tunnelConnectivity: context.tunnelConnectivity || null,
    bootId: bootInstanceId,
    metadata: {
      cfip: CFIP,
      cfport: CFPORT,
      nodeName: context.nodeName || "",
      projectUrl: PROJECT_URL || "",
      subPath: SUB_PATH || "",
      ipRisk: context.ipRisk || null
    }
  };

  if (includeContent) {
    payload.contentBase64 = context.contentBase64 || null;
  }

  return payload;
}

async function syncNodeRegistrationToTeamNode(context) {
  if (!isTeamNodeSyncConfigured() || !context) return null;
  const payload = buildTeamNodePayload(context, { includeContent: true, runtimeStatus: "starting" });
  if (!payload) return null;

  const response = await postTeamNodeSync("/api/internal/nodejs-argo/registrations", payload, "nodejs_argo_register");
  if (response && response.status === 200) {
    teamnodeSyncRegistered = true;
    console.log("TeamNode 注册成功");
    return response.data || null;
  }
  return null;
}

async function syncNodeHeartbeatToTeamNode(context) {
  if (!isTeamNodeSyncConfigured() || !context) return null;
  const payload = buildTeamNodePayload(context, {
    includeContent: TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT,
    runtimeStatus: "running"
  });
  if (!payload) return null;

  try {
    const response = await postTeamNodeSync("/api/internal/nodejs-argo/heartbeats", payload, "nodejs_argo_heartbeat");
    if (response && response.status === 200) {
      teamnodeSyncRegistered = true;
      console.log("TeamNode 心跳成功");
      return response.data || null;
    }
    return null;
  } catch (error) {
    if (error?.response?.status === 404) {
      teamnodeSyncRegistered = false;
      console.log("TeamNode 未找到来源节点，自动重新注册");
      return syncNodeRegistrationToTeamNode(context);
    }
    throw error;
  }
}

async function syncNodeOfflineToTeamNode(context, reason = "process_shutdown") {
  if (!isTeamNodeSyncConfigured() || !context || !teamnodeSyncRegistered) return null;

  const payload = {
    uuid: UUID,
    argoDomain: context.argoDomain,
    reason: String(reason || "process_shutdown").trim() || "process_shutdown"
  };

  if (!payload.argoDomain) return null;

  try {
    const response = await postTeamNodeSync("/api/internal/nodejs-argo/offline", payload, "nodejs_argo_offline");
    if (response && response.status === 200) {
      teamnodeSyncRegistered = false;
      console.log("TeamNode 下线通知成功");
      return response.data || null;
    }
    return null;
  } catch (error) {
    if (error?.response?.status === 404) {
      teamnodeSyncRegistered = false;
      console.log("TeamNode 未找到来源节点，跳过下线通知");
      return null;
    }
    throw error;
  }
}

function directFallbackFailureThreshold() {
  return Number.isInteger(DIRECT_FALLBACK_FAILURE_THRESHOLD) && DIRECT_FALLBACK_FAILURE_THRESHOLD >= 1
    ? Math.min(DIRECT_FALLBACK_FAILURE_THRESHOLD, 10)
    : 2;
}

function expandPortSpec(value, limit = 1024) {
  const ports = [];
  const addPort = (candidate) => {
    const port = Number.parseInt(String(candidate).trim(), 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !ports.includes(port) && ports.length < limit) {
      ports.push(port);
    }
  };

  for (const item of String(value || "").split(",")) {
    const part = item.trim();
    if (!part) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (!range) {
      addPort(part);
      continue;
    }
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) continue;
    for (let port = start; port <= end && ports.length < limit; port += 1) addPort(port);
  }
  return ports;
}

function buildDirectPortScanCandidates() {
  const max = Number.isInteger(DIRECT_PORT_SCAN_MAX) && DIRECT_PORT_SCAN_MAX > 0
    ? Math.min(DIRECT_PORT_SCAN_MAX, 4096)
    : 0;
  if (!max) return [];

  const excluded = new Set([
    ...DIRECT_PORT_CANDIDATES,
    ...LOCAL_SERVICE_PORTS,
    22,
    25,
    53,
    110,
    143,
    587,
    3306,
    3389
  ]);
  const candidates = expandPortSpec(DIRECT_PORT_SCAN_PORTS, max * 2)
    .filter((port) => !excluded.has(port));
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(DIRECT_PORT_SCAN_RANGE.trim());
  if (!range || candidates.length >= max) return candidates.slice(0, max);

  const start = Number.parseInt(range[1], 10);
  const end = Number.parseInt(range[2], 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    return candidates.slice(0, max);
  }

  const remaining = max - candidates.length;
  const span = end - start + 1;
  for (let index = 0; index < remaining; index += 1) {
    const port = start + Math.floor((index * span) / remaining);
    if (!excluded.has(port) && !candidates.includes(port)) candidates.push(port);
  }
  return candidates.slice(0, max);
}

function createDirectPortListener(port) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.end();
    });
    const onError = (error) => {
      server.removeListener("error", onError);
      resolve({
        port,
        status: "local_unavailable",
        reason: String(error?.code || error?.message || "listen_error").slice(0, 64),
        server: null
      });
    };

    server.once("error", onError);
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      server.removeListener("error", onError);
      resolve({ port, status: "listening", server });
    });
  });
}

async function probePublicRoute({ domain = ARGO_DOMAIN, mode = DIRECT_MODE ? "direct" : "tunnel", port = DIRECT_PORT, httpPort = DIRECT_HTTP_PORT, tlsEnabled = DIRECT_TLS_ENABLED } = {}) {
  if (!TEAMNODE_SYNC_RELAY_TOKEN) {
    return { ok: false, externalStatus: "blocked", reason: "relay_token_missing", checkedAt: Date.now() };
  }

  try {
    const response = await postTeamNodeSync(
      PUBLIC_ROUTE_PROBE_PATH,
      {
        uuid: UUID,
        domain,
        mode,
        port: mode === "direct" ? port : 7844,
        httpPort: mode === "direct" && tlsEnabled ? httpPort : null,
        tlsEnabled: mode === "direct" ? tlsEnabled : true
      },
      "nodejs_argo_public_route_probe",
      { forceIpv4: mode === "direct" }
    );
    if (!response || response.status !== 200 || !response.data) {
      return {
        ok: false,
        externalStatus: "blocked",
        reason: `public_probe_rejected_${response?.status || "unknown"}`,
        checkedAt: Date.now()
      };
    }
    return response.data;
  } catch (error) {
    return {
      ok: false,
      externalStatus: "blocked",
      reason: String(error?.response?.data?.error || error?.message || "public_probe_failed").slice(0, 64),
      checkedAt: Date.now()
    };
  }
}

function mergePublicRouteProbe(connectivity, publicProbe) {
  if (!connectivity || !publicProbe) return connectivity;
  const reachable = publicProbe.ok === true || publicProbe.externalStatus === "reachable";
  const directMode = connectivity.mode === "direct";
  return {
    ...connectivity,
    publicProbeStatus: reachable ? "reachable" : "blocked",
    publicProbeAt: Number(publicProbe.checkedAt || Date.now()),
    publicProbeReason: String(publicProbe.reason || "unknown").slice(0, 64),
    publicProbeHttpStatus: Number.isFinite(Number(publicProbe.httpStatus)) ? Number(publicProbe.httpStatus) : null,
    publicProbeBlockedPort: Number.isFinite(Number(publicProbe.blockedPort)) ? Number(publicProbe.blockedPort) : null,
    ...(reachable
      ? {}
      : { status: "offline", reason: String(publicProbe.reason || "public_probe_failed").slice(0, 64) })
  };
}

async function verifyPublicRouteAtStartup({ throwOnFailure = true, domain = ARGO_DOMAIN } = {}) {
  const mode = DIRECT_MODE ? "direct" : "tunnel";
  let lastProbe = null;
  for (let attempt = 1; attempt <= PUBLIC_ROUTE_PROBE_ATTEMPTS; attempt += 1) {
    appendRouteProbeProgress(
      `Worker 最终路线回访 ${attempt}/${PUBLIC_ROUTE_PROBE_ATTEMPTS}：${mode} ${domain}${mode === "direct" ? `:${DIRECT_PORT}` : ""}`
    );
    lastProbe = await probePublicRoute({
      domain,
      mode,
      port: DIRECT_MODE ? DIRECT_PORT : 7844,
      httpPort: DIRECT_MODE && DIRECT_TLS_ENABLED ? DIRECT_HTTP_PORT : null,
      tlsEnabled: DIRECT_MODE ? DIRECT_TLS_ENABLED : true
    });
    if (lastProbe?.ok) {
      appendRouteProbeProgress(
        `Worker 最终路线回访通过：${lastProbe.reason || "reachable"}${lastProbe.httpStatus ? `，HTTP ${lastProbe.httpStatus}` : ""}`
      );
      publicRouteProbeCache = { ...lastProbe, mode, domain };
      console.log(
        `Worker 公网路由心跳通过：${mode === "direct" ? (DIRECT_TLS_ENABLED ? "HTTPS" : "HTTP") : "Tunnel"}`
        + ` ${domain}${DIRECT_MODE ? `:${DIRECT_PORT}` : ""}`
        + `${lastProbe.httpStatus ? `（HTTP ${lastProbe.httpStatus}）` : ""}`
      );
      return lastProbe;
    }
    appendRouteProbeProgress(
      `Worker 最终路线回访失败 ${attempt}/${PUBLIC_ROUTE_PROBE_ATTEMPTS}：${lastProbe?.reason || "unknown"}`
    );
    console.warn(`Worker 公网路由心跳失败 ${attempt}/${PUBLIC_ROUTE_PROBE_ATTEMPTS}：${lastProbe?.reason || "unknown"}`);
    if (attempt < PUBLIC_ROUTE_PROBE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, PUBLIC_ROUTE_PROBE_RETRY_DELAY_MS));
    }
  }

  publicRouteProbeCache = lastProbe ? { ...lastProbe, mode, domain } : null;
  if (throwOnFailure) {
    throw noRouteError(`install.lemon.vin 公网路由心跳未通过：${lastProbe?.reason || "public_route_unreachable"}`);
  }
  return lastProbe || { ok: false, reason: "public_route_unreachable" };
}

function markRouteReady() {
  try {
    appendRouteProbeProgress(`公网路线验证完成：${ARGO_DOMAIN || "platform"}`);
    fs.writeFileSync(routeReadyMarkerPath, `${new Date().toISOString()} ${ARGO_DOMAIN || "platform"}\n`, { mode: 0o600 });
    console.log("公网路由启动验证通过，已允许节点注册");
  } catch (error) {
    throw new Error(`无法写入公网路由成功标记：${error.message}`);
  }
}

function closeDirectPortListener(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    setTimeout(finish, 1000).unref?.();
  });
}

function formatDirectProbeResults(results) {
  return (Array.isArray(results) ? results : [])
    .map((result) => {
      const port = Number(result?.port);
      const status = String(result?.status || "unknown");
      const reason = String(result?.reason || "").trim();
      return `${Number.isInteger(port) ? port : "?"}=${status}${reason ? `(${reason})` : ""}`;
    })
    .join(", ");
}

async function probeDirectPortCandidates(ports = DIRECT_PORT_CANDIDATES) {
  const normalizedPorts = [...new Set((Array.isArray(ports) ? ports : [])
    .map((port) => Number.parseInt(String(port), 10))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535 && !LOCAL_SERVICE_PORTS.has(port)))];
  if (!normalizedPorts.length) {
    appendRouteProbeProgress("直连端口心跳：没有可用候选端口（已排除本机服务端口）");
    return { results: [], error: "direct_port_candidates_empty" };
  }

  appendRouteProbeProgress(`直连端口心跳：准备本机临时监听 TCP ${normalizedPorts.join(",")}`);
  const listeners = await Promise.all(normalizedPorts.map((port) => createDirectPortListener(port)));
  const listeningPorts = listeners.filter((entry) => entry.status === "listening").map((entry) => entry.port);
  appendRouteProbeProgress(
    `本机临时监听结果：${formatDirectProbeResults(listeners)}；可供 Worker 回访：${listeningPorts.join(",") || "无"}`
  );
  let remoteResults = [];

  try {
    if (listeningPorts.length > 0) {
      appendRouteProbeProgress(`请求 Worker 通过本机 IPv4 出口，从公网回访 TCP ${listeningPorts.join(",")}`);
      const response = await postTeamNodeSync(
        "/api/internal/nodejs-argo/direct-port-probe",
        { uuid: UUID, ports: listeningPorts },
        "nodejs_argo_direct_port_probe",
        { forceIpv4: true }
      );
      if (!response || response.status !== 200) {
        throw new Error(`direct_port_probe_rejected_${response?.status || "unknown"}`);
      }
      remoteResults = Array.isArray(response.data?.results) ? response.data.results : [];
      appendRouteProbeProgress(
        `Worker 外部回访结果：公网 IP ${response.data?.host || "unknown"}；${formatDirectProbeResults(remoteResults) || "无结果"}`
      );
    }
  } catch (error) {
    appendRouteProbeProgress(`Worker 外部回访请求失败：${String(error?.message || "probe_error").slice(0, 128)}`);
    return {
      results: listeners.map((entry) => entry.status === "listening"
        ? { port: entry.port, status: "unknown", reason: String(error?.message || "probe_error").slice(0, 64) }
        : { port: entry.port, status: entry.status, reason: entry.reason }),
      error: String(error?.message || "direct_port_probe_failed").slice(0, 128)
    };
  } finally {
    await Promise.all(listeners.map((entry) => closeDirectPortListener(entry.server)));
  }

  const remoteByPort = new Map(remoteResults.map((result) => [Number(result?.port), result]));
  return {
    results: listeners.map((entry) => entry.status === "listening"
      ? remoteByPort.get(entry.port) || { port: entry.port, status: "unknown", reason: "probe_result_missing" }
      : { port: entry.port, status: entry.status, reason: entry.reason })
  };
}

function selectDirectFallbackPlan(results) {
  const byPort = new Map(
    (Array.isArray(results) ? results : [])
      .map((result) => [Number(result?.port), result])
  );
  const isOpen = (port) => byPort.get(port)?.status === "open";
  const nginxAvailable = fs.existsSync(NGINX_BIN);
  const certificatePaths = getDirectCertificatePaths();
  const tlsAvailable = DIRECT_TLS_ENABLED && nginxAvailable && (
    fs.existsSync(CERTBOT_BIN)
    || (fs.existsSync(certificatePaths.certificateFile) && fs.existsSync(certificatePaths.keyFile))
  );

  if (!nginxAvailable) return null;

  if (tlsAvailable && isOpen(443) && isOpen(80)) {
    return {
      tlsEnabled: true,
      port: 443,
      httpPort: 80,
      reason: "https_443_and_http_80"
    };
  }

  const resultPorts = (Array.isArray(results) ? results : [])
    .map((result) => Number(result?.port))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  const fallbackOrder = [80, 8080, 8443, 8880, 2053, 2083, 2087, 2096, 443, ...DIRECT_PORT_CANDIDATES, ...resultPorts]
    .filter((candidate) => !LOCAL_SERVICE_PORTS.has(candidate));
  const port = [...new Set(fallbackOrder)].find((candidate) => isOpen(candidate));
  if (!port) return null;

  return {
    tlsEnabled: false,
    port,
    httpPort: port,
    reason: "http_fallback_port_available"
  };
}

async function discoverDirectPortPlan() {
  appendRouteProbeProgress(
    `开始直连初始候选端口心跳：${DIRECT_PORT_CANDIDATES.join(",") || "无"}；本机端口 ${[...LOCAL_SERVICE_PORTS].join(",")} 已排除`
  );
  const initialProbe = await probeDirectPortCandidates();
  const allResults = [...initialProbe.results];
  let plan = selectDirectFallbackPlan(allResults);
  if (plan) {
    appendRouteProbeProgress(`直连端口心跳已选择 ${plan.tlsEnabled ? "HTTPS" : "HTTP"} ${plan.port}`);
    return { plan, results: allResults };
  }

  const scanCandidates = buildDirectPortScanCandidates();
  let lastError = initialProbe.error || "";
  const totalBatches = Math.ceil(scanCandidates.length / DIRECT_PORT_PROBE_BATCH_SIZE);
  for (let index = 0; index < scanCandidates.length; index += DIRECT_PORT_PROBE_BATCH_SIZE) {
    const batch = scanCandidates.slice(index, index + DIRECT_PORT_PROBE_BATCH_SIZE);
    appendRouteProbeProgress(
      `直连扩展端口心跳批次 ${Math.floor(index / DIRECT_PORT_PROBE_BATCH_SIZE) + 1}/${totalBatches}：${batch.join(",")}`
    );
    const probe = await probeDirectPortCandidates(batch);
    allResults.push(...probe.results);
    if (probe.error) lastError = probe.error;
    plan = selectDirectFallbackPlan(allResults);
    if (plan) {
      appendRouteProbeProgress(`直连端口心跳已选择 ${plan.tlsEnabled ? "HTTPS" : "HTTP"} ${plan.port}`);
      return { plan, results: allResults };
    }
  }

  appendRouteProbeProgress(
    `直连端口心跳结束：未发现公网可达端口；${lastError || "direct_port_scan_exhausted"}`
  );
  return { plan: null, results: allResults, error: lastError || "direct_port_scan_exhausted" };
}

function writeDirectFallbackEnv(plan) {
  const envFile = String(NODEJS_ARGO_ENV_FILE || "").trim();
  if (!envFile) {
    throw new Error("NODEJS_ARGO_ENV_FILE 未配置，无法持久化直连模式");
  }
  const resolvedEnvFile = path.resolve(envFile);
  if (!fs.existsSync(resolvedEnvFile)) {
    throw new Error(`环境文件不存在：${resolvedEnvFile}`);
  }

  const updates = {
    DIRECT_MODE: "true",
    DIRECT_TLS_ENABLED: plan.tlsEnabled ? "true" : "false",
    DIRECT_PORT: String(plan.port),
    DIRECT_HTTP_PORT: String(plan.httpPort),
    CFPORT: String(plan.port),
    CFIP: ARGO_DOMAIN,
    CF_DNS_ENABLED: CF_API_TOKEN ? "true" : "false",
    CF_DNS_RECORD_NAME: ARGO_DOMAIN,
    CF_DNS_REPLACE_CNAME: "true",
    // DIRECT_MODE 会阻止 Tunnel 启动，因此保留自动探测，让重启后的
    // 直连模式继续验证公网端口；如果全部端口失效，启动流程会停止。
    AUTO_DIRECT_FALLBACK: "true",
    CF_API_TOKEN,
    CLOUDFLARE_API_KEY: CF_API_TOKEN
  };
  const raw = fs.readFileSync(resolvedEnvFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const seen = new Set();
  const output = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    const key = match?.[1];
    if (!key || !Object.prototype.hasOwnProperty.call(updates, key)) return line;
    seen.add(key);
    return `${key}=${shellQuote(updates[key])}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) output.push(`${key}=${shellQuote(value)}`);
  }

  fs.writeFileSync(resolvedEnvFile, `${output.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(resolvedEnvFile, 0o600);
  } catch {
    // The installer already owns this file; mode changes are best effort.
  }
}

async function maybeActivateDirectFallback(syncContext, tunnelConnectivity) {
  if (DIRECT_MODE || PLATFORM_PROXY_MODE || !AUTO_DIRECT_FALLBACK || directFallbackPromise) {
    return false;
  }

  if (tunnelConnectivity?.status === "connected") {
    tunnelFailureStreak = 0;
    return false;
  }

  const fallbackReasons = new Set([
    "port_blocked",
    "edge_timeout",
    "edge_request_failed",
    "tunnel_inactive",
    "endpoint_not_cloudflare"
  ]);
  if (!fallbackReasons.has(String(tunnelConnectivity?.reason || ""))) {
    return false;
  }

  tunnelFailureStreak += 1;
  const threshold = directFallbackFailureThreshold();
  if (tunnelFailureStreak < threshold) {
    console.log(`Cloudflare Tunnel 连续异常 ${tunnelFailureStreak}/${threshold}，暂不切换直连`);
    return false;
  }

  if (!CF_API_TOKEN) {
    await stopForNoRoute("未配置 Cloudflare API Token，无法把 ARGO_DOMAIN 切换为直连 DNS");
    return true;
  }
  if (!NODEJS_ARGO_ENV_FILE) {
    await stopForNoRoute("未配置 NODEJS_ARGO_ENV_FILE，无法持久化直连模式");
    return true;
  }
  if (!TEAMNODE_SYNC_RELAY_TOKEN) {
    await stopForNoRoute("未配置 TeamNode Worker 中继令牌，无法从公网探测直连端口");
    return true;
  }

  directFallbackPromise = (async () => {
    const discovery = await discoverDirectPortPlan();
    const plan = discovery.plan;
    if (!plan) {
      throw new Error(`候选端口和扩展扫描均未找到可用直连 TCP 端口${discovery.error ? `：${discovery.error}` : ""}`);
    }

    writeDirectFallbackEnv(plan);
    console.warn(
      `Cloudflare Tunnel 连续异常，已选择直连 ${plan.tlsEnabled ? "HTTPS" : "HTTP"} 端口 ${plan.port}`
      + `${plan.tlsEnabled ? "（证书将申请/续期）" : "（不申请证书）"}，正在重启服务应用新配置`
    );
    await stopRuntimeProcesses();
    await stopArgoGateway();
    removeCloudflaredRuntimeArtifacts();
    await shutdownTeamNodeSync("direct_fallback");
    setTimeout(() => process.exit(0), 100);
    return true;
  })()
    .catch((error) => {
      if (error?.code === "NO_ROUTE_DETECTED") {
        stopForNoRoute(error.message).catch((stopError) => {
          console.error(`停止无路线节点失败：${stopError.message}`);
        });
        return true;
      }
      console.error(`自动切换直连失败：${error.message}`);
      directFallbackPromise = null;
      return false;
    });

  return directFallbackPromise;
}

function findTemporaryTunnelDomain() {
  for (const logPath of [bootLogPath, cloudflaredBootLogPath]) {
    try {
      if (!fs.existsSync(logPath)) continue;
      const content = fs.readFileSync(logPath, "utf8");
      const match = content.match(/https?:\/\/([^\s/]+\.trycloudflare\.com)/i);
      if (match?.[1]) return match[1];
    } catch {
      // 日志可能还在被 cloudflared 写入，下一次启动会再次探测。
    }
  }
  return "";
}

async function activateDirectFallbackAtStartup(tunnelConnectivity) {
  if (!AUTO_DIRECT_FALLBACK) {
    throw noRouteError(`Cloudflare Tunnel 不可用（${tunnelConnectivity?.reason || "unknown"}），且已关闭 AUTO_DIRECT_FALLBACK`);
  }
  if (!CF_API_TOKEN) {
    throw noRouteError("未配置 Cloudflare API Token，无法把 ARGO_DOMAIN 切换为直连 DNS");
  }
  if (!NODEJS_ARGO_ENV_FILE) {
    throw noRouteError("未配置 NODEJS_ARGO_ENV_FILE，无法持久化直连模式");
  }
  if (!TEAMNODE_SYNC_RELAY_TOKEN) {
    throw noRouteError("未配置 TeamNode Worker 中继令牌，无法从公网探测直连端口");
  }

  const discovery = await discoverDirectPortPlan();
  const plan = discovery.plan;
  if (!plan) {
    const tunnelReason = tunnelConnectivity?.reason || "unknown";
    throw noRouteError(
      `Cloudflare Tunnel 探测失败（${tunnelReason}）；候选端口和扩展扫描均未找到可用 HTTP/HTTPS 端口${discovery.error ? `：${discovery.error}` : ""}`
    );
  }

  writeDirectFallbackEnv(plan);
  await stopRuntimeProcesses();
  await stopArgoGateway();
  removeCloudflaredRuntimeArtifacts();
  await shutdownTeamNodeSync("startup_direct_fallback");
  console.warn(
    `Tunnel 心跳失败，已选择直连 ${plan.tlsEnabled ? "HTTPS" : "HTTP"} 端口 ${plan.port}`
    + `${plan.tlsEnabled ? "（443+80 可达，重启后申请/续期证书）" : "（不申请证书）"}，正在重启服务`
  );
  setTimeout(() => process.exit(0), 100);
  return true;
}

async function prepareDirectModeStartup() {
  if (!DIRECT_MODE) return false;
  // 直连模式不启动 Tunnel；删除本地凭据/配置，避免旧 Tunnel 残留。
  removeCloudflaredRuntimeArtifacts();
  if (!AUTO_DIRECT_FALLBACK) return false;
  if (!TEAMNODE_SYNC_RELAY_TOKEN || !NODEJS_ARGO_ENV_FILE) {
    throw noRouteError("直连模式缺少 Worker 中继令牌或 NODEJS_ARGO_ENV_FILE，无法验证公网端口");
  }

  const discovery = await discoverDirectPortPlan();
  const plan = discovery.plan;
  if (!plan) {
    throw noRouteError(
      `直连模式端口发现心跳未找到可用 HTTP/HTTPS 端口${discovery.error ? `：${discovery.error}` : ""}`
    );
  }

  const samePlan = DIRECT_TLS_ENABLED === plan.tlsEnabled
    && DIRECT_PORT === plan.port
    && DIRECT_HTTP_PORT === plan.httpPort;
  if (samePlan) {
    console.log(`直连端口发现心跳通过：${plan.tlsEnabled ? "HTTPS" : "HTTP"} ${plan.port}`);
    return false;
  }

  writeDirectFallbackEnv(plan);
  console.warn(
    `直连端口发现心跳已将配置调整为 ${plan.tlsEnabled ? "HTTPS" : "HTTP"} ${plan.port}`
    + `${plan.tlsEnabled ? "（443+80 可达，准备证书）" : "（443+80 不同时可达，不申请证书）"}，正在重启服务`
  );
  setTimeout(() => process.exit(0), 100);
  return true;
}

async function prepareTunnelStartup() {
  if (DIRECT_MODE || PLATFORM_PROXY_MODE) return false;
  if (TUNNEL_PREFLIGHT_BLOCKED) {
    const preflightResult = {
      status: "offline",
      reason: "stage1_7844_blocked",
      protocol: getCloudflaredProtocol(),
      port: CLOUDFLARED_TUNNEL_PORT,
      requiredProtocols: tunnelConnectivityProtocols()
    };
    appendRouteProbeProgress(
      `阶段 1 已确认 ${preflightResult.requiredProtocols.join("/")} ${CLOUDFLARED_TUNNEL_PORT} 被阻断；跳过 Cloudflare Tunnel，直接进入直连端口心跳`
    );
    console.warn("阶段 1 已确认 7844 被阻断，不启动 Cloudflare Tunnel，直接探测直连路线");
    return activateDirectFallbackAtStartup(preflightResult);
  }

  const probeDomain = ARGO_DOMAIN || findTemporaryTunnelDomain();
  const attempts = Number.isInteger(STARTUP_TUNNEL_PROBE_ATTEMPTS)
    && STARTUP_TUNNEL_PROBE_ATTEMPTS >= 1
    ? Math.min(STARTUP_TUNNEL_PROBE_ATTEMPTS, 12)
    : 5;
  const retryDelayMs = Number.isInteger(STARTUP_TUNNEL_PROBE_RETRY_DELAY_MS)
    && STARTUP_TUNNEL_PROBE_RETRY_DELAY_MS >= 500
    ? Math.min(STARTUP_TUNNEL_PROBE_RETRY_DELAY_MS, 30000)
    : 4000;
  let tunnelConnectivity = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    tunnelConnectivity = await checkCloudflareTunnelConnectivity(probeDomain, { force: true });
    appendRouteProbeProgress(
      `Tunnel 心跳 ${attempt}/${attempts}：${tunnelConnectivity.status}；`
      + `${tunnelConnectivity.reason}；${tunnelConnectivity.requiredProtocols.join("/")} ${tunnelConnectivity.port}`
    );
    console.log(
      `启动时 Cloudflare Tunnel 心跳 ${attempt}/${attempts}：${tunnelConnectivity.status}；`
      + `${tunnelConnectivity.reason}；${tunnelConnectivity.requiredProtocols.join("/")} ${tunnelConnectivity.port}`
    );
    if (tunnelConnectivity.status === "connected") {
      const publicProbe = await verifyPublicRouteAtStartup({ throwOnFailure: false, domain: probeDomain });
      if (publicProbe?.ok) {
        appendRouteProbeProgress("Tunnel 7844 出站和 Worker 最终域名回访均通过");
        console.log("Cloudflare Tunnel 7844 出站心跳和 Worker 公网路由心跳均通过，继续使用 Tunnel 模式");
        return false;
      }
      tunnelConnectivity = {
        ...tunnelConnectivity,
        status: "offline",
        reason: publicProbe?.reason || "public_route_unreachable"
      };
      console.warn(
        `Cloudflare Tunnel 7844 出站心跳通过，但 Worker 公网路由心跳失败：${tunnelConnectivity.reason}`
      );
    }
    if (attempt < attempts) {
      console.warn(`Tunnel 心跳尚未完成，${retryDelayMs}ms 后重试`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  appendRouteProbeProgress(
    `Tunnel 心跳最终失败：${tunnelConnectivity?.reason || "unknown"}；开始直连端口发现`
  );
  console.warn(`Cloudflare Tunnel 心跳最终失败：${tunnelConnectivity?.reason || "unknown"}，开始进行直连端口发现心跳`);
  return activateDirectFallbackAtStartup(tunnelConnectivity);
}

async function syncNodeToTeamNode(context) {
  if (!isTeamNodeSyncConfigured()) {
    return null;
  }

  const [ipRisk, tunnelConnectivity, publicProbe] = await Promise.all([
    context.ipRisk && !teamnodeSyncRegistered
      ? context.ipRisk
      : resolveTeamNodeIpRiskInfo(),
    checkCloudflareTunnelConnectivity(context.argoDomain),
    probePublicRoute({
      domain: context.argoDomain,
      mode: DIRECT_MODE ? "direct" : "tunnel",
      port: DIRECT_MODE ? DIRECT_PORT : 7844,
      tlsEnabled: DIRECT_MODE ? DIRECT_TLS_ENABLED : true
    })
  ]);
  const verifiedTunnelConnectivity = mergePublicRouteProbe(tunnelConnectivity, publicProbe);
  const syncContext = {
    ...context,
    ipRisk,
    tunnelConnectivity: verifiedTunnelConnectivity
  };

  console.log(
    `Cloudflare Tunnel 连通性：${verifiedTunnelConnectivity.status}；`
    + `${verifiedTunnelConnectivity.requiredProtocols.join("/")} ${verifiedTunnelConnectivity.port} ${verifiedTunnelConnectivity.portStatus}；`
    + `Worker 公网探测：${verifiedTunnelConnectivity.publicProbeStatus || "unknown"}`
  );

  teamnodeSyncContext = syncContext;

  try {
    const response = teamnodeSyncRegistered
      ? await syncNodeHeartbeatToTeamNode(syncContext)
      : await syncNodeRegistrationToTeamNode(syncContext);
    await maybeActivateDirectFallback(syncContext, verifiedTunnelConnectivity);
    return response;
  } catch (error) {
    const status = error?.response?.status ? ` (HTTP ${error.response.status})` : "";
    const message = error?.response?.data?.error || error?.message || "unknown_error";
    console.error(`TeamNode 同步失败${status}: ${message}`);
    return null;
  }
}

function tunnelTestCommandPollInterval() {
  return Number.isFinite(TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS)
    && TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS >= 5000
    ? Math.min(TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS, 60000)
    : 15000;
}

async function reportTunnelTestResult(command, tunnelConnectivity, startedAt) {
  const completedAt = Date.now();
  const tunnelTest = {
    commandId: String(command?.commandId || "").slice(0, 128),
    type: String(command?.type || "cloudflare_tunnel_connectivity").slice(0, 64),
    status: "completed",
    requestedAt: Number(command?.requestedAt || completedAt),
    startedAt,
    completedAt,
    updatedAt: completedAt,
    reason: "node_test_completed"
  };

  const response = await postTeamNodeSync(
    TUNNEL_TEST_RESULTS_PATH,
    { uuid: UUID, tunnelTest, tunnelConnectivity },
    "nodejs_argo_tunnel_test_result"
  );
  if (!response || response.status !== 200) {
    throw new Error(`tunnel_test_result_rejected_${response?.status || "unknown"}`);
  }
  return response.data || null;
}

async function executeTunnelTestCommand(command) {
  const startedAt = Date.now();
  try {
    const tunnelConnectivity = await checkCloudflareTunnelConnectivity(
      teamnodeSyncContext?.argoDomain || ARGO_DOMAIN,
      { force: true }
    );
    await reportTunnelTestResult(command, tunnelConnectivity, startedAt);
    console.log(`本机 7844 连通性检测完成：${tunnelConnectivity.portStatus}；Tunnel=${tunnelConnectivity.status}`);
  } catch (error) {
    const completedAt = Date.now();
    try {
      await postTeamNodeSync(
        TUNNEL_TEST_RESULTS_PATH,
        {
          uuid: UUID,
          tunnelTest: {
            commandId: String(command?.commandId || "").slice(0, 128),
            type: String(command?.type || "cloudflare_tunnel_connectivity").slice(0, 64),
            status: "failed",
            requestedAt: Number(command?.requestedAt || completedAt),
            startedAt,
            completedAt,
            updatedAt: completedAt,
            reason: "node_test_error"
          }
        },
        "nodejs_argo_tunnel_test_result"
      );
    } catch (reportError) {
      console.error(`本机 7844 检测结果回传失败：${reportError.message}`);
    }
    console.error(`本机 7844 连通性检测失败：${error.message}`);
  }
}

async function pollTunnelTestCommands() {
  if (!TEAMNODE_SYNC_RELAY_TOKEN || !teamnodeSyncRegistered || !teamnodeSyncContext || tunnelTestCommandPollPromise) {
    return null;
  }

  tunnelTestCommandPollPromise = (async () => {
    const response = await postTeamNodeSync(
      TUNNEL_TEST_COMMANDS_PATH,
      { uuid: UUID },
      "nodejs_argo_tunnel_test_poll"
    );
    const commands = Array.isArray(response?.data?.commands) ? response.data.commands.slice(0, 1) : [];
    for (const command of commands) {
      if (String(command?.type || "") !== "cloudflare_tunnel_connectivity") continue;
      await executeTunnelTestCommand(command);
    }
    return commands;
  })()
    .catch((error) => {
      if (error?.response?.status !== 404) {
        console.error(`本机 7844 检测指令获取失败：${error.message}`);
      }
      return null;
    })
    .finally(() => {
      tunnelTestCommandPollPromise = null;
    });

  return tunnelTestCommandPollPromise;
}

function stopTunnelTestCommandPollLoop() {
  if (tunnelTestCommandPollTimer) {
    clearInterval(tunnelTestCommandPollTimer);
    tunnelTestCommandPollTimer = null;
  }
}

function startTunnelTestCommandPollLoop() {
  if (!TEAMNODE_SYNC_RELAY_TOKEN || tunnelTestCommandPollTimer) return;
  stopTunnelTestCommandPollLoop();
  const intervalMs = tunnelTestCommandPollInterval();
  tunnelTestCommandPollTimer = setInterval(() => {
    pollTunnelTestCommands().catch(() => null);
  }, intervalMs);
  if (typeof tunnelTestCommandPollTimer.unref === "function") {
    tunnelTestCommandPollTimer.unref();
  }
  pollTunnelTestCommands().catch(() => null);
}

function stopTeamNodeHeartbeatLoop() {
  if (teamnodeSyncTimer) {
    clearInterval(teamnodeSyncTimer);
    teamnodeSyncTimer = null;
  }
  stopTunnelTestCommandPollLoop();
}

function startTeamNodeHeartbeatLoop(context) {
  if (!isTeamNodeSyncConfigured() || !context) return;

  teamnodeSyncContext = context;
  stopTeamNodeHeartbeatLoop();
  startTunnelTestCommandPollLoop();

  const intervalMs = Number.isFinite(TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS) && TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS >= 30000
    ? TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS
    : 300000;

  teamnodeSyncTimer = setInterval(() => {
    if (!teamnodeSyncContext) return;
    syncNodeToTeamNode(teamnodeSyncContext).catch(() => null);
  }, intervalMs);
}

async function shutdownTeamNodeSync(reason = "process_shutdown") {
  if (teamnodeShutdownPromise) {
    return teamnodeShutdownPromise;
  }

  stopTeamNodeHeartbeatLoop();

  teamnodeShutdownPromise = (async () => {
    try {
      if (!teamnodeSyncContext || !teamnodeSyncRegistered || !isTeamNodeSyncConfigured()) {
        return null;
      }

      return await Promise.race([
        syncNodeOfflineToTeamNode(teamnodeSyncContext, reason),
        new Promise((resolve) => setTimeout(() => resolve(null), TEAMNODE_SYNC_SHUTDOWN_TIMEOUT_MS))
      ]);
    } catch (error) {
      const status = error?.response?.status ? ` (HTTP ${error.response.status})` : "";
      const message = error?.response?.data?.error || error?.message || "unknown_error";
      console.error(`TeamNode 下线通知失败${status}: ${message}`);
      return null;
    } finally {
      teamnodeSyncRegistered = false;
      teamnodeSyncContext = null;
    }
  })();

  return teamnodeShutdownPromise;
}

// 如果订阅器里存在历史节点，先删除旧节点
function deleteNodes() {
  try {
    if (!UPLOAD_URL) return;
    if (!fs.existsSync(subPath)) return;

    let fileContent;
    try {
      fileContent = fs.readFileSync(subPath, "utf-8");
    } catch {
      return null;
    }

    const decoded = Buffer.from(fileContent, "base64").toString("utf-8");
    const nodes = decoded.split("\n").filter((line) => /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line));
    if (nodes.length === 0) return;

    axios.post(
      `${UPLOAD_URL}/api/delete-nodes`,
      JSON.stringify({ nodes }),
      { headers: { "Content-Type": "application/json" } }
    ).catch(() => null);

    return null;
  } catch {
    return null;
  }
}

// 清理运行目录里的历史文件
function cleanupOldFiles() {
  try {
    const preservedFiles = new Set(
      [DIRECT_CERT_FILE, DIRECT_KEY_FILE]
        .filter(Boolean)
        .map((filePath) => path.resolve(filePath))
    );
    const files = fs.readdirSync(FILE_PATH);
    files.forEach((file) => {
      const filePath = path.join(FILE_PATH, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && !preservedFiles.has(path.resolve(filePath))) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // 忽略单个文件删除失败
      }
    });
  } catch {
    // 忽略目录读取失败
  }
}

// 生成 Xray 配置文件
async function generateConfig() {
  const config = {
    log: {
      access: XRAY_ACCESS_LOG_ENABLED ? xrayAccessLogPath : "",
      error: xrayErrorLogPath,
      loglevel: XRAY_LOG_LEVEL
    },
    inbounds: [
      {
        port: 3001,
        listen: "127.0.0.1",
        protocol: "vless",
        settings: { clients: [{ id: UUID }], decryption: "none" },
        streamSettings: { network: "tcp", security: "none" }
      },
      {
        port: 3002,
        listen: "127.0.0.1",
        protocol: "vless",
        settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } },
        sniffing: XRAY_SNIFFING_ENABLED
          ? { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false }
          : { enabled: false }
      },
      {
        port: 3003,
        listen: "127.0.0.1",
        protocol: "vmess",
        settings: { clients: [{ id: UUID, alterId: 0 }] },
        streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } },
        sniffing: XRAY_SNIFFING_ENABLED
          ? { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false }
          : { enabled: false }
      },
      {
        port: 3004,
        listen: "127.0.0.1",
        protocol: "trojan",
        settings: { clients: [{ password: UUID }] },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } },
        sniffing: XRAY_SNIFFING_ENABLED
          ? { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false }
          : { enabled: false }
      }
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    outbounds: [
      { protocol: "freedom", tag: "direct" },
      { protocol: "blackhole", tag: "block" }
    ]
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// 检查镜像内置二进制是否存在
function ensureBinaryExists(binaryPath, label) {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`${label} 二进制不存在：${binaryPath}`);
  }
}

// 非 Windows 环境下为二进制增加执行权限
function authorizeFiles(filePaths) {
  const newPermissions = 0o775;

  filePaths.forEach((absoluteFilePath) => {
    if (!fs.existsSync(absoluteFilePath) || process.platform === "win32") {
      return;
    }

    fs.chmodSync(absoluteFilePath, newPermissions);
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isValidDomain(value) {
  return /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
    String(value || "").trim()
  );
}

function validatePlatformProxyMode() {
  if (!PLATFORM_PROXY_MODE) return;

  if (DIRECT_MODE) {
    throw new Error("PLATFORM_PROXY_MODE=true 与 DIRECT_MODE=true 不能同时启用");
  }

  if (!isValidDomain(ARGO_DOMAIN)) {
    throw new Error("PLATFORM_PROXY_MODE=true 时未找到平台公网域名；请配置 ARGO_DOMAIN 或 PLATFORM_PUBLIC_DOMAIN");
  }

  if (!isValidPort(Number.parseInt(ARGO_PORT, 10))) {
    throw new Error("PLATFORM_PROXY_MODE=true 时 ARGO_PORT 必须是 1-65535 之间的端口");
  }

  if (!isValidPort(PLATFORM_PUBLIC_PORT)) {
    throw new Error("PLATFORM_PUBLIC_PORT 必须是 1-65535 之间的端口");
  }

  if (CF_DNS_ENABLED) {
    throw new Error("PLATFORM_PROXY_MODE=true 时不应启用 CF_DNS_ENABLED；请使用平台提供的域名");
  }
}

function validateDirectMode() {
  if (!DIRECT_MODE) return;

  const domain = String(ARGO_DOMAIN || "").trim();

  if (!isValidDomain(domain)) {
    throw new Error("DIRECT_MODE=true 时 ARGO_DOMAIN 必须是有效的域名，例如 justrunmy.lemon.vin");
  }

  if (!isValidPort(DIRECT_PORT) || !isValidPort(DIRECT_HTTP_PORT)) {
    throw new Error("DIRECT_PORT 和 DIRECT_HTTP_PORT 必须是 1-65535 之间的端口");
  }

  if (DIRECT_TLS_ENABLED && DIRECT_PORT === DIRECT_HTTP_PORT) {
    throw new Error("DIRECT_PORT 和 DIRECT_HTTP_PORT 不能使用同一个端口");
  }

  if (DIRECT_TLS_ENABLED && Boolean(DIRECT_CERT_FILE) !== Boolean(DIRECT_KEY_FILE)) {
    throw new Error("DIRECT_CERT_FILE 和 DIRECT_KEY_FILE 必须同时配置，或同时留空");
  }
}

function validateCloudflareDnsMode() {
  if (!CF_DNS_ENABLED) return;

  if (!DIRECT_MODE) {
    throw new Error("CF_DNS_ENABLED=true 只支持 DIRECT_MODE=true；平台代理模式请关闭它并使用平台域名");
  }

  if (!isValidDomain(CF_DNS_RECORD_NAME)) {
    throw new Error("CF_DNS_RECORD_NAME 必须是有效的域名");
  }

  if (String(CF_DNS_RECORD_NAME).trim().toLowerCase() !== String(ARGO_DOMAIN).trim().toLowerCase()) {
    throw new Error("启用 CF_DNS_ENABLED 时，CF_DNS_RECORD_NAME 必须与 ARGO_DOMAIN 一致");
  }
}

function nginxConfigValue(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function getDirectCertificatePaths() {
  if (DIRECT_CERT_FILE && DIRECT_KEY_FILE) {
    return {
      certificateFile: path.resolve(DIRECT_CERT_FILE),
      keyFile: path.resolve(DIRECT_KEY_FILE),
      managedByCertbot: false
    };
  }

  return {
    certificateFile: path.join(FILE_PATH, "letsencrypt", "live", ARGO_DOMAIN, "fullchain.pem"),
    keyFile: path.join(FILE_PATH, "letsencrypt", "live", ARGO_DOMAIN, "privkey.pem"),
    managedByCertbot: true
  };
}

function buildDirectHttpOnlyNginxConfig() {
  const domain = String(ARGO_DOMAIN).trim();
  const runtimePidPath = path.resolve(directNginxPidPath);
  const accessLogPath = path.resolve(directNginxAccessLogPath);
  const errorLogPath = path.resolve(directNginxErrorLogPath);
  const proxyHeaders = [
    "proxy_http_version 1.1;",
    "proxy_set_header Upgrade $http_upgrade;",
    "proxy_set_header Connection $connection_upgrade;",
    "proxy_set_header Host $host;",
    "proxy_set_header X-Real-IP $remote_addr;",
    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "proxy_connect_timeout 10s;",
    "proxy_read_timeout 86400s;",
    "proxy_send_timeout 86400s;",
    "proxy_buffering off;",
    "proxy_request_buffering off;",
    "proxy_socket_keepalive on;"
  ];
  const lines = [
    "worker_processes auto;",
    "worker_rlimit_nofile 65535;",
    "pid " + nginxConfigValue(runtimePidPath) + ";",
    "error_log " + nginxConfigValue(errorLogPath) + " " + NGINX_LOG_LEVEL + ";",
    "events {",
    "  worker_connections 4096;",
    "}",
    "http {",
    "  include /etc/nginx/mime.types;",
    "  default_type application/octet-stream;",
    "  sendfile on;",
    "  tcp_nodelay on;",
    "  keepalive_timeout 65s;",
    "  map $http_upgrade $connection_upgrade {",
    "    default upgrade;",
    "    '' close;",
    "  }",
    DIRECT_NGINX_ACCESS_LOG_ENABLED
      ? "  access_log " + nginxConfigValue(accessLogPath) + " combined;"
      : "  access_log off;",
    "",
    "  server {",
    "    listen " + DIRECT_PORT + ";",
    "    server_name " + domain + ";",
    "",
    "    location = /vless-argo {",
    "      proxy_pass http://127.0.0.1:3002;",
    ...proxyHeaders.map((line) => "      " + line),
    "    }",
    "",
    "    location = /vmess-argo {",
    "      proxy_pass http://127.0.0.1:3003;",
    ...proxyHeaders.map((line) => "      " + line),
    "    }",
    "",
    "    location = /trojan-argo {",
    "      proxy_pass http://127.0.0.1:3004;",
    ...proxyHeaders.map((line) => "      " + line),
    "    }",
    "",
    "    location / {",
    "      proxy_pass http://127.0.0.1:3000;",
    ...proxyHeaders.map((line) => "      " + line),
    "    }",
    "  }",
    "}"
  ];
  return lines.join("\n") + "\n";
}

function buildDirectNginxConfig({ certificateFile = "", keyFile = "", httpOnly = false, tlsEnabled = DIRECT_TLS_ENABLED } = {}) {
  if (!httpOnly && !tlsEnabled) {
    return buildDirectHttpOnlyNginxConfig();
  }
  const domain = String(ARGO_DOMAIN).trim();
  const runtimePidPath = path.resolve(directNginxPidPath);
  const runtimeAcmePath = path.resolve(directAcmePath);
  const accessLogPath = path.resolve(directNginxAccessLogPath);
  const errorLogPath = path.resolve(directNginxErrorLogPath);
  const httpsPortSuffix = DIRECT_PORT === 443 ? "" : `:${DIRECT_PORT}`;
  const proxyHeaders = [
    "proxy_http_version 1.1;",
    "proxy_set_header Upgrade $http_upgrade;",
    "proxy_set_header Connection $connection_upgrade;",
    "proxy_set_header Host $host;",
    "proxy_set_header X-Real-IP $remote_addr;",
    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "proxy_connect_timeout 10s;",
    "proxy_read_timeout 86400s;",
    "proxy_send_timeout 86400s;",
    "proxy_buffering off;",
    "proxy_request_buffering off;",
    "proxy_socket_keepalive on;"
  ];

  const lines = [
    "worker_processes auto;",
    "worker_rlimit_nofile 65535;",
    `pid ${nginxConfigValue(runtimePidPath)};`,
    `error_log ${nginxConfigValue(errorLogPath)} ${NGINX_LOG_LEVEL};`,
    "events {",
    "  worker_connections 4096;",
    "}",
    "http {",
    "  include /etc/nginx/mime.types;",
    "  default_type application/octet-stream;",
    "  sendfile on;",
    "  tcp_nodelay on;",
    "  keepalive_timeout 65s;",
    "  map $http_upgrade $connection_upgrade {",
    "    default upgrade;",
    "    '' close;",
    "  }",
    DIRECT_NGINX_ACCESS_LOG_ENABLED
      ? `  access_log ${nginxConfigValue(accessLogPath)} combined;`
      : "  access_log off;",
    "",
    "  server {",
    `    listen ${DIRECT_HTTP_PORT};`,
    `    server_name ${domain};`,
    "",
    "    location ^~ /.well-known/acme-challenge/ {",
    `      root ${nginxConfigValue(runtimeAcmePath)};`,
    "      try_files $uri =404;",
    "    }",
    "",
    "    location / {",
    `      return 301 https://$host${httpsPortSuffix}$request_uri;`,
    "    }",
    "  }"
  ];

  if (!httpOnly) {
    lines.push(
      "",
      "  server {",
      `    listen ${DIRECT_PORT} ssl;`,
      `    server_name ${domain};`,
      `    ssl_certificate ${nginxConfigValue(path.resolve(certificateFile))};`,
      `    ssl_certificate_key ${nginxConfigValue(path.resolve(keyFile))};`,
      "    ssl_protocols TLSv1.2 TLSv1.3;",
      "    ssl_session_cache shared:SSL:10m;",
      "    ssl_session_timeout 10m;",
      "",
      "    location = /vless-argo {",
      "      proxy_pass http://127.0.0.1:3002;",
      ...proxyHeaders.map((line) => `      ${line}`),
      "    }",
      "",
      "    location = /vmess-argo {",
      "      proxy_pass http://127.0.0.1:3003;",
      ...proxyHeaders.map((line) => `      ${line}`),
      "    }",
      "",
      "    location = /trojan-argo {",
      "      proxy_pass http://127.0.0.1:3004;",
      ...proxyHeaders.map((line) => `      ${line}`),
      "    }",
      "",
      "    location / {",
      "      proxy_pass http://127.0.0.1:3000;",
      ...proxyHeaders.map((line) => `      ${line}`),
      "    }",
      "  }"
    );
  }

  lines.push("}", "");
  return lines.join("\n");
}

function writeDirectNginxConfig(options = {}) {
  fs.mkdirSync(directAcmePath, { recursive: true });
  fs.writeFileSync(directNginxConfigPath, buildDirectNginxConfig(options));
}

async function stopDirectNginx() {
  try {
    await exec(`${shellQuote(NGINX_BIN)} -c ${shellQuote(path.resolve(directNginxConfigPath))} -s stop`);
  } catch {
    // 证书申请前可能还没有 Nginx 进程，忽略停止失败。
  }
}

async function startNginx() {
  const config = path.resolve(directNginxConfigPath);
  await exec(`${shellQuote(NGINX_BIN)} -t -c ${shellQuote(config)}`);
  await exec(`nohup ${shellQuote(NGINX_BIN)} -c ${shellQuote(config)} >>${shellQuote(nginxBootLogPath)} 2>&1 &`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function ensureDirectCertificate() {
  const certificate = getDirectCertificatePaths();
  const certificateExists = fs.existsSync(certificate.certificateFile);
  const keyExists = fs.existsSync(certificate.keyFile);

  if (certificateExists && keyExists) {
    return certificate;
  }

  if (DIRECT_CERT_FILE || DIRECT_KEY_FILE) {
    throw new Error(`直连模式证书文件不存在：${certificate.certificateFile} 或 ${certificate.keyFile}`);
  }

  if (!DIRECT_LETSENCRYPT_EMAIL) {
    throw new Error("直连模式需要证书：请配置 DIRECT_CERT_FILE/DIRECT_KEY_FILE，或配置 DIRECT_LETSENCRYPT_EMAIL 自动申请 Let's Encrypt 证书");
  }

  writeDirectNginxConfig({ httpOnly: true });
  await startNginx();
  try {
    const webroot = path.resolve(directAcmePath);
    const certbotArgs = [
      "certonly",
      "--webroot",
      "--webroot-path",
      webroot,
      "--config-dir",
      path.join(FILE_PATH, "letsencrypt"),
      "--work-dir",
      path.join(FILE_PATH, "letsencrypt-work"),
      "--logs-dir",
      path.join(FILE_PATH, "letsencrypt-logs"),
      "--domain",
      ARGO_DOMAIN,
      "--email",
      DIRECT_LETSENCRYPT_EMAIL,
      "--agree-tos",
      "--non-interactive",
      "--keep-until-expiring",
      "--no-eff-email"
    ].map(shellQuote).join(" ");
    await exec(`${shellQuote(CERTBOT_BIN)} ${certbotArgs}`);
  } finally {
    await stopDirectNginx();
  }

  if (!fs.existsSync(certificate.certificateFile) || !fs.existsSync(certificate.keyFile)) {
    throw new Error(`Let's Encrypt 申请完成后仍未找到证书：${certificate.certificateFile}`);
  }

  return certificate;
}

function startDirectCertificateRenewal() {
  if (directCertificateRenewalTimer || !DIRECT_LETSENCRYPT_EMAIL || DIRECT_CERT_FILE || DIRECT_KEY_FILE) {
    return;
  }

  directCertificateRenewalTimer = setInterval(async () => {
    try {
      await exec(
        `${shellQuote(CERTBOT_BIN)} renew --quiet`
        + ` --config-dir ${shellQuote(path.join(FILE_PATH, "letsencrypt"))}`
        + ` --work-dir ${shellQuote(path.join(FILE_PATH, "letsencrypt-work"))}`
        + ` --logs-dir ${shellQuote(path.join(FILE_PATH, "letsencrypt-logs"))}`
      );
      await exec(`${shellQuote(NGINX_BIN)} -c ${shellQuote(path.resolve(directNginxConfigPath))} -s reload`);
      console.log("直连模式证书续期检查完成，Nginx 已重新加载");
    } catch (error) {
      console.error(`直连模式证书续期失败：${error.message}`);
    }
  }, 12 * 60 * 60 * 1000);

  if (typeof directCertificateRenewalTimer.unref === "function") {
    directCertificateRenewalTimer.unref();
  }
}

function getCloudflareApiClient() {
  return axios.create({
    baseURL: "https://api.cloudflare.com/client/v4",
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

function getCloudflareZoneName() {
  if (CF_DNS_ZONE_NAME) return CF_DNS_ZONE_NAME;

  const labels = String(ARGO_DOMAIN).trim().split(".").filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join(".") : "";
}

async function resolveCloudflareZoneId(client) {
  if (CF_DNS_ZONE_ID) return CF_DNS_ZONE_ID;

  const zoneName = getCloudflareZoneName();
  if (!zoneName) {
    throw new Error("无法从 ARGO_DOMAIN 推断 Cloudflare Zone，请配置 CF_DNS_ZONE_NAME 或 CF_DNS_ZONE_ID");
  }

  const response = await client.get("/zones", {
    params: { name: zoneName, status: "active", per_page: 1 }
  });
  const zones = response.data && response.data.result;
  if (!response.data || !response.data.success || !Array.isArray(zones) || zones.length === 0) {
    throw new Error(`Cloudflare Zone 不存在或 API Token 没有 Zone:Read 权限：${zoneName}`);
  }

  return zones[0].id;
}

async function resolvePublicIpv4() {
  if (CF_DNS_PUBLIC_IP) return CF_DNS_PUBLIC_IP.trim();

  const response = await axios.get("https://api.ipify.org?format=json", { timeout: 8000 });
  const publicIp = response.data && response.data.ip;
  if (!publicIp || net.isIP(publicIp) !== 4) {
    throw new Error("公网 IP 查询结果不是有效的 IPv4 地址，请配置 CF_DNS_PUBLIC_IP");
  }

  return String(publicIp).trim();
}

async function syncCloudflareDnsRecord() {
  if (!DIRECT_MODE || !CF_DNS_ENABLED || !CF_API_TOKEN) {
    if (DIRECT_MODE && CF_DNS_ENABLED && !CF_API_TOKEN) {
      console.log("未配置 CF_API_TOKEN，跳过 Cloudflare DNS 自动解析；请确认 ARGO_DOMAIN 已指向本机公网 IP");
    }
    return;
  }

  if (
    !CF_DNS_RECORD_NAME ||
    !Number.isInteger(CF_DNS_TTL) ||
    CF_DNS_TTL < 1 ||
    CF_DNS_TTL > 86400
  ) {
    throw new Error("CF_DNS_RECORD_NAME 不能为空，CF_DNS_TTL 必须是有效的 TTL 秒数");
  }

  const client = getCloudflareApiClient();
  const zoneId = await resolveCloudflareZoneId(client);
  const publicIp = await resolvePublicIpv4();
  if (net.isIP(publicIp) !== 4) {
    throw new Error(`CF_DNS_PUBLIC_IP 不是有效的 IPv4 地址：${publicIp}`);
  }

  const listResponse = await client.get(`/zones/${zoneId}/dns_records`, {
    params: { name: CF_DNS_RECORD_NAME, per_page: 100 }
  });
  if (!listResponse.data || !listResponse.data.success) {
    throw new Error("Cloudflare DNS 记录查询失败，请检查 API Token 权限");
  }

  const records = Array.isArray(listResponse.data.result) ? listResponse.data.result : [];
  const current = records.find((record) => record.type === "A");
  const conflictingRecord = records.find((record) => record.type !== "A");
  if (!current && conflictingRecord) {
    if (conflictingRecord.type !== "CNAME" || !CF_DNS_REPLACE_CNAME) {
      throw new Error(`Cloudflare DNS 中已存在 ${CF_DNS_RECORD_NAME} 的 ${conflictingRecord.type} 记录，请先处理冲突后再启用自动解析`);
    }

    const deleteResponse = await client.delete(`/zones/${zoneId}/dns_records/${conflictingRecord.id}`);
    if (!deleteResponse.data || !deleteResponse.data.success) {
      throw new Error(`Cloudflare DNS CNAME 删除失败：${CF_DNS_RECORD_NAME}`);
    }
    console.log(`Cloudflare Tunnel CNAME 已移除，准备切换为直连 A 记录：${CF_DNS_RECORD_NAME}`);
  }
  const desired = {
    type: "A",
    name: CF_DNS_RECORD_NAME,
    content: publicIp,
    ttl: Number.isInteger(CF_DNS_TTL) && CF_DNS_TTL >= 1 ? CF_DNS_TTL : 120,
    proxied: false
  };

  if (
    current &&
    current.content === desired.content &&
    current.proxied === desired.proxied &&
    current.ttl === desired.ttl
  ) {
    console.log(`Cloudflare DNS 已是最新：${CF_DNS_RECORD_NAME} -> ${publicIp}（DNS-only）`);
    return;
  }

  if (current) {
    const updateResponse = await client.put(`/zones/${zoneId}/dns_records/${current.id}`, {
      ...desired
    });
    if (!updateResponse.data || !updateResponse.data.success) {
      throw new Error("Cloudflare DNS 记录更新失败");
    }
    console.log(`Cloudflare DNS 已更新：${CF_DNS_RECORD_NAME} -> ${publicIp}（DNS-only）`);
    return;
  }

  const createResponse = await client.post(`/zones/${zoneId}/dns_records`, {
    ...desired
  });
  if (!createResponse.data || !createResponse.data.success) {
    throw new Error("Cloudflare DNS 记录创建失败");
  }
  console.log(`Cloudflare DNS 已创建：${CF_DNS_RECORD_NAME} -> ${publicIp}（DNS-only）`);
}

function startCloudflareDnsSyncLoop() {
  if (cloudflareDnsSyncTimer || !DIRECT_MODE || !CF_DNS_ENABLED || !CF_API_TOKEN) {
    return;
  }

  const interval = Number.isInteger(CF_DNS_SYNC_INTERVAL_MS) && CF_DNS_SYNC_INTERVAL_MS >= 60000
    ? CF_DNS_SYNC_INTERVAL_MS
    : 300000;

  cloudflareDnsSyncTimer = setInterval(() => {
    syncCloudflareDnsRecord().catch((error) => {
      console.error(`Cloudflare DNS 自动解析检查失败：${error.message}`);
    });
  }, interval);

  if (typeof cloudflareDnsSyncTimer.unref === "function") {
    cloudflareDnsSyncTimer.unref();
  }
}

async function startDirectGateway() {
  validateDirectMode();
  await stopDirectNginx();
  if (!DIRECT_TLS_ENABLED) {
    writeDirectNginxConfig({ tlsEnabled: false });
    await startNginx();
    console.log(`直连 HTTP 模式已启动：${ARGO_DOMAIN}:${DIRECT_PORT}`);
    return;
  }
  const certificate = await ensureDirectCertificate();
  writeDirectNginxConfig(certificate);
  await startNginx();
  startDirectCertificateRenewal();
}

function writeArgoGatewayResponse(socket, statusCode, message) {
  if (!socket || socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
    body
  );
}

function proxyArgoWebSocket(req, socket, head) {
  let pathname = "/";
  try {
    pathname = new URL(req.url || "/", "http://127.0.0.1").pathname.replace(/\/$/, "") || "/";
  } catch {
    writeArgoGatewayResponse(socket, 400, "Bad Request");
    return;
  }

  const targetPort = ARGO_WS_TARGETS[pathname];
  if (!targetPort) {
    writeArgoGatewayResponse(socket, 404, "WebSocket path not found");
    return;
  }

  const upstream = net.createConnection({ host: "127.0.0.1", port: targetPort });
  let connected = false;
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) socket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };

  upstream.setTimeout(10000, () => {
    if (!connected) writeArgoGatewayResponse(socket, 502, "Xray upstream timeout");
    closeBoth();
  });

  upstream.once("connect", () => {
    connected = true;
    const requestLines = [
      `${req.method || "GET"} ${req.url || pathname} HTTP/${req.httpVersion || "1.1"}`
    ];
    Object.entries(req.headers || {}).forEach(([name, value]) => {
      if (Array.isArray(value)) {
        value.forEach((item) => requestLines.push(`${name}: ${item}`));
      } else if (value !== undefined) {
        requestLines.push(`${name}: ${value}`);
      }
    });
    requestLines.push("", "");
    upstream.write(requestLines.join("\r\n"));
    if (head && head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", (error) => {
    if (!connected) {
      console.error(`ARGO WebSocket 上游连接失败（${pathname} -> ${targetPort}）：${error.message}`);
      writeArgoGatewayResponse(socket, 502, "Xray upstream unavailable");
    }
    closeBoth();
  });
  upstream.on("close", () => {
    if (!socket.destroyed) socket.end();
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
}

function startHttpServer() {
  if (appServer) return appServer;
  appServer = http.createServer(app);
  appServer.listen(PORT, () => console.log(`HTTP 服务已运行，端口：${PORT}`));
  return appServer;
}

function startArgoGateway() {
  if (DIRECT_MODE || argoGatewayServer) return Promise.resolve();

  const gatewayPort = Number.parseInt(String(ARGO_PORT), 10);
  const appPort = Number.parseInt(String(PORT), 10);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
    throw new Error(`ARGO_PORT 无效：${ARGO_PORT}`);
  }

  if (gatewayPort === appPort) {
    const server = startHttpServer();
    server.on("upgrade", proxyArgoWebSocket);
    argoGatewayServer = server;
    console.log(`ARGO 网关复用 HTTP 端口：${ARGO_GATEWAY_HOST}:${gatewayPort}`);
    return Promise.resolve();
  }

  const server = http.createServer(app);
  server.on("upgrade", proxyArgoWebSocket);
  argoGatewayServer = server;
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      argoGatewayServer = null;
      reject(error);
    };
    server.once("error", onError);
    server.listen(gatewayPort, ARGO_GATEWAY_HOST, () => {
      server.off("error", onError);
      console.log(`ARGO 网关已启动：${ARGO_GATEWAY_HOST}:${gatewayPort}（HTTP/WebSocket 分流）`);
      resolve();
    });
  });
}

// 根据认证方式生成 cloudflared 启动参数
function getCloudflaredProtocol() {
  const protocol = String(CLOUDFLARED_PROTOCOL || "").trim().toLowerCase();
  return ["auto", "quic", "http2"].includes(protocol) ? protocol : "http2";
}

function buildCloudflaredArgs() {
  if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
    return `tunnel --edge-ip-version auto --autoupdate-freq 24h --protocol ${getCloudflaredProtocol()} --logfile ${shellQuote(cloudflaredLogPath)} --loglevel ${shellQuote(CLOUDFLARED_LOG_LEVEL)} run --token ${shellQuote(ARGO_AUTH)}`;
  }

  if (ARGO_AUTH.match(/TunnelSecret/)) {
    return `tunnel --edge-ip-version auto --autoupdate-freq 24h --config ${shellQuote(tunnelYamlPath)} --logfile ${shellQuote(cloudflaredLogPath)} --loglevel ${shellQuote(CLOUDFLARED_LOG_LEVEL)} run`;
  }

  return `tunnel --edge-ip-version auto --autoupdate-freq 24h --protocol ${getCloudflaredProtocol()} --logfile ${shellQuote(bootLogPath)} --loglevel info --url ${shellQuote(`http://${ARGO_GATEWAY_HOST}:${ARGO_PORT}`)}`;
}

function backgroundPidFromOutput(stdout) {
  const candidates = String(stdout || "").trim().split(/\s+/).reverse();
  const pid = candidates.find((value) => /^[0-9]+$/.test(value));
  return pid ? Number.parseInt(pid, 10) : null;
}

function stopProcessByPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The child may have already exited or been reaped by the supervisor.
  }
}

function removeCloudflaredRuntimeArtifacts() {
  for (const filePath of [tunnelJsonPath, tunnelYamlPath]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
      console.warn(`清理 Cloudflare Tunnel 配置失败：${filePath}；${error.message}`);
    }
  }
}

async function stopArgoGateway() {
  if (!argoGatewayServer || argoGatewayServer === appServer) {
    argoGatewayServer = null;
    return;
  }

  const server = argoGatewayServer;
  argoGatewayServer = null;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    setTimeout(finish, 1000).unref?.();
  });
}

async function stopRuntimeProcesses() {
  stopProcessByPid(cloudflaredProcessId);
  stopProcessByPid(xrayProcessId);
  cloudflaredProcessId = null;
  xrayProcessId = null;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function noRouteError(message) {
  const error = new Error(message);
  error.code = "NO_ROUTE_DETECTED";
  return error;
}

async function stopForNoRoute(message) {
  console.error(`Tunnel 和直连均未探测到可用路线，程序停止：${message}`);
  try {
    appendRouteProbeProgress(`公网路线失败并停止：${message}`);
    fs.writeFileSync(noRouteMarkerPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
    fs.rmSync(routeReadyMarkerPath, { force: true });
  } catch (error) {
    console.error(`无法写入无路线标记：${error.message}`);
  }
  await shutdownTeamNodeSync("no_route_detected");
  await stopRuntimeProcesses();
  await stopArgoGateway();
  removeCloudflaredRuntimeArtifacts();
  process.exit(NO_ROUTE_EXIT_CODE);
}

// 启动 Xray、cloudflared
async function startProcesses() {
  const shouldStartCloudflared = !DIRECT_MODE && !PLATFORM_PROXY_MODE && !TUNNEL_PREFLIGHT_BLOCKED;
  try {
    ensureBinaryExists(webPath, "xray");
    if (shouldStartCloudflared) {
      ensureBinaryExists(botPath, "cloudflared");
    }
    authorizeFiles(shouldStartCloudflared ? [webPath, botPath] : [webPath]);
  } catch (error) {
    console.error(`二进制检查失败：${error.message}`);
    throw error;
  }

  try {
    const xrayResult = await exec(`nohup ${shellQuote(webPath)} -c ${shellQuote(configPath)} >>${shellQuote(xrayBootLogPath)} 2>&1 & echo $!`);
    xrayProcessId = backgroundPidFromOutput(xrayResult.stdout);
    console.log(`${webName} 已启动`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(`Xray 启动失败：${error}`);
  }

  if (!DIRECT_MODE) {
    try {
      await startArgoGateway();
    } catch (error) {
      console.error(`ARGO 网关启动失败：${error.message}`);
      throw error;
    }
  }

  if (DIRECT_MODE) {
    try {
      await startDirectGateway();
      console.log(`直连模式已启动：${ARGO_DOMAIN}:${DIRECT_PORT}，HTTP ${DIRECT_HTTP_PORT} 用于证书验证和跳转`);
    } catch (error) {
      console.error(`直连网关启动失败：${error.message}`);
      throw error;
    }
  } else if (PLATFORM_PROXY_MODE) {
    console.log(`平台代理模式已启动：容器入口 ${ARGO_PORT}，公网 HTTPS 端口 ${PLATFORM_PUBLIC_PORT}`);
    console.log("平台应将 HTTPS/HTTP WebSocket 请求转发到容器的 ARGO_PORT；容器不申请、不校验证书");
  } else if (TUNNEL_PREFLIGHT_BLOCKED) {
    console.log("阶段 1 已确认 Tunnel 7844 被阻断，cloudflared 未启动");
  } else {
    try {
      const args = buildCloudflaredArgs();
      const cloudflaredResult = await exec(`nohup ${shellQuote(botPath)} ${args} >>${shellQuote(cloudflaredBootLogPath)} 2>&1 & echo $!`);
      cloudflaredProcessId = backgroundPidFromOutput(cloudflaredResult.stdout);
      console.log(`${botName} 已启动`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`cloudflared 启动失败：${error}`);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
}

// 生成固定隧道配置文件
function argoType() {
  if (DIRECT_MODE || PLATFORM_PROXY_MODE || TUNNEL_PREFLIGHT_BLOCKED) {
    if (PLATFORM_PROXY_MODE) {
      console.log("PLATFORM_PROXY_MODE 已启用，不启动 Cloudflare Tunnel");
      return;
    }
    if (TUNNEL_PREFLIGHT_BLOCKED && !DIRECT_MODE) {
      console.log("阶段 1 已确认 Tunnel 7844 被阻断，不生成 Cloudflare Tunnel 配置");
      return;
    }
    console.log("DIRECT_MODE 已启用，不启动 Cloudflare Tunnel");
    return;
  }

  if (!ARGO_AUTH || !ARGO_DOMAIN) {
    console.log("ARGO_DOMAIN 或 ARGO_AUTH 为空，将使用临时隧道");
    return;
  }

  if (ARGO_AUTH.includes("TunnelSecret")) {
    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH);
    const tunnelYaml = `
  tunnel: ${ARGO_AUTH.split('"')[11]}
  credentials-file: ${tunnelJsonPath}
  protocol: ${getCloudflaredProtocol()}
  
  ingress:
    - hostname: ${ARGO_DOMAIN}
      service: http://${ARGO_GATEWAY_HOST}:${ARGO_PORT}
      originRequest:
        noTLSVerify: true
    - service: http_status:404
  `;
    fs.writeFileSync(tunnelYamlPath, tunnelYaml);
  } else {
    console.log("ARGO_AUTH 不是 TunnelSecret JSON，将使用 token 方式连接隧道");
  }
}

// 从日志中提取临时隧道域名
async function extractDomains() {
  let argoDomain;

  if (DIRECT_MODE || PLATFORM_PROXY_MODE) {
    argoDomain = ARGO_DOMAIN;
    console.log(PLATFORM_PROXY_MODE ? "平台代理域名:" : "直连域名:", argoDomain);
    await generateLinks(argoDomain);
    return;
  }

  if (ARGO_AUTH && ARGO_DOMAIN) {
    argoDomain = ARGO_DOMAIN;
    console.log("ARGO_DOMAIN:", argoDomain);
    await generateLinks(argoDomain);
    return;
  }

  try {
    const fileContent = fs.readFileSync(bootLogPath, "utf-8");
    const lines = fileContent.split("\n");
    const argoDomains = [];

    lines.forEach((line) => {
      const domainMatch = line.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
      if (domainMatch) {
        argoDomains.push(domainMatch[1]);
      }
    });

    if (argoDomains.length > 0) {
      argoDomain = argoDomains[0];
      console.log("ArgoDomain:", argoDomain);
      await generateLinks(argoDomain);
      return;
    }

    console.log("未找到 ArgoDomain，重新启动 cloudflared 获取域名");
    fs.unlinkSync(bootLogPath);

    async function killBotProcess() {
      try {
        if (process.platform === "win32") {
          await exec(`taskkill /f /im ${botName}.exe > nul 2>&1`);
        } else {
          await exec(`pkill -f "[${botName.charAt(0)}]${botName.substring(1)}" > /dev/null 2>&1`);
        }
      } catch {
        return null;
      }
      return null;
    }

    await killBotProcess();
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      const args = buildCloudflaredArgs();
          await exec(`nohup ${shellQuote(botPath)} ${args} >>${shellQuote(cloudflaredBootLogPath)} 2>&1 &`);
      console.log(`${botName} 已重新启动`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await extractDomains();
    } catch (error) {
      console.error(`重新启动 cloudflared 失败：${error}`);
    }
  } catch (error) {
    console.error("读取 boot.log 失败:", error);
  }
}

// 获取当前机器的 ISP 信息，用于节点命名
async function getMetaInfo() {
  try {
    const response1 = await axios.get("https://api.ip.sb/geoip", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 3000
    });

    if (response1.data && response1.data.country_code && response1.data.isp) {
      return {
        countryCode: String(response1.data.country_code || "").trim() || "Unknown",
        countryName: String(response1.data.country || "").trim() || null,
        ispName: String(response1.data.isp || "").trim() || "Unknown",
        timezone: String(response1.data.timezone || "").trim() || null,
        display: `${response1.data.country_code}-${response1.data.isp}`.replace(/\s+/g, "_")
      };
    }
  } catch {
    try {
      const response2 = await axios.get("http://ip-api.com/json", {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 3000
      });

      if (response2.data && response2.data.status === "success" && response2.data.countryCode && response2.data.org) {
        return {
          countryCode: String(response2.data.countryCode || "").trim() || "Unknown",
          countryName: String(response2.data.country || "").trim() || null,
          ispName: String(response2.data.org || "").trim() || "Unknown",
          timezone: String(response2.data.timezone || "").trim() || null,
          display: `${response2.data.countryCode}-${response2.data.org}`.replace(/\s+/g, "_")
        };
      }
    } catch {
      return {
        countryCode: "Unknown",
        countryName: null,
        ispName: "Unknown",
        timezone: null,
        display: "Unknown"
      };
    }
  }

  return {
    countryCode: "Unknown",
    countryName: null,
    ispName: "Unknown",
    timezone: null,
    display: "Unknown"
  };
}

// 生成 list 和 sub 订阅内容
async function generateLinks(argoDomain) {
  const metaInfo = await getMetaInfo();
  const ipRiskInfo = await resolveNodeIpRiskInfo();
  const ipRiskSuffix = buildIpRiskNodeSuffix(ipRiskInfo);
  const baseNodeName = buildDefaultNodeName(metaInfo);
  const nodeName = ipRiskSuffix ? `${baseNodeName}-${ipRiskSuffix}` : baseNodeName;
  const nodeAddress = DIRECT_MODE || PLATFORM_PROXY_MODE ? ARGO_DOMAIN : CFIP;
  const nodePort = DIRECT_MODE ? DIRECT_PORT : PLATFORM_PROXY_MODE ? PLATFORM_PUBLIC_PORT : CFPORT;
  const linkTlsEnabled = !DIRECT_MODE || PLATFORM_PROXY_MODE || DIRECT_TLS_ENABLED;

  return new Promise((resolve) => {
    setTimeout(() => {
      const VMESS = {
        v: "2",
        ps: `${nodeName}`,
        add: nodeAddress,
        port: nodePort,
        id: UUID,
        aid: "0",
        scy: "auto",
        net: "ws",
        type: "none",
        host: argoDomain,
        path: "/vmess-argo?ed=2560",
        tls: linkTlsEnabled ? "tls" : "",
        sni: linkTlsEnabled ? argoDomain : "",
        alpn: "",
        fp: "firefox"
      };

      const protocolNodes = [
        linkTlsEnabled
          ? `vless://${UUID}@${nodeAddress}:${nodePort}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}`
          : `vless://${UUID}@${nodeAddress}:${nodePort}?encryption=none&security=none&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}`,
        `vmess://${Buffer.from(JSON.stringify(VMESS)).toString("base64")}`,
        linkTlsEnabled
          ? `trojan://${UUID}@${nodeAddress}:${nodePort}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}`
          : `trojan://${UUID}@${nodeAddress}:${nodePort}?security=none&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}`
      ];
      const subTxt = `\n${protocolNodes.join("\n\n")}\n`;
      console.log("已生成 3 种协议节点：VLESS、VMess、Trojan");

      const contentBase64 = Buffer.from(subTxt).toString("base64");
      console.log(contentBase64);
      fs.writeFileSync(subPath, contentBase64);
      console.log(`${FILE_PATH}/sub.txt 保存成功`);
      uploadNodes();
      syncNodeToTeamNode({
        argoDomain,
        nodeName,
        meta: metaInfo,
        ipRisk: ipRiskInfo,
        contentBase64
      }).finally(() => {
        startTeamNodeHeartbeatLoop({
          argoDomain,
          nodeName,
          meta: metaInfo,
          ipRisk: ipRiskInfo,
          contentBase64
        });
      });

      resolve(subTxt);
    }, 2000);
  });
}

// 自动上传节点或订阅
async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    const subscriptionUrl = `${PROJECT_URL}/${SUB_PATH}`;
    const jsonData = {
      subscription: [subscriptionUrl]
    };

    try {
      const response = await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, jsonData, {
        headers: {
          "Content-Type": "application/json"
        }
      });

      if (response && response.status === 200) {
        console.log("订阅上传成功");
        return response;
      }

      return null;
    } catch (error) {
      if (error.response && error.response.status === 400) {
        return null;
      }
    }
  } else if (UPLOAD_URL) {
    if (!fs.existsSync(listPath)) return;

    const content = fs.readFileSync(listPath, "utf-8");
    const nodes = content.split("\n").filter((line) => /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line));
    if (nodes.length === 0) return;

    const jsonData = JSON.stringify({ nodes });

    try {
      const response = await axios.post(`${UPLOAD_URL}/api/add-nodes`, jsonData, {
        headers: { "Content-Type": "application/json" }
      });

      if (response && response.status === 200) {
        console.log("节点上传成功");
        return response;
      }

      return null;
    } catch {
      return null;
    }
  }

  return null;
}

// 延迟清理临时日志文件
function cleanFiles() {
  setTimeout(() => {
    try {
      if (fs.existsSync(bootLogPath)) {
        fs.unlinkSync(bootLogPath);
      }
    } catch {
      return null;
    }

    console.clear();
    console.log("应用已运行");
    console.log("感谢使用，祝你使用愉快！");
    return null;
  }, 90000);
}
cleanFiles();

// 自动添加项目保活任务
async function AddVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    console.log("跳过自动保活任务");
    return;
  }

  try {
    const response = await axios.post(
      "https://oooo.serv00.net/add-url",
      { url: PROJECT_URL },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log("自动保活任务添加成功");
    return response;
  } catch (error) {
    console.error(`自动保活任务添加失败：${error.message}`);
    return null;
  }
}

// 主启动流程
async function startserver() {
  try {
    console.log(`启动配置：ARGO_DOMAIN=${ARGO_DOMAIN || "(empty)"}，ARGO_PORT=${ARGO_PORT}，SERVER_PORT=${PORT}`);
    const teamNodeMode = TEAMNODE_SYNC_SECRET ? "直连" : TEAMNODE_SYNC_RELAY_TOKEN ? "Worker 代理" : "未配置";
    console.log(`Cloudflare Tunnel：${ARGO_AUTH ? "已配置认证" : "临时隧道"}；TeamNode：${TEAMNODE_SYNC_ENABLED ? "已启用" : "未启用"}，模式=${teamNodeMode}，心跳间隔 ${TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS}ms`);
    validateDirectMode();
    validatePlatformProxyMode();
    validateCloudflareDnsMode();
    if (await prepareDirectModeStartup()) return;
    await syncCloudflareDnsRecord();
    startCloudflareDnsSyncLoop();
    deleteNodes();
    cleanupOldFiles();
    argoType();
    await generateConfig();
    await startProcesses();
    if (await prepareTunnelStartup()) return;
    if (DIRECT_MODE) {
      await verifyPublicRouteAtStartup();
    }
    markRouteReady();
    await extractDomains();
    await AddVisitTask();
  } catch (error) {
    if (error?.code === "NO_ROUTE_DETECTED") {
      await stopForNoRoute(error.message);
      return;
    }
    console.error("startserver 执行失败:", error);
  }
}

function handleProcessShutdownSignal(signal) {
  if (processShutdownRequested) {
    return;
  }

  processShutdownRequested = true;
  shutdownTeamNodeSync(`signal_${String(signal || "shutdown").toLowerCase()}`)
    .catch(() => null)
    .then(() => stopRuntimeProcesses())
    .then(() => DIRECT_MODE ? stopDirectNginx().catch(() => null) : null)
    .finally(() => {
      process.exit(0);
    });
}

process.on("SIGINT", () => {
  handleProcessShutdownSignal("SIGINT");
});

process.on("SIGTERM", () => {
  handleProcessShutdownSignal("SIGTERM");
});

if (require.main === module) {
  startserver().catch((error) => {
    console.error("startserver 未捕获异常:", error);
  });
}

module.exports = {
  createTeamNodeSyncHeaders,
  resolveCountryLabel,
  resolveTeamNodeProvider,
  buildDefaultNodeName,
  buildTeamNodePayload,
  syncNodeToTeamNode,
  syncNodeRegistrationToTeamNode,
  syncNodeHeartbeatToTeamNode,
  syncNodeOfflineToTeamNode,
  shutdownTeamNodeSync,
  startTeamNodeHeartbeatLoop,
  stopTeamNodeHeartbeatLoop,
  getMetaInfo
};

// 根路由
app.get("/", async function(req, res) {
  try {
    const filePath = path.join(__dirname, "index.html");
    const data = await fs.promises.readFile(filePath, "utf8");
    res.send(data);
  } catch {
    res.send("Hello world!");
  }
});

if (require.main === module) {
  startHttpServer();
}
