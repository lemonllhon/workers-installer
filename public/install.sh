#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_NAME="nodejs-argo-no-docker-installer"
readonly DEFAULT_APP_DIR="/opt/nodejs-argo-no-docker"
readonly DEFAULT_SERVICE_NAME="nodejs-argo-no-docker"
readonly DEFAULT_SOURCE_BASE_URL="__WORKER_SOURCE_BASE_URL__"
readonly DEFAULT_INDEX_SHA256="B7A204F42B177878011D65BCD116F0D78B51A8898F07BE895930A09EA8816EC3"

readonly DEFAULT_CLOUDFLARED_VERSION="latest"
readonly CLOUDFLARED_RELEASE_PAGE="https://github.com/cloudflare/cloudflared/releases"
readonly DEFAULT_XRAY_VERSION="v26.3.27"
readonly DEFAULT_NEZHA_VERSION="v1.14.1"

APP_DIR="${APP_DIR:-${DEFAULT_APP_DIR}}"
SERVICE_NAME="${SERVICE_NAME:-${DEFAULT_SERVICE_NAME}}"
SERVICE_USER="${SERVICE_USER:-nodejs-argo}"
SOURCE_BASE_URL="${SOURCE_BASE_URL:-${DEFAULT_SOURCE_BASE_URL}}"
SOURCE_INDEX_SHA256="${SOURCE_INDEX_SHA256:-${DEFAULT_INDEX_SHA256}}"

CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-${DEFAULT_CLOUDFLARED_VERSION}}"
XRAY_VERSION="${XRAY_VERSION:-${DEFAULT_XRAY_VERSION}}"
NEZHA_VERSION="${NEZHA_VERSION:-${DEFAULT_NEZHA_VERSION}}"
REQUIRE_CHECKSUMS="${REQUIRE_CHECKSUMS:-true}"

TEAMNODE_SYNC_BASE_URL="${TEAMNODE_SYNC_BASE_URL:-https://teamnode.lemon.vin}"
TEAMNODE_SYNC_KEY_ID="${TEAMNODE_SYNC_KEY_ID:-nodejs-argo-prod}"
TEAMNODE_SYNC_GROUP_KEY="${TEAMNODE_SYNC_GROUP_KEY:-basic}"
TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS="${TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS:-300000}"
TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT="${TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT:-true}"
TEAMNODE_SYNC_TIMEOUT_MS="${TEAMNODE_SYNC_TIMEOUT_MS:-10000}"
TEAMNODE_SYNC_ENABLED="${TEAMNODE_SYNC_ENABLED:-true}"

ARGO_PORT="${ARGO_PORT:-8001}"
CFPORT="${CFPORT:-443}"
SERVER_PORT="${SERVER_PORT:-3000}"
FILE_PATH="${FILE_PATH:-}"
BIN_PATH="${BIN_PATH:-}"

UNINSTALL=false
DRY_RUN=false

log() { printf '[%s] %s\n' "${SCRIPT_NAME}" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "${SCRIPT_NAME}" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "${SCRIPT_NAME}" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
用法：
  install.sh                         安装或更新无 Docker 节点
  install.sh --uninstall              卸载本安装器创建的服务和目录
  install.sh --dry-run                只检查环境，不写入系统
  install.sh --app-dir /opt/example   覆盖安装目录

所有密钥通过环境变量传入，不写入脚本：
  TEAMNODE_SYNC_SECRET、ARGO_AUTH、ARGO_DOMAIN、UUID
USAGE
}

is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

validate_app_dir() {
  [[ "${APP_DIR}" = /* ]] || die "APP_DIR 必须是绝对路径"
  [[ "${APP_DIR}" != "/" && "${APP_DIR}" != "/opt" && "${APP_DIR}" != "/usr" && "${APP_DIR}" != "/var" && "${APP_DIR}" != "/etc" && "${APP_DIR}" != "/home" && "${APP_DIR}" != "/root" ]] || die "拒绝使用过于宽泛的 APP_DIR: ${APP_DIR}"
  [[ "${APP_DIR}" != *$'\n'* && "${APP_DIR}" != *$'\r'* && "${APP_DIR}" != *' '* ]] || die "APP_DIR 不得包含空格或换行"
  [[ "${SERVICE_NAME}" =~ ^[a-zA-Z0-9_.@-]+$ ]] || die "SERVICE_NAME 含有非法字符"
  [[ "${SERVICE_USER}" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "SERVICE_USER 含有非法字符"
}

validate_runtime_paths() {
  [[ "${FILE_PATH}" = /* ]] || die "FILE_PATH 必须是绝对路径"
  [[ "${BIN_PATH}" = /* ]] || die "BIN_PATH 必须是绝对路径"
  [[ "${FILE_PATH}" != *$'\n'* && "${FILE_PATH}" != *$'\r'* && "${FILE_PATH}" != *' '* ]] || die "FILE_PATH 不得包含空格或换行"
  [[ "${BIN_PATH}" != *$'\n'* && "${BIN_PATH}" != *$'\r'* && "${BIN_PATH}" != *' '* ]] || die "BIN_PATH 不得包含空格或换行"
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "请使用 root 运行，或执行 sudo -i 后再运行"
}

require_config() {
  [[ -n "${TEAMNODE_SYNC_SECRET:-}" ]] || die "必须设置 TEAMNODE_SYNC_SECRET"
  [[ -n "${ARGO_DOMAIN:-}" ]] || die "必须设置 ARGO_DOMAIN"
  [[ -n "${ARGO_AUTH:-}" ]] || die "必须设置 ARGO_AUTH"
  [[ -n "${UUID:-}" ]] || die "必须设置 UUID"
}

has_command() { command -v "$1" >/dev/null 2>&1; }

install_debian_dependencies() {
  has_command apt-get || die "缺少依赖，且当前系统不是 Debian/Ubuntu（没有 apt-get）"
  log "安装基础依赖：curl、ca-certificates、unzip、Node.js、npm"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl coreutils unzip util-linux nodejs npm >/dev/null
}

check_dependencies() {
  if ! has_command curl || ! has_command sha256sum || ! has_command unzip || ! has_command systemctl || ! has_command node || ! has_command npm; then
    is_true "${DRY_RUN}" && die "缺少依赖（dry-run 不会安装依赖）"
    install_debian_dependencies
  fi

  has_command systemctl || die "当前系统没有 systemd，无法创建开机服务"
  has_command node || die "未找到 node"
  has_command npm || die "未找到 npm"

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  [[ "${node_major}" =~ ^[0-9]+$ ]] || die "无法读取 Node.js 版本"
  (( node_major >= 14 )) || die "Node.js 版本过低：${node_major}，需要 >= 14"
}

download_verified() {
  local url="$1"
  local destination="$2"
  local expected_sha256="${3:-}"
  local label="${4:-download}"
  local temporary="${TMP_DIR}/$(basename "${destination}").download"

  log "下载 ${label}"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 300 \
    --output "${temporary}" "${url}"

  if [[ -n "${expected_sha256}" ]]; then
    expected_sha256="${expected_sha256,,}"
    [[ "${expected_sha256}" =~ ^[0-9a-f]{64}$ ]] || die "${label} SHA256 格式无效"
    local actual_sha256
    actual_sha256="$(sha256sum "${temporary}" | awk '{print $1}')"
    [[ "${actual_sha256}" = "${expected_sha256}" ]] || die "${label} SHA256 校验失败：${actual_sha256}"
  elif is_true "${REQUIRE_CHECKSUMS}"; then
    die "${label} 没有 SHA256 校验值；请显式设置 REQUIRE_CHECKSUMS=false 才能继续"
  else
    warn "${label} 未配置 SHA256 校验值"
  fi

  install -m 0644 "${temporary}" "${destination}"
}

install_cloudflared() {
  local arch="$1"
  local asset
  local expected
  local release_url
  local release_final_url
  local release_html="${TMP_DIR}/cloudflared-release.html"
  local release_tag
  case "${arch}" in
    amd64)
      asset="cloudflared-linux-amd64"
      ;;
    arm64)
      asset="cloudflared-linux-arm64"
      ;;
    *) die "不支持的架构：${arch}" ;;
  esac

  if [[ "${CLOUDFLARED_VERSION}" = "latest" ]]; then
    release_url="${CLOUDFLARED_RELEASE_PAGE}/latest"
  else
    local requested_version="${CLOUDFLARED_VERSION#v}"
    [[ "${requested_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "CLOUDFLARED_VERSION 必须是 latest 或类似 2026.7.3 的版本号"
    release_url="${CLOUDFLARED_RELEASE_PAGE}/tag/${requested_version}"
  fi

  log "获取 Cloudflare Tunnel 官方 release 信息"
  release_final_url="$(curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 60 \
    --output /dev/null --write-out '%{url_effective}' "${release_url}")" || die "无法定位 Cloudflare Tunnel release"
  [[ "${release_final_url}" =~ ^https://github\.com/cloudflare/cloudflared/releases/tag/[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Cloudflare release 地址格式异常"
  release_tag="${release_final_url##*/}"

  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 60 \
    --user-agent "${SCRIPT_NAME}" \
    --output "${release_html}" "${release_final_url}"

  if [[ -n "${CLOUDFLARED_SHA256:-}" ]]; then
    expected="${CLOUDFLARED_SHA256}"
  else
    expected="$(node -e '
      const fs = require("fs");
      const html = fs.readFileSync(process.argv[1], "utf8");
      const asset = process.argv[2];
      const match = html.match(new RegExp(asset + ":\\s*([a-f0-9]{64})\\b", "i"));
      if (!match) process.exit(1);
      process.stdout.write(match[1]);
    ' "${release_html}" "${asset}")" || die "无法从 Cloudflare 官方 release 获取 ${asset} 的 SHA256"
  fi

  download_verified \
    "https://github.com/cloudflare/cloudflared/releases/download/${release_tag}/${asset}" \
    "${BIN_PATH}/cloudflared" "${expected}" "cloudflared ${release_tag}"
  chmod 0755 "${BIN_PATH}/cloudflared"
}

install_xray() {
  local arch="$1"
  local asset
  local expected
  case "${arch}" in
    amd64)
      asset="Xray-linux-64.zip"
      expected="23CD9AF937744D97776EE35ECAD4972CF4B2109D1E0FE6BE9930467608F7C8AE"
      ;;
    arm64)
      asset="Xray-linux-arm64-v8a.zip"
      expected="4D30283AE614E3057F730F67CD088A42BE6FDF91F8639D82CB69E48CDE80413C"
      ;;
    *) die "不支持的架构：${arch}" ;;
  esac
  expected="${XRAY_SHA256:-${expected}}"
  local archive="${TMP_DIR}/${asset}"
  download_verified \
    "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${asset}" \
    "${archive}" "${expected}" "Xray ${XRAY_VERSION}"
  unzip -j -o "${archive}" xray -d "${BIN_PATH}" >/dev/null
  chmod 0755 "${BIN_PATH}/xray"
}

install_nezha() {
  local arch="$1"
  local asset
  local expected
  case "${arch}" in
    amd64)
      asset="nezha-agent_linux_amd64.zip"
      expected="47A67447F8A1A64F95B4FE93193ECBCB56457A0357101ED58071293675C0FA1F"
      ;;
    arm64)
      asset="nezha-agent_linux_arm64.zip"
      expected="8B1AB80D4B21AD5DBF087D78CF84334DE15C80AB9D2596A8235D90BF8116473F"
      ;;
    *) die "不支持的架构：${arch}" ;;
  esac
  expected="${NEZHA_SHA256:-${expected}}"
  local archive="${TMP_DIR}/${asset}"
  download_verified \
    "https://github.com/nezhahq/agent/releases/download/${NEZHA_VERSION}/${asset}" \
    "${archive}" "${expected}" "哪吒 agent ${NEZHA_VERSION}"
  unzip -j -o "${archive}" nezha-agent -d "${BIN_PATH}" >/dev/null
  cp "${BIN_PATH}/nezha-agent" "${BIN_PATH}/nezha-agent-legacy"
  chmod 0755 "${BIN_PATH}/nezha-agent" "${BIN_PATH}/nezha-agent-legacy"
}

write_env_value() {
  local key="$1"
  local value="${2-}"
  printf '%s=%q\n' "${key}" "${value}" >> "${ENV_FILE}"
}

write_runtime_files() {
  log "下载并校验固定版本的 nodejs-argo 源码"
  download_verified "${SOURCE_BASE_URL%/}/index.js" "${APP_DIR}/app/index.js" "${SOURCE_INDEX_SHA256}" "nodejs-argo index.js"

  cat > "${APP_DIR}/app/package.json" <<'JSON'
{
  "name": "nodejs-argo-no-docker",
  "private": true,
  "version": "1.0.0",
  "engines": { "node": ">=14" },
  "dependencies": {
    "axios": "1.7.9",
    "express": "4.21.2"
  }
}
JSON

  install -d -m 0700 "${APP_DIR}/home" "${APP_DIR}/npm-cache"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
  log "安装固定 npm 依赖（禁止 install scripts）"
  runuser -u "${SERVICE_USER}" -- env HOME="${APP_DIR}/home" NPM_CONFIG_CACHE="${APP_DIR}/npm-cache" \
    "${NPM_BIN}" --prefix "${APP_DIR}/app" install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false
}

write_env_file() {
  : > "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  write_env_value "NODE_ENV" "production"
  write_env_value "SERVER_PORT" "${SERVER_PORT}"
  write_env_value "PORT" "${SERVER_PORT}"
  write_env_value "FILE_PATH" "${FILE_PATH}"
  write_env_value "BIN_PATH" "${BIN_PATH}"
  write_env_value "ARGO_PORT" "${ARGO_PORT}"
  write_env_value "ARGO_DOMAIN" "${ARGO_DOMAIN}"
  write_env_value "ARGO_AUTH" "${ARGO_AUTH}"
  write_env_value "CFIP" "${CFIP:-}"
  write_env_value "CFPORT" "${CFPORT}"
  write_env_value "NAME" "${NAME:-}"
  write_env_value "UUID" "${UUID}"
  write_env_value "NEZHA_SERVER" "${NEZHA_SERVER:-}"
  write_env_value "NEZHA_PORT" "${NEZHA_PORT:-}"
  write_env_value "NEZHA_KEY" "${NEZHA_KEY:-}"
  write_env_value "UPLOAD_URL" "${UPLOAD_URL:-}"
  write_env_value "PROJECT_URL" "${PROJECT_URL:-}"
  write_env_value "SUB_PATH" "${SUB_PATH:-sub}"
  write_env_value "AUTO_ACCESS" "${AUTO_ACCESS:-false}"
  write_env_value "TEAMNODE_SYNC_ENABLED" "${TEAMNODE_SYNC_ENABLED}"
  write_env_value "TEAMNODE_SYNC_BASE_URL" "${TEAMNODE_SYNC_BASE_URL}"
  write_env_value "TEAMNODE_SYNC_KEY_ID" "${TEAMNODE_SYNC_KEY_ID}"
  write_env_value "TEAMNODE_SYNC_SECRET" "${TEAMNODE_SYNC_SECRET}"
  write_env_value "TEAMNODE_SYNC_GROUP_KEY" "${TEAMNODE_SYNC_GROUP_KEY}"
  write_env_value "TEAMNODE_SYNC_PROVIDER" "${TEAMNODE_SYNC_PROVIDER:-}"
  write_env_value "TEAMNODE_SYNC_LABEL_PREFIX" "${TEAMNODE_SYNC_LABEL_PREFIX:-}"
  write_env_value "TEAMNODE_SYNC_TIMEOUT_MS" "${TEAMNODE_SYNC_TIMEOUT_MS}"
  write_env_value "TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS" "${TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS}"
  write_env_value "TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT" "${TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT}"
  write_env_value "CLOUDFLARED_PROTOCOL" "${CLOUDFLARED_PROTOCOL:-http2}"
  write_env_value "CLOUDFLARED_LOG_LEVEL" "${CLOUDFLARED_LOG_LEVEL:-info}"
  write_env_value "XRAY_LOG_LEVEL" "${XRAY_LOG_LEVEL:-warning}"
  write_env_value "XRAY_ACCESS_LOG_ENABLED" "${XRAY_ACCESS_LOG_ENABLED:-false}"
  write_env_value "XRAY_SNIFFING_ENABLED" "${XRAY_SNIFFING_ENABLED:-false}"
  write_env_value "DIRECT_MODE" "${DIRECT_MODE:-false}"
  write_env_value "PLATFORM_PROXY_MODE" "${PLATFORM_PROXY_MODE:-false}"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${ENV_FILE}"
}

write_systemd_unit() {
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=nodejs-argo no-Docker node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}/app
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${APP_DIR}/app/index.js
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=${FILE_PATH} ${APP_DIR}/home ${APP_DIR}/npm-cache
UMask=0077
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${SERVICE_FILE}"
}

uninstall() {
  require_root
  validate_app_dir
  if has_command systemctl; then
    systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  fi
  rm -f -- "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload >/dev/null 2>&1 || true
  rm -rf -- "${APP_DIR}"
  log "已卸载：${APP_DIR} 和 ${SERVICE_NAME}.service"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --uninstall) UNINSTALL=true ;;
      --dry-run) DRY_RUN=true ;;
      --app-dir) [[ $# -ge 2 ]] || die "--app-dir 缺少值"; APP_DIR="$2"; shift ;;
      --service-name) [[ $# -ge 2 ]] || die "--service-name 缺少值"; SERVICE_NAME="$2"; shift ;;
      --source-base-url) [[ $# -ge 2 ]] || die "--source-base-url 缺少值"; SOURCE_BASE_URL="$2"; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "未知参数：$1（使用 --help 查看用法）" ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  validate_app_dir
  if is_true "${UNINSTALL}"; then
    uninstall
    return 0
  fi

  require_root
  require_config
  check_dependencies
  if is_true "${DRY_RUN}"; then
    log "dry-run 检查通过：Node.js $(node --version)"
    return 0
  fi

  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
  BIN_PATH="${BIN_PATH:-${APP_DIR}/bin}"
  FILE_PATH="${FILE_PATH:-${APP_DIR}/data}"
  validate_runtime_paths
  ENV_FILE="${APP_DIR}/.env"
  SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf -- "${TMP_DIR}"' EXIT

  install -d -m 0750 "${APP_DIR}" "${APP_DIR}/app" "${BIN_PATH}" "${FILE_PATH}"
  if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi

  local machine_arch
  case "$(uname -m)" in
    x86_64|amd64) machine_arch="amd64" ;;
    aarch64|arm64) machine_arch="arm64" ;;
    *) die "不支持的系统架构：$(uname -m)" ;;
  esac

  install_cloudflared "${machine_arch}"
  install_xray "${machine_arch}"
  install_nezha "${machine_arch}"
  write_runtime_files
  write_env_file
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
  chmod 0700 "${APP_DIR}" "${APP_DIR}/data"
  chmod 0600 "${ENV_FILE}"
  write_systemd_unit
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}.service"

  log "安装完成"
  log "服务：${SERVICE_NAME}.service"
  log "查看日志：journalctl -u ${SERVICE_NAME}.service -f"
  log "TeamNode：${TEAMNODE_SYNC_BASE_URL}"
}

main "$@"
