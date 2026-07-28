#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_NAME="nodejs-argo-no-docker-installer"
readonly DEFAULT_APP_DIR="/opt/nodejs-argo-no-docker"
readonly DEFAULT_SERVICE_NAME="nodejs-argo-no-docker"
readonly DEFAULT_SOURCE_BASE_URL="__WORKER_SOURCE_BASE_URL__"
readonly DEFAULT_INDEX_SHA256="__WORKER_SOURCE_SHA256__"

readonly DEFAULT_CLOUDFLARED_VERSION="latest"
readonly CLOUDFLARED_RELEASE_PAGE="https://github.com/cloudflare/cloudflared/releases"
readonly DEFAULT_XRAY_VERSION="v26.3.27"
readonly DEFAULT_NEZHA_VERSION="v1.14.1"
readonly DEFAULT_PM2_VERSION="5.4.3"

APP_DIR="${APP_DIR:-${DEFAULT_APP_DIR}}"
SERVICE_NAME="${SERVICE_NAME:-${DEFAULT_SERVICE_NAME}}"
SERVICE_USER="${SERVICE_USER:-nodejs-argo}"
SERVICE_MODE="${SERVICE_MODE:-auto}"
SOURCE_BASE_URL="${SOURCE_BASE_URL:-${DEFAULT_SOURCE_BASE_URL}}"
SOURCE_INDEX_SHA256="${SOURCE_INDEX_SHA256:-${DEFAULT_INDEX_SHA256}}"

CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-${DEFAULT_CLOUDFLARED_VERSION}}"
XRAY_VERSION="${XRAY_VERSION:-${DEFAULT_XRAY_VERSION}}"
NEZHA_VERSION="${NEZHA_VERSION:-${DEFAULT_NEZHA_VERSION}}"
PM2_VERSION="${PM2_VERSION:-${DEFAULT_PM2_VERSION}}"
REQUIRE_CHECKSUMS="${REQUIRE_CHECKSUMS:-true}"
FORCE_KILL_PORTS="${FORCE_KILL_PORTS:-false}"

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

SERVICE_BACKEND=""
NODE_BIN=""
NPM_BIN=""
BASH_BIN=""
RUNUSER_BIN=""
SU_BIN=""
ENV_FILE=""
SERVICE_FILE=""
RUNNER_SCRIPT=""
PID_FILE=""
PM2_DIR=""
PM2_HOME_DIR=""
PM2_BIN=""
RUN_AS_ROOT=false
TMP_DIR=""

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
  install.sh --service-mode auto      自动选择 systemd/OpenRC/SysV/cron

所有密钥通过环境变量传入，不写入脚本：
  TEAMNODE_SYNC_SECRET、ARGO_AUTH、ARGO_DOMAIN
UUID 可选；未设置时安装器会随机生成并保存到 .env。

SERVICE_MODE 可选：auto、systemd、openrc、sysv、rc.local、cron、none。
auto 模式没有可用 init/cron 时，会安装固定版本 PM2 作为最后的进程守护。
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
}

validate_uuid() {
  [[ "${UUID}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || die "UUID 格式无效：${UUID}"
}

generate_uuid_if_missing() {
  if [[ -n "${UUID:-}" ]]; then
    validate_uuid
    return 0
  fi

  UUID="$("${NODE_BIN}" -e '
    const crypto = require("crypto");
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    process.stdout.write(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  ' 2>/dev/null)" || die "无法随机生成 UUID"
  [[ -n "${UUID}" ]] || die "无法随机生成 UUID"
  validate_uuid
  log "未设置 UUID，已随机生成：${UUID}（将保存到 .env）"
}

validate_worker_placeholders() {
  [[ "${SOURCE_BASE_URL}" != "__WORKER_SOURCE_BASE_URL__" ]] || die "安装脚本源码地址占位符未替换；请从 https://install.lemon.vin/install.sh 下载"
  [[ "${SOURCE_INDEX_SHA256}" != "__WORKER_SOURCE_SHA256__" ]] || die "安装脚本源码 SHA256 占位符未替换；请从 Worker 地址下载，不要直接使用 GitHub 原始 install.sh"
}

has_command() { command -v "$1" >/dev/null 2>&1; }

install_os_dependencies() {
  log "安装基础依赖：bash、curl、ca-certificates、unzip、Node.js、npm"
  if has_command apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq bash ca-certificates curl coreutils iproute2 passwd unzip util-linux nodejs npm >/dev/null
  elif has_command apk; then
    apk add --no-cache bash ca-certificates curl coreutils iproute2 unzip util-linux nodejs npm >/dev/null
  elif has_command dnf; then
    dnf install -y bash ca-certificates curl coreutils iproute unzip util-linux nodejs npm shadow-utils >/dev/null
  elif has_command yum; then
    yum install -y bash ca-certificates curl coreutils iproute unzip util-linux nodejs npm shadow-utils >/dev/null
  elif has_command zypper; then
    zypper --non-interactive install bash ca-certificates curl coreutils iproute2 unzip util-linux nodejs npm >/dev/null
  else
    die "缺少依赖，且未找到 apt-get、apk、dnf、yum 或 zypper"
  fi
}

can_run_as_service_user() {
  has_command runuser || has_command su
}

prepare_user_switch() {
  BASH_BIN="$(command -v bash 2>/dev/null || true)"
  [[ -n "${BASH_BIN}" ]] || die "未找到 bash"

  if has_command runuser; then
    RUNUSER_BIN="$(command -v runuser)"
  elif has_command su; then
    SU_BIN="$(command -v su)"
  else
    if [[ "${EUID}" -eq 0 ]]; then
      RUN_AS_ROOT=true
      warn "未找到 runuser 或 su；PM2/Node 将由 root 运行"
    else
      die "未找到 runuser 或 su，无法运行节点"
    fi
  fi
}

run_as_service_user() {
  if [[ -n "${RUNUSER_BIN}" ]]; then
    "${RUNUSER_BIN}" -u "${SERVICE_USER}" -- "$@"
  elif [[ -n "${SU_BIN}" ]]; then
    "${SU_BIN}" -s "${BASH_BIN}" -c 'exec "$@"' "${SERVICE_USER}" -- "$@"
  elif [[ "${RUN_AS_ROOT}" == true && "${EUID}" -eq 0 ]]; then
    "$@"
  else
    die "没有可用的 runuser、su 或 root 权限"
  fi
}

create_service_user() {
  if id "${SERVICE_USER}" >/dev/null 2>&1; then
    return 0
  fi

  if has_command useradd; then
    useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  elif has_command adduser; then
    adduser -S -D -H -s /sbin/nologin "${SERVICE_USER}" 2>/dev/null || \
      adduser --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  else
    die "未找到 useradd 或 adduser，无法创建服务用户"
  fi
}

check_dependencies() {
  if ! has_command bash || ! has_command curl || ! has_command sha256sum || ! has_command ss || ! has_command unzip || ! has_command nohup || ! has_command node || ! has_command npm || ! can_run_as_service_user; then
    is_true "${DRY_RUN}" && die "缺少依赖（dry-run 不会安装依赖）"
    install_os_dependencies
  fi

  has_command bash || die "未找到 bash"
  has_command node || die "未找到 node"
  has_command npm || die "未找到 npm"
  has_command sha256sum || die "未找到 sha256sum"
  has_command ss || die "未找到 ss，无法安全检测端口占用"
  has_command unzip || die "未找到 unzip"
  prepare_user_switch

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  [[ "${node_major}" =~ ^[0-9]+$ ]] || die "无法读取 Node.js 版本"
  (( node_major >= 14 )) || die "Node.js 版本过低：${node_major}，需要 >= 14"
}

detect_service_backend() {
  local requested="${SERVICE_MODE,,}"
  case "${requested}" in
    auto)
      if has_command systemctl && [[ -d /run/systemd/system ]]; then
        SERVICE_BACKEND="systemd"
      elif has_command rc-service && has_command rc-update && [[ -x /sbin/openrc-run || -x /usr/sbin/openrc-run || -n "$(command -v openrc-run 2>/dev/null || true)" ]]; then
        SERVICE_BACKEND="openrc"
      elif [[ -d /etc/init.d ]] && (has_command update-rc.d || has_command chkconfig) && has_command runuser && has_command nohup; then
        SERVICE_BACKEND="sysv"
      elif [[ -x /etc/rc.local ]] && has_command runuser && has_command nohup; then
        SERVICE_BACKEND="rc.local"
      elif has_command crontab && (has_command cron || has_command crond) && has_command runuser && has_command nohup; then
        SERVICE_BACKEND="cron"
      else
        SERVICE_BACKEND="none"
      fi
      ;;
    systemd|openrc|sysv|rc.local|cron|none)
      SERVICE_BACKEND="${requested}"
      ;;
    *) die "SERVICE_MODE 无效：${SERVICE_MODE}（可选 auto、systemd、openrc、sysv、rc.local、cron、none）" ;;
  esac

  case "${SERVICE_BACKEND}" in
    systemd)
      has_command systemctl && [[ -d /run/systemd/system ]] || die "当前系统不是 systemd；请使用 SERVICE_MODE=auto 或选择其他模式"
      ;;
    openrc)
      has_command rc-service && has_command rc-update || die "未找到 OpenRC 的 rc-service/rc-update"
      ;;
    sysv)
      [[ -d /etc/init.d ]] && (has_command update-rc.d || has_command chkconfig) && has_command runuser && has_command nohup || die "未找到 SysV init 所需的 /etc/init.d、update-rc.d/chkconfig、runuser 或 nohup"
      ;;
    rc.local)
      [[ -x /etc/rc.local ]] && has_command runuser && has_command nohup || die "未找到可执行的 /etc/rc.local、runuser 或 nohup"
      ;;
    cron)
      has_command crontab && (has_command cron || has_command crond) && has_command runuser && has_command nohup || die "未找到 crontab、cron/crond、runuser 或 nohup"
      ;;
    none)
      warn "系统没有可用的开机自启机制，将使用 PM2 保持节点运行；重启后仍需要 init/cron 才能自动启动"
      ;;
  esac

  if [[ "${SERVICE_BACKEND}" = "none" ]]; then
    warn "未配置开机自启；安装完成后会立即后台运行，日志写入 ${FILE_PATH}/nodejs-argo.log"
  else
    log "启动方式：${SERVICE_BACKEND}"
  fi
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
  run_as_service_user env HOME="${APP_DIR}/home" NPM_CONFIG_CACHE="${APP_DIR}/npm-cache" \
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

write_runner_script() {
  cat > "${RUNNER_SCRIPT}" <<EOF
#!${BASH_BIN}
set -u

ENV_FILE="${ENV_FILE}"
NODE_BIN="${NODE_BIN}"
APP_DIR="${APP_DIR}"
LOG_FILE="${FILE_PATH}/nodejs-argo.log"
child_pid=""

stop_runner() {
  if [[ -n "\${child_pid}" ]] && kill -0 "\${child_pid}" >/dev/null 2>&1; then
    kill -TERM "\${child_pid}" >/dev/null 2>&1 || true
    wait "\${child_pid}" >/dev/null 2>&1 || true
  fi
  exit 143
}

trap stop_runner TERM INT
set -a
. "\${ENV_FILE}"
set +a

while true; do
  "\${NODE_BIN}" "\${APP_DIR}/app/index.js" >>"\${LOG_FILE}" 2>&1 &
  child_pid="\$!"
  wait "\${child_pid}"
  status="\$?"
  child_pid=""
  printf '[runner] node exited with code %s; restarting in 10 seconds\\n' "\${status}" >>"\${LOG_FILE}"
  sleep 10
done
EOF
  chown "${SERVICE_USER}:${SERVICE_USER}" "${RUNNER_SCRIPT}"
  chmod 0750 "${RUNNER_SCRIPT}"
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
ReadWritePaths=${FILE_PATH} ${BIN_PATH} ${APP_DIR}/home ${APP_DIR}/npm-cache
UMask=0077
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${SERVICE_FILE}"
}

write_openrc_service() {
  SERVICE_FILE="/etc/init.d/${SERVICE_NAME}"
  cat > "${SERVICE_FILE}" <<EOF
#!/sbin/openrc-run
name="nodejs-argo no-Docker node"
description="nodejs-argo no-Docker node"
command="${RUNNER_SCRIPT}"
command_user="${SERVICE_USER}:${SERVICE_USER}"
command_background=true
pidfile="/run/${SERVICE_NAME}.pid"

depend() {
  need net
  after firewall
}
EOF
  chmod 0755 "${SERVICE_FILE}"
}

write_sysv_service() {
  SERVICE_FILE="/etc/init.d/${SERVICE_NAME}"
  cat > "${SERVICE_FILE}" <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          ${SERVICE_NAME}
# Required-Start:    \$remote_fs \$network
# Required-Stop:     \$remote_fs \$network
# Should-Start:      \$named
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
### END INIT INFO

DAEMON="${RUNNER_SCRIPT}"
RUNUSER="${RUNUSER_BIN}"
SERVICE_USER="${SERVICE_USER}"
PIDFILE="/run/${SERVICE_NAME}.pid"

is_running() {
  [ -f "\${PIDFILE}" ] || return 1
  pid="\$(cat "\${PIDFILE}" 2>/dev/null || true)"
  [ "\${pid}" -gt 1 ] 2>/dev/null || return 1
  kill -0 "\${pid}" 2>/dev/null
}

start() {
  is_running && return 0
  nohup "\${RUNUSER}" -u "\${SERVICE_USER}" -- "\${DAEMON}" >/dev/null 2>&1 &
  echo "\$!" >"\${PIDFILE}"
}

stop() {
  if is_running; then
    kill "\$(cat "\${PIDFILE}")" 2>/dev/null || true
  fi
  rm -f "\${PIDFILE}"
}

status() {
  if is_running; then
    echo "${SERVICE_NAME} is running"
    return 0
  fi
  echo "${SERVICE_NAME} is not running"
  return 3
}

case "\$1" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "Usage: \$0 {start|stop|restart|status}"; exit 2 ;;
esac
EOF
  chmod 0755 "${SERVICE_FILE}"
}

start_background_runner() {
  if [[ -n "${RUNUSER_BIN}" ]]; then
    nohup "${RUNUSER_BIN}" -u "${SERVICE_USER}" -- "${RUNNER_SCRIPT}" >/dev/null 2>&1 &
  else
    nohup "${SU_BIN}" -s "${BASH_BIN}" -c 'exec "$@"' "${SERVICE_USER}" -- "${RUNNER_SCRIPT}" >/dev/null 2>&1 &
  fi
  printf '%s\n' "$!" >"${PID_FILE}"
}

stop_background_runner() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ "${pid}" =~ ^[0-9]+$ ]] && (( pid > 1 )); then
      kill "${pid}" >/dev/null 2>&1 || true
    fi
    rm -f -- "${PID_FILE}"
  fi
}

prepare_pm2_paths() {
  PM2_DIR="${APP_DIR}/pm2"
  PM2_HOME_DIR="${APP_DIR}/pm2-home"
  PM2_BIN="${PM2_DIR}/node_modules/.bin/pm2"
}

validate_pm2_version() {
  local version="${PM2_VERSION#v}"
  [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "PM2_VERSION 必须是三段版本号，例如 5.4.3"
  PM2_VERSION="${version}"
}

stop_pm2_service() {
  prepare_pm2_paths
  if [[ ! -x "${PM2_BIN}" ]]; then
    return 0
  fi

  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    "${PM2_BIN}" delete "${SERVICE_NAME}" >/dev/null 2>&1 || true
  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    "${PM2_BIN}" kill >/dev/null 2>&1 || true
}

start_pm2_service() {
  validate_pm2_version
  prepare_pm2_paths
  install -d -m 0700 "${PM2_DIR}" "${PM2_HOME_DIR}"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${PM2_DIR}" "${PM2_HOME_DIR}"

  log "未检测到可用 init/cron，安装 PM2 ${PM2_VERSION} 作为最后的进程守护"
  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    NPM_CONFIG_CACHE="${APP_DIR}/npm-cache" \
    "${NPM_BIN}" --prefix "${PM2_DIR}" install "pm2@${PM2_VERSION}" \
      --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false

  [[ -x "${PM2_BIN}" ]] || die "PM2 安装完成但未找到可执行文件：${PM2_BIN}"

  set -a
  . "${ENV_FILE}"
  set +a
  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    "${PM2_BIN}" start "${APP_DIR}/app/index.js" \
      --name "${SERVICE_NAME}" \
      --cwd "${APP_DIR}/app" \
      --instances 1 \
      --restart-delay 10000 \
      --time \
      --update-env
  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    "${PM2_BIN}" save --force

  log "PM2 已启动单实例 Node 服务；ARGO 网关端口保持 ${ARGO_PORT}，HTTP 端口保持 ${SERVER_PORT}"
  log "当前无可靠开机自启机制，重启后仍需通过 init/cron 或手动启动 PM2"
}

process_command() {
  local pid="$1"
  if has_command ps; then
    ps -p "${pid}" -o args= 2>/dev/null || true
  elif [[ -r "/proc/${pid}/cmdline" ]]; then
    tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true
  fi
}

port_owner_pids() {
  local port="$1"
  ss -lntpH 2>/dev/null |
    awk -v port=":${port}" 'index($4, port) > 0 { print }' |
    grep -oE 'pid=[0-9]+' |
    cut -d= -f2 |
    sort -u
}

terminate_pid() {
  local pid="$1"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 0
  (( pid > 1 )) || return 0

  kill -TERM "${pid}" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "${pid}" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  kill -KILL "${pid}" >/dev/null 2>&1 || true
}

validate_local_port() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} 必须是数字端口：${value}"
  (( value >= 1 && value <= 65535 )) || die "${name} 端口范围无效：${value}"
}

cleanup_owned_port_processes() {
  local ports=()
  local port
  local pid
  local command
  local seen=" "

  for port in "${SERVER_PORT}" "${ARGO_PORT}" 3001 3002 3003 3004; do
    [[ "${seen}" == *" ${port} "* ]] && continue
    seen+="${port} "
    ports+=("${port}")
  done

  for port in "${ports[@]}"; do
    while read -r pid; do
      [[ -n "${pid}" ]] || continue
      command="$(process_command "${pid}")"
      if [[ "${command}" == *"${APP_DIR}"* ]]; then
        warn "停止旧安装进程：PID ${pid}，端口 ${port}"
        terminate_pid "${pid}"
      elif is_true "${FORCE_KILL_PORTS}"; then
        warn "FORCE_KILL_PORTS=true，将停止端口 ${port} 的非本项目进程：PID ${pid}（${command}）"
        terminate_pid "${pid}"
      else
        die "端口 ${port} 被其他程序占用（PID ${pid}：${command}）；为避免误杀，请先停止它，或明确设置 FORCE_KILL_PORTS=true"
      fi
    done < <(port_owner_pids "${port}")
  done
}

write_rc_local_service() {
  local marker="# nodejs-argo-no-docker: ${SERVICE_NAME}"
  local line="${RUNUSER_BIN} -u ${SERVICE_USER} -- ${RUNNER_SCRIPT} >/dev/null 2>&1 & ${marker}"
  if ! grep -Fq "${marker}" /etc/rc.local 2>/dev/null; then
    local rc_local_tmp="${APP_DIR}.rc.local.tmp"
    awk -v line="${line}" -v marker="${marker}" '
      index($0, marker) { found=1 }
      !found && $0 ~ /^[[:space:]]*exit[[:space:]]+0[[:space:]]*$/ { print line; found=1 }
      { print }
      END { if (!found) print line }
    ' /etc/rc.local >"${rc_local_tmp}"
    install -m 0755 "${rc_local_tmp}" /etc/rc.local
    rm -f -- "${rc_local_tmp}"
  fi
  chmod 0755 /etc/rc.local
}

write_cron_service() {
  local marker="# nodejs-argo-no-docker: ${SERVICE_NAME}"
  local line="@reboot ${RUNUSER_BIN} -u ${SERVICE_USER} -- ${RUNNER_SCRIPT} ${marker}"
  local current_cron
  current_cron="$(crontab -l 2>/dev/null || true)"
  if [[ "${current_cron}" != *"${marker}"* ]]; then
    {
      [[ -n "${current_cron}" ]] && printf '%s\n' "${current_cron}"
      printf '%s\n' "${line}"
    } | crontab -
  fi
}

start_service() {
  stop_background_runner
  stop_pm2_service

  case "${SERVICE_BACKEND}" in
    systemd)
      SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
      write_systemd_unit
      systemctl daemon-reload
      systemctl enable --now "${SERVICE_NAME}.service"
      ;;
    openrc)
      write_openrc_service
      rc-update add "${SERVICE_NAME}" default >/dev/null 2>&1 || true
      rc-service "${SERVICE_NAME}" start
      ;;
    sysv)
      write_sysv_service
      if has_command update-rc.d; then
        update-rc.d "${SERVICE_NAME}" defaults >/dev/null 2>&1 || true
      elif has_command chkconfig; then
        chkconfig --add "${SERVICE_NAME}" >/dev/null 2>&1 || true
        chkconfig "${SERVICE_NAME}" on >/dev/null 2>&1 || true
      fi
      "${SERVICE_FILE}" start
      ;;
    rc.local)
      write_rc_local_service
      start_background_runner
      ;;
    cron)
      write_cron_service
      start_background_runner
      ;;
    none)
      start_pm2_service
      ;;
  esac
}

uninstall() {
  require_root
  validate_app_dir
  prepare_user_switch

  if has_command systemctl; then
    systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f -- "/etc/systemd/system/${SERVICE_NAME}.service"

  if [[ -x "/etc/init.d/${SERVICE_NAME}" ]]; then
    if has_command rc-service; then
      rc-service "${SERVICE_NAME}" stop >/dev/null 2>&1 || true
      has_command rc-update && rc-update del "${SERVICE_NAME}" default >/dev/null 2>&1 || true
    else
      "/etc/init.d/${SERVICE_NAME}" stop >/dev/null 2>&1 || true
      has_command update-rc.d && update-rc.d -f "${SERVICE_NAME}" remove >/dev/null 2>&1 || true
      has_command chkconfig && chkconfig --del "${SERVICE_NAME}" >/dev/null 2>&1 || true
    fi
    rm -f -- "/etc/init.d/${SERVICE_NAME}"
  fi

  stop_background_runner
  stop_pm2_service

  if has_command crontab; then
    local current_cron
    local marker="# nodejs-argo-no-docker: ${SERVICE_NAME}"
    current_cron="$(crontab -l 2>/dev/null || true)"
    if [[ "${current_cron}" == *"${marker}"* ]]; then
      printf '%s\n' "${current_cron}" | grep -vF -- "${marker}" | crontab - || true
    fi
  fi

  if [[ -f /etc/rc.local ]]; then
    local rc_local_tmp="${APP_DIR}.rc.local.tmp"
    grep -vF -- "# nodejs-argo-no-docker: ${SERVICE_NAME}" /etc/rc.local >"${rc_local_tmp}" || true
    install -m 0755 "${rc_local_tmp}" /etc/rc.local
    rm -f -- "${rc_local_tmp}"
  fi

  rm -rf -- "${APP_DIR}"
  log "已卸载：${APP_DIR} 和 ${SERVICE_NAME} 的启动配置"
}

clean_previous_installation() {
  log "清理旧安装、旧服务和旧进程：${APP_DIR}"
  uninstall
  cleanup_owned_port_processes
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --uninstall) UNINSTALL=true ;;
      --dry-run) DRY_RUN=true ;;
      --app-dir) [[ $# -ge 2 ]] || die "--app-dir 缺少值"; APP_DIR="$2"; shift ;;
      --service-name) [[ $# -ge 2 ]] || die "--service-name 缺少值"; SERVICE_NAME="$2"; shift ;;
      --service-mode) [[ $# -ge 2 ]] || die "--service-mode 缺少值"; SERVICE_MODE="$2"; shift ;;
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
  validate_worker_placeholders
  check_dependencies
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
  generate_uuid_if_missing
  BIN_PATH="${BIN_PATH:-${APP_DIR}/bin}"
  FILE_PATH="${FILE_PATH:-${APP_DIR}/data}"
  validate_local_port "SERVER_PORT" "${SERVER_PORT}"
  validate_local_port "ARGO_PORT" "${ARGO_PORT}"
  validate_runtime_paths
  ENV_FILE="${APP_DIR}/.env"
  RUNNER_SCRIPT="${APP_DIR}/run.sh"
  PID_FILE="${APP_DIR}/service.pid"
  prepare_pm2_paths
  detect_service_backend

  if is_true "${DRY_RUN}"; then
    log "dry-run 检查通过：Node.js $(node --version)，启动方式：${SERVICE_BACKEND}"
    return 0
  fi

  clean_previous_installation

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf -- "${TMP_DIR}"' EXIT

  install -d -m 0750 "${APP_DIR}" "${APP_DIR}/app" "${BIN_PATH}" "${FILE_PATH}"
  create_service_user

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
  write_runner_script
  start_service

  log "安装完成"
  case "${SERVICE_BACKEND}" in
    systemd) log "查看日志：journalctl -u ${SERVICE_NAME}.service -f" ;;
    openrc|sysv) log "查看日志：tail -f ${FILE_PATH}/nodejs-argo.log" ;;
    rc.local|cron) log "查看日志：tail -f ${FILE_PATH}/nodejs-argo.log" ;;
    none) log "查看 PM2：${PM2_BIN} status；查看日志：${PM2_BIN} logs ${SERVICE_NAME}" ;;
  esac
  log "TeamNode：${TEAMNODE_SYNC_BASE_URL}"
}

main "$@"
