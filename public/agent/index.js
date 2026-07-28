const express = require("express");
const app = express();
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
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
const NGINX_LOG_LEVEL = process.env.NGINX_LOG_LEVEL || "warn";
const DIRECT_NGINX_ACCESS_LOG_ENABLED = parseBoolean(process.env.DIRECT_NGINX_ACCESS_LOG_ENABLED, false);
const UUID = process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913"; // 用户 UUID
const NEZHA_SERVER = process.env.NEZHA_SERVER || ""; // 哪吒 v1 格式：nz.abc.com:8008；v0 格式：nz.abc.com
const NEZHA_PORT = process.env.NEZHA_PORT || ""; // 使用哪吒 v1 时留空，使用 v0 时填写
const NEZHA_KEY = process.env.NEZHA_KEY || ""; // 哪吒 v1 的 NZ_CLIENT_SECRET 或 v0 的 agent 密钥
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || (PLATFORM_PROXY_MODE ? PLATFORM_PUBLIC_DOMAIN : ""); // 平台模式可由平台域名环境变量自动提供
const ARGO_AUTH = process.env.ARGO_AUTH || ""; // 固定隧道密钥 JSON 或 token，留空则启用临时隧道
const ARGO_PORT = process.env.ARGO_PORT || 8001; // 固定隧道端口，使用 token 时需和 Cloudflare 后台一致
const DIRECT_MODE = parseBoolean(process.env.DIRECT_MODE, false);
const PLATFORM_PUBLIC_PORT = Number.parseInt(process.env.PLATFORM_PUBLIC_PORT || "443", 10);
const DIRECT_PORT = Number.parseInt(process.env.DIRECT_PORT || "443", 10);
const DIRECT_HTTP_PORT = Number.parseInt(process.env.DIRECT_HTTP_PORT || "80", 10);
const DIRECT_CERT_FILE = process.env.DIRECT_CERT_FILE || "";
const DIRECT_KEY_FILE = process.env.DIRECT_KEY_FILE || "";
const DIRECT_LETSENCRYPT_EMAIL = process.env.DIRECT_LETSENCRYPT_EMAIL || "admin@lemon.vin";
const CF_DNS_ENABLED = parseBoolean(process.env.CF_DNS_ENABLED, false);
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
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
const TEAMNODE_SYNC_GROUP_KEY = process.env.TEAMNODE_SYNC_GROUP_KEY || "basic";
const TEAMNODE_SYNC_PROVIDER = process.env.TEAMNODE_SYNC_PROVIDER || "";
const TEAMNODE_SYNC_LABEL_PREFIX = process.env.TEAMNODE_SYNC_LABEL_PREFIX || "";
const TEAMNODE_SYNC_TIMEOUT_MS = Number.parseInt(process.env.TEAMNODE_SYNC_TIMEOUT_MS || "10000", 10);
const TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS = Number.parseInt(process.env.TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS || "300000", 10);
const TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT = parseBoolean(
  process.env.TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT,
  false
);
const TEAMNODE_SYNC_SHUTDOWN_TIMEOUT_MS = 3000;

// Docker 镜像内置二进制目录
const BIN_PATH = process.env.BIN_PATH || "/usr/local/bin";
const XRAY_BIN = process.env.XRAY_BIN || path.join(BIN_PATH, "xray");
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || path.join(BIN_PATH, "cloudflared");
const NEZHA_AGENT_BIN = process.env.NEZHA_AGENT_BIN || path.join(BIN_PATH, "nezha-agent");
const NEZHA_AGENT_LEGACY_BIN = process.env.NEZHA_AGENT_LEGACY_BIN || path.join(BIN_PATH, "nezha-agent-legacy");

if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH);
  console.log(`${FILE_PATH} 已创建`);
} else {
  console.log(`${FILE_PATH} 已存在`);
}

// 全局路径常量
const npmPath = NEZHA_AGENT_LEGACY_BIN;
const phpPath = NEZHA_AGENT_BIN;
const webPath = XRAY_BIN;
const botPath = CLOUDFLARED_BIN;
const npmName = path.basename(npmPath, path.extname(npmPath));
const webName = path.basename(webPath, path.extname(webPath));
const botName = path.basename(botPath, path.extname(botPath));
const phpName = path.basename(phpPath, path.extname(phpPath));
const subPath = path.join(FILE_PATH, "sub.txt");
const listPath = path.join(FILE_PATH, "list.txt");
const bootLogPath = path.join(FILE_PATH, "boot.log");
const configPath = path.join(FILE_PATH, "config.json");
const xrayAccessLogPath = path.join(FILE_PATH, "xray-access.log");
const xrayErrorLogPath = path.join(FILE_PATH, "xray-error.log");
const cloudflaredLogPath = path.join(FILE_PATH, "cloudflared.log");
const directNginxConfigPath = path.join(FILE_PATH, "nginx-direct.conf");
const directNginxAccessLogPath = path.join(FILE_PATH, "nginx-access.log");
const directNginxErrorLogPath = path.join(FILE_PATH, "nginx-error.log");
const directNginxPidPath = path.join(FILE_PATH, "nginx.pid");
const directAcmePath = path.join(FILE_PATH, "acme");
const nezhaConfigPath = path.join(FILE_PATH, "config.yaml");
const tunnelJsonPath = path.join(FILE_PATH, "tunnel.json");
const tunnelYamlPath = path.join(FILE_PATH, "tunnel.yml");
const NGINX_BIN = process.env.NGINX_BIN || "/usr/sbin/nginx";
const CERTBOT_BIN = process.env.CERTBOT_BIN || "/usr/bin/certbot";

let teamnodeSyncTimer = null;
let teamnodeSyncRegistered = false;
let teamnodeSyncContext = null;
let teamnodeShutdownPromise = null;
let directCertificateRenewalTimer = null;
let cloudflareDnsSyncTimer = null;
let processShutdownRequested = false;
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
  Boolean(TEAMNODE_SYNC_SECRET)
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
  const signature = crypto
    .createHmac("sha256", String(TEAMNODE_SYNC_SECRET || ""))
    .update(signaturePayload, "utf8")
    .digest("hex");

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
      "x-sync-signature": signature
    }
  };
}

function isTeamNodeSyncConfigured() {
  return Boolean(
    TEAMNODE_SYNC_ENABLED
    && normalizeBaseUrl(TEAMNODE_SYNC_BASE_URL)
    && TEAMNODE_SYNC_KEY_ID
    && TEAMNODE_SYNC_SECRET
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

async function postTeamNodeSync(relativePath, payload, eventPrefix) {
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
      : 10000
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

async function syncNodeToTeamNode(context) {
  if (!isTeamNodeSyncConfigured()) {
    return null;
  }

  const ipRisk = context.ipRisk && !teamnodeSyncRegistered
    ? context.ipRisk
    : await resolveTeamNodeIpRiskInfo();
  const syncContext = {
    ...context,
    ipRisk
  };

  teamnodeSyncContext = syncContext;

  try {
    return teamnodeSyncRegistered
      ? await syncNodeHeartbeatToTeamNode(syncContext)
      : await syncNodeRegistrationToTeamNode(syncContext);
  } catch (error) {
    const status = error?.response?.status ? ` (HTTP ${error.response.status})` : "";
    const message = error?.response?.data?.error || error?.message || "unknown_error";
    console.error(`TeamNode 同步失败${status}: ${message}`);
    return null;
  }
}

function stopTeamNodeHeartbeatLoop() {
  if (teamnodeSyncTimer) {
    clearInterval(teamnodeSyncTimer);
    teamnodeSyncTimer = null;
  }
}

function startTeamNodeHeartbeatLoop(context) {
  if (!isTeamNodeSyncConfigured() || !context) return;

  teamnodeSyncContext = context;
  stopTeamNodeHeartbeatLoop();

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
        port: ARGO_PORT,
        listen: DIRECT_MODE ? "127.0.0.1" : undefined,
        protocol: "vless",
        settings: {
          clients: [{ id: UUID, flow: "xtls-rprx-vision" }],
          decryption: "none",
          fallbacks: [
            { path: "/vless-argo", dest: 3002 },
            { path: "/vmess-argo", dest: 3003 },
            { path: "/trojan-argo", dest: 3004 },
            // 未匹配代理 WebSocket 路径的普通 HTTP 请求（例如根路径 /）
            // 最后回落到 Express Web 服务，避免固定隧道指向 ARGO_PORT 时返回 502。
            { dest: Number(PORT) }
          ]
        },
        streamSettings: { network: "tcp" }
      },
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

  if (DIRECT_PORT === DIRECT_HTTP_PORT) {
    throw new Error("DIRECT_PORT 和 DIRECT_HTTP_PORT 不能使用同一个端口");
  }

  if (Boolean(DIRECT_CERT_FILE) !== Boolean(DIRECT_KEY_FILE)) {
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
    certificateFile: path.join("/etc/letsencrypt/live", ARGO_DOMAIN, "fullchain.pem"),
    keyFile: path.join("/etc/letsencrypt/live", ARGO_DOMAIN, "privkey.pem"),
    managedByCertbot: true
  };
}

function buildDirectNginxConfig({ certificateFile = "", keyFile = "", httpOnly = false } = {}) {
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
  await exec(`nohup ${shellQuote(NGINX_BIN)} -c ${shellQuote(config)} >/dev/null 2>&1 &`);
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
      await exec(`${shellQuote(CERTBOT_BIN)} renew --quiet`);
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
  const certificate = await ensureDirectCertificate();
  writeDirectNginxConfig(certificate);
  await startNginx();
  startDirectCertificateRenewal();
}

// 根据认证方式生成 cloudflared 启动参数
function getCloudflaredProtocol() {
  const protocol = String(CLOUDFLARED_PROTOCOL || "").trim().toLowerCase();
  return ["auto", "quic", "http2"].includes(protocol) ? protocol : "http2";
}

function buildCloudflaredArgs() {
  if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
    return `tunnel --edge-ip-version auto --autoupdate-freq 24h --protocol ${getCloudflaredProtocol()} --logfile "${cloudflaredLogPath}" --loglevel ${CLOUDFLARED_LOG_LEVEL} run --token ${ARGO_AUTH}`;
  }

  if (ARGO_AUTH.match(/TunnelSecret/)) {
    return `tunnel --edge-ip-version auto --autoupdate-freq 24h --config "${tunnelYamlPath}" --logfile "${cloudflaredLogPath}" --loglevel ${CLOUDFLARED_LOG_LEVEL} run`;
  }

  return `tunnel --edge-ip-version auto --autoupdate-freq 24h --protocol ${getCloudflaredProtocol()} --logfile "${bootLogPath}" --loglevel info --url http://localhost:${ARGO_PORT}`;
}

// 启动镜像内置的哪吒、Xray、cloudflared
async function startProcesses() {
  try {
    ensureBinaryExists(webPath, "xray");
    if (!DIRECT_MODE && !PLATFORM_PROXY_MODE) {
      ensureBinaryExists(botPath, "cloudflared");
    }
    authorizeFiles(DIRECT_MODE || PLATFORM_PROXY_MODE ? [webPath] : [webPath, botPath]);
  } catch (error) {
    console.error(`二进制检查失败：${error.message}`);
    throw error;
  }

  if (NEZHA_SERVER && NEZHA_KEY) {
    if (!NEZHA_PORT) {
      try {
        ensureBinaryExists(phpPath, "nezha-agent");
        authorizeFiles([phpPath]);

        const port = NEZHA_SERVER.includes(":") ? NEZHA_SERVER.split(":").pop() : "";
        const tlsPorts = new Set(["443", "8443", "2096", "2087", "2083", "2053"]);
        const nezhatls = tlsPorts.has(port) ? "true" : "false";
        const configYaml = `
client_secret: ${NEZHA_KEY}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
report_delay: 4
server: ${NEZHA_SERVER}
skip_connection_count: true
skip_procs_count: true
temperature: false
tls: ${nezhatls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}`;

        fs.writeFileSync(nezhaConfigPath, configYaml);
        await exec(`nohup "${phpPath}" -c "${nezhaConfigPath}" >/dev/null 2>&1 &`);
        console.log(`${phpName} 已启动`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`哪吒 v1 启动失败：${error}`);
      }
    } else {
      try {
        ensureBinaryExists(npmPath, "nezha-agent-legacy");
        authorizeFiles([npmPath]);

        let NEZHA_TLS = "";
        const tlsPorts = ["443", "8443", "2096", "2087", "2083", "2053"];
        if (tlsPorts.includes(NEZHA_PORT)) {
          NEZHA_TLS = "--tls";
        }

        await exec(`nohup "${npmPath}" -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${NEZHA_TLS} --disable-auto-update --report-delay 4 --skip-conn --skip-procs >/dev/null 2>&1 &`);
        console.log(`${npmName} 已启动`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`哪吒 v0 启动失败：${error}`);
      }
    }
  } else {
    console.log("未配置哪吒参数，跳过启动");
  }

  try {
    await exec(`nohup "${webPath}" -c "${configPath}" >/dev/null 2>&1 &`);
    console.log(`${webName} 已启动`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(`Xray 启动失败：${error}`);
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
  } else {
    try {
      const args = buildCloudflaredArgs();
      await exec(`nohup "${botPath}" ${args} >/dev/null 2>&1 &`);
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
  if (DIRECT_MODE || PLATFORM_PROXY_MODE) {
    if (PLATFORM_PROXY_MODE) {
      console.log("PLATFORM_PROXY_MODE 已启用，不启动 Cloudflare Tunnel");
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
      service: http://localhost:${ARGO_PORT}
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
      await exec(`nohup "${botPath}" ${args} >/dev/null 2>&1 &`);
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
          display: `${response2.data.countryCode}-${response2.data.org}`.replace(/\s+/g, "_")
        };
      }
    } catch {
      return {
        countryCode: "Unknown",
        countryName: null,
        ispName: "Unknown",
        display: "Unknown"
      };
    }
  }

  return {
    countryCode: "Unknown",
    countryName: null,
    ispName: "Unknown",
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
        tls: "tls",
        sni: argoDomain,
        alpn: "",
        fp: "firefox"
      };

      const subTxt = `
vless://${UUID}@${nodeAddress}:${nodePort}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}

vmess://${Buffer.from(JSON.stringify(VMESS)).toString("base64")}

trojan://${UUID}@${nodeAddress}:${nodePort}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}
      `;

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
    validateDirectMode();
    validatePlatformProxyMode();
    validateCloudflareDnsMode();
    await syncCloudflareDnsRecord();
    startCloudflareDnsSyncLoop();
    deleteNodes();
    cleanupOldFiles();
    argoType();
    await generateConfig();
    await startProcesses();
    await extractDomains();
    await AddVisitTask();
  } catch (error) {
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
  app.listen(PORT, () => console.log(`HTTP 服务已运行，端口：${PORT}`));
}
