#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_NAME="nodejs-argo-no-docker-installer"
readonly DEFAULT_ROOT_APP_DIR="/opt/nodejs-argo-no-docker"
readonly DEFAULT_SERVICE_NAME="nodejs-argo-no-docker"
readonly DEFAULT_SOURCE_BASE_URL="__WORKER_SOURCE_BASE_URL__"
readonly DEFAULT_INDEX_SHA256="__WORKER_SOURCE_SHA256__"
readonly DEFAULT_TEAMNODE_SYNC_BASE_URL="__WORKER_SYNC_BASE_URL__"

readonly DEFAULT_CLOUDFLARED_VERSION="latest"
readonly CLOUDFLARED_RELEASE_PAGE="https://github.com/cloudflare/cloudflared/releases"
readonly DEFAULT_XRAY_VERSION="v26.3.27"
readonly DEFAULT_PM2_VERSION="5.4.3"
readonly CLOUDFLARED_TUNNEL_PORT="7844"
# Keep the fallback runtime inside this installation directory.  It is only
# used when the host's Node.js is missing or older than the application's
# minimum, so other applications can continue using their own Node.js.
readonly DEFAULT_NODE_RUNTIME_VERSION="20.20.2"

APP_DIR="${APP_DIR:-}"
SERVICE_NAME="${SERVICE_NAME:-${DEFAULT_SERVICE_NAME}}"
SERVICE_USER="${SERVICE_USER:-}"
SERVICE_MODE="${SERVICE_MODE:-auto}"
SUPERVISOR_CONF_DIR="${SUPERVISOR_CONF_DIR:-}"
SOURCE_BASE_URL="${SOURCE_BASE_URL:-${DEFAULT_SOURCE_BASE_URL}}"
# Resolve this after command-line parsing so empty values from wrappers cannot
# accidentally override the checksum injected by the Worker.
SOURCE_INDEX_SHA256="${SOURCE_INDEX_SHA256-}"

CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-${DEFAULT_CLOUDFLARED_VERSION}}"
XRAY_VERSION="${XRAY_VERSION:-${DEFAULT_XRAY_VERSION}}"
PM2_VERSION="${PM2_VERSION:-${DEFAULT_PM2_VERSION}}"
NODE_RUNTIME_VERSION="${NODE_RUNTIME_VERSION:-${DEFAULT_NODE_RUNTIME_VERSION}}"
NODE_RUNTIME_SHA256="${NODE_RUNTIME_SHA256:-}"
REQUIRE_CHECKSUMS="${REQUIRE_CHECKSUMS:-true}"
FORCE_KILL_PORTS="${FORCE_KILL_PORTS:-false}"
AUTO_CONFIGURE_FIREWALL="${AUTO_CONFIGURE_FIREWALL:-true}"

TEAMNODE_SYNC_BASE_URL="${TEAMNODE_SYNC_BASE_URL:-${DEFAULT_TEAMNODE_SYNC_BASE_URL}}"
TEAMNODE_SYNC_KEY_ID="${TEAMNODE_SYNC_KEY_ID:-nodejs-argo-prod}"
TEAMNODE_SYNC_SECRET="${TEAMNODE_SYNC_SECRET:-}"
TEAMNODE_SYNC_RELAY_TOKEN="${TEAMNODE_SYNC_RELAY_TOKEN:-}"
TEAMNODE_SYNC_ENROLL_PASSWORD="${TEAMNODE_SYNC_ENROLL_PASSWORD:-}"
TEAMNODE_SYNC_GROUP_KEY="${TEAMNODE_SYNC_GROUP_KEY:-basic}"
TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS="${TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS:-300000}"
TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS="${TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS:-15000}"
TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT="${TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT:-true}"
TEAMNODE_SYNC_TIMEOUT_MS="${TEAMNODE_SYNC_TIMEOUT_MS:-10000}"
TEAMNODE_SYNC_ENABLED="${TEAMNODE_SYNC_ENABLED:-true}"
CLOUDFLARE_API_KEY="${CLOUDFLARE_API_KEY:-}"
AUTO_DIRECT_FALLBACK="${AUTO_DIRECT_FALLBACK:-true}"
DIRECT_MODE="${DIRECT_MODE:-false}"
DIRECT_TLS_ENABLED="${DIRECT_TLS_ENABLED:-true}"
DIRECT_PORT="${DIRECT_PORT:-443}"
DIRECT_HTTP_PORT="${DIRECT_HTTP_PORT:-80}"
DIRECT_PORT_CANDIDATES="${DIRECT_PORT_CANDIDATES:-80,443,8080,8443,8880,2053,2083,2087,2096}"
DIRECT_PORT_SCAN_PORTS="${DIRECT_PORT_SCAN_PORTS:-8000,8008,8081,8088,8090,8181,8444,8888,9000,9443,10000,11550-11570,20000,30000,40000,50000,60000}"
DIRECT_PORT_SCAN_RANGE="${DIRECT_PORT_SCAN_RANGE:-1024-65535}"
DIRECT_PORT_SCAN_MAX="${DIRECT_PORT_SCAN_MAX:-256}"
CF_DNS_ENABLED="${CF_DNS_ENABLED:-false}"
CF_DNS_RECORD_NAME="${CF_DNS_RECORD_NAME:-}"
CF_DNS_ZONE_ID="${CF_DNS_ZONE_ID:-}"
CF_DNS_ZONE_NAME="${CF_DNS_ZONE_NAME:-}"
CF_DNS_PUBLIC_IP="${CF_DNS_PUBLIC_IP:-}"
CF_DNS_TTL="${CF_DNS_TTL:-120}"
CF_DNS_REPLACE_CNAME="${CF_DNS_REPLACE_CNAME:-true}"

ARGO_PORT="${ARGO_PORT:-8001}"
CFPORT="${CFPORT:-443}"
SERVER_PORT="${SERVER_PORT:-3000}"
CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
FILE_PATH="${FILE_PATH:-}"
BIN_PATH="${BIN_PATH:-}"

SERVICE_BACKEND=""
NODE_BIN=""
NPM_BIN=""
NODE_RUNTIME_DIR=""
SYSTEM_NODE_MAJOR=""
BASH_BIN=""
RUNUSER_BIN=""
SU_BIN=""
ENV_FILE=""
SERVICE_FILE=""
SUPERVISOR_CONFIG_FILE="${SUPERVISOR_CONFIG_FILE:-}"
SUPERVISOR_CONF_FILE=""
RUNNER_SCRIPT=""
PID_FILE=""
PM2_DIR=""
PM2_HOME_DIR=""
PM2_BIN=""
RUN_AS_ROOT=false
CURRENT_USER=""
CURRENT_USER_HOME=""
TMP_DIR=""
TUNNEL_FIREWALL_PROTOCOLS=()
TUNNEL_FIREWALL_PROTOCOL_LABEL=""
STAGE_CURRENT=0
readonly STAGE_TOTAL=10

UNINSTALL=false
DRY_RUN=false

log() { printf '[%s] %s\n' "${SCRIPT_NAME}" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "${SCRIPT_NAME}" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "${SCRIPT_NAME}" "$*" >&2; exit 1; }
stage() {
  STAGE_CURRENT=$((STAGE_CURRENT + 1))
  log "阶段 ${STAGE_CURRENT}/${STAGE_TOTAL}：$*"
}

usage() {
  cat <<'USAGE'
用法：
  install.sh                         安装或更新无 Docker 节点
  install.sh --uninstall              卸载本安装器创建的服务和目录
  install.sh --dry-run                只检查环境，不写入系统
  install.sh --app-dir /opt/example   覆盖安装目录（root；非 root 必须位于当前用户目录）
  install.sh --service-mode auto      自动选择 systemd/OpenRC/SysV/Supervisor/cron

ARGO_AUTH、ARGO_DOMAIN 通过环境变量传入，不写入脚本。
默认使用 Worker 代理 TeamNode；客户端不保存 TEAMNODE_SYNC_SECRET。可直接设置 TEAMNODE_SYNC_RELAY_TOKEN，或安装时输入兑换密码自动获取。
如果未设置 TEAMNODE_SYNC_RELAY_TOKEN，安装时会交互式询问兑换密码，从 Worker 获取中继令牌；兑换密码不会写入 .env。
如明确直连 TeamNode，才设置 TEAMNODE_SYNC_BASE_URL 和 TEAMNODE_SYNC_SECRET。
UUID 可选；新机器未设置时会随机生成。覆盖已有安装且未设置 UUID 时，会优先复用旧 `.env` 中的 UUID。

SERVICE_MODE 可选：auto、systemd、openrc、sysv、supervisor、rc.local、cron、none。
auto 模式没有可用 init/cron 时，会安装固定版本 PM2 作为最后的进程守护。
如果系统 Node.js 低于 14，安装器只在 APP_DIR/node-runtime 内安装 Node.js 20.20.2，不会替换系统 Node.js；可用 NODE_RUNTIME_VERSION 覆盖版本。
CLOUDFLARED_PROTOCOL 可选 http2、quic、auto，默认 http2；安装器会按协议自动配置出站 Tunnel 端口 7844。
AUTO_CONFIGURE_FIREWALL=true 时，root 安装会尝试在已启用的 ufw、firewalld、nftables 或 iptables 中幂等放行对应协议的出站 7844；设为 false 可关闭。
AUTO_DIRECT_FALLBACK=true 时，安装器会准备 Nginx（以及可用时的 Certbot）；节点启动后先验证 Cloudflare Tunnel 7844 出站心跳和最终域名心跳，Tunnel 不可用时再由 Worker 从公网进行直连端口发现心跳，443+80 都可达时申请 Let's Encrypt，否则使用发现到的 HTTP 端口。
候选端口全部失败后，会按 DIRECT_PORT_SCAN_PORTS 和 DIRECT_PORT_SCAN_RANGE 扩展进行端口发现；DIRECT_PORT_SCAN_MAX 默认 256，避免一次性检查全部端口。
Tunnel 和直连都没有可用路线时，节点会写入 `.no-route` 标记并以退出码 78 停止，systemd、Supervisor 和 PM2 不会继续反复拉起；修复云安全组/上游网络后重新运行安装器即可清除标记并重新探测。
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
  if [[ "${RUN_AS_ROOT}" != true ]]; then
    case "${APP_DIR}" in
      "${CURRENT_USER_HOME}"/*) ;;
      *) die "非 root 安装只能使用当前用户目录下的 APP_DIR：${CURRENT_USER_HOME}/..." ;;
    esac
  fi
}

validate_runtime_paths() {
  [[ "${FILE_PATH}" = /* ]] || die "FILE_PATH 必须是绝对路径"
  [[ "${BIN_PATH}" = /* ]] || die "BIN_PATH 必须是绝对路径"
  [[ "${FILE_PATH}" != *$'\n'* && "${FILE_PATH}" != *$'\r'* && "${FILE_PATH}" != *' '* ]] || die "FILE_PATH 不得包含空格或换行"
  [[ "${BIN_PATH}" != *$'\n'* && "${BIN_PATH}" != *$'\r'* && "${BIN_PATH}" != *' '* ]] || die "BIN_PATH 不得包含空格或换行"
  if [[ "${RUN_AS_ROOT}" != true ]]; then
    case "${BIN_PATH}" in
      "${APP_DIR}"/*) ;;
      *) die "非 root 安装的 BIN_PATH 必须位于 APP_DIR 内：${APP_DIR}/..." ;;
    esac
    case "${FILE_PATH}" in
      "${APP_DIR}"/*) ;;
      *) die "非 root 安装的 FILE_PATH 必须位于 APP_DIR 内：${APP_DIR}/..." ;;
    esac
  fi
}

configure_install_context() {
  CURRENT_USER="$(id -un 2>/dev/null || true)"
  CURRENT_USER_HOME=""
  if command -v getent >/dev/null 2>&1; then
    CURRENT_USER_HOME="$(getent passwd "${CURRENT_USER}" | cut -d: -f6)"
  fi
  CURRENT_USER_HOME="${CURRENT_USER_HOME:-${HOME:-}}"
  [[ -n "${CURRENT_USER}" && -n "${CURRENT_USER_HOME}" ]] || die "无法确定当前用户和用户目录"

  if [[ "${EUID}" -eq 0 ]]; then
    RUN_AS_ROOT=true
    APP_DIR="${APP_DIR:-${DEFAULT_ROOT_APP_DIR}}"
    SERVICE_USER="${SERVICE_USER:-nodejs-argo}"
    return 0
  fi

  RUN_AS_ROOT=false
  APP_DIR="${APP_DIR:-${CURRENT_USER_HOME}/.local/share/nodejs-argo-no-docker}"
  SERVICE_USER="${SERVICE_USER:-${CURRENT_USER}}"
  [[ "${SERVICE_USER}" == "${CURRENT_USER}" ]] || die "非 root 安装只能使用当前用户运行：${CURRENT_USER}"
  warn "当前不是 root，将使用当前用户 ${CURRENT_USER} 安装到 ${APP_DIR}；不会写入 /opt、/etc 或系统服务。"
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || return 0
}

require_config() {
  [[ -n "${ARGO_DOMAIN:-}" ]] || die "必须设置 ARGO_DOMAIN"
  [[ -n "${ARGO_AUTH:-}" ]] || die "必须设置 ARGO_AUTH"
  if is_true "${TEAMNODE_SYNC_ENABLED}"; then
    if [[ -n "${TEAMNODE_SYNC_SECRET}" && -n "${TEAMNODE_SYNC_RELAY_TOKEN}" ]]; then
      die "不要同时设置 TEAMNODE_SYNC_SECRET 和 TEAMNODE_SYNC_RELAY_TOKEN；Worker 代理模式只设置中继令牌"
    fi
    if [[ -n "${TEAMNODE_SYNC_SECRET}" && "${TEAMNODE_SYNC_BASE_URL}" == "${DEFAULT_TEAMNODE_SYNC_BASE_URL}" ]]; then
      die "直连 TeamNode 时必须同时设置 TEAMNODE_SYNC_BASE_URL；不要把主密钥发送到 Worker"
    fi
  fi
}

validate_uuid() {
  [[ "${UUID}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || die "UUID 格式无效：${UUID}"
}

restore_existing_uuid_if_missing() {
  # Preserve the node identity during an in-place upgrade. A new machine has
  # no .env yet, so it receives a newly generated UUID before token exchange.
  if [[ -n "${UUID:-}" ]]; then
    return 0
  fi

  local previous_env="${APP_DIR}/.env"
  [[ -r "${previous_env}" ]] || return 0

  local previous_uuid
  previous_uuid="$(sed -n 's/^UUID=//p' "${previous_env}" 2>/dev/null | head -n 1 || true)"
  if [[ -z "${previous_uuid}" ]]; then
    return 0
  fi

  if [[ "${previous_uuid}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    UUID="${previous_uuid}"
    log "未指定 UUID，已从旧安装 .env 复用 UUID：${UUID}"
  else
    warn "旧安装 .env 中的 UUID 格式无效，将生成新的 UUID"
  fi
}

resolve_source_checksum() {
  # Some wrappers forward SOURCE_INDEX_SHA256='' or the literal string "".
  # Treat those values as unset so the checksum injected by the Worker is used.
  # A custom source still has to provide its own real checksum below.
  if [[ -z "${SOURCE_INDEX_SHA256:-}" || "${SOURCE_INDEX_SHA256}" == '""' || "${SOURCE_INDEX_SHA256}" == "''" ]]; then
    SOURCE_INDEX_SHA256="${DEFAULT_INDEX_SHA256}"
  fi
}

generate_uuid_if_missing() {
  if [[ -n "${UUID:-}" ]]; then
    validate_uuid
    return 0
  fi

  local generated=""
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    generated="$("${NODE_BIN}" -e '
    const crypto = require("crypto");
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    process.stdout.write(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  ' 2>/dev/null || true)"
  fi

  if [[ ! "${generated}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    if [[ -r /proc/sys/kernel/random/uuid ]]; then
      generated="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)"
    elif has_command uuidgen; then
      generated="$(uuidgen 2>/dev/null || true)"
    elif has_command openssl; then
      local random_hex=""
      random_hex="$(openssl rand -hex 16 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ "${random_hex}" =~ ^[0-9a-fA-F]{32}$ ]]; then
        random_hex="${random_hex,,}"
        random_hex="${random_hex:0:12}4${random_hex:13}"
        random_hex="${random_hex:0:16}8${random_hex:17}"
        generated="${random_hex:0:8}-${random_hex:8:4}-${random_hex:12:4}-${random_hex:16:4}-${random_hex:20:12}"
      fi
    fi
  fi

  UUID="${generated}"
  [[ -n "${UUID}" ]] || die "无法随机生成 UUID"
  validate_uuid
  log "未设置 UUID，已随机生成：${UUID}（将保存到 .env）"
}

validate_worker_placeholders() {
  # Keep the sentinels split in the source. The Worker replaces its
  # placeholders globally, so writing the complete sentinel here would make
  # the validation check compare the resolved value with itself.
  local source_placeholder='__WORKER''_SOURCE_BASE_URL__'
  local checksum_placeholder='__WORKER''_SOURCE_SHA256__'
  local sync_placeholder='__WORKER''_SYNC_BASE_URL__'

  [[ "${SOURCE_BASE_URL}" != "${source_placeholder}" ]] || die "安装脚本源码地址占位符未替换；请从 https://install.lemon.vin/install.sh 下载"
  [[ "${SOURCE_INDEX_SHA256}" != "${checksum_placeholder}" ]] || die "安装脚本源码 SHA256 占位符未替换；请从 Worker 地址下载，不要直接使用 GitHub 原始 install.sh"
  [[ "${SOURCE_INDEX_SHA256}" =~ ^[0-9a-fA-F]{64}$ ]] || die "SOURCE_INDEX_SHA256 必须是 64 位十六进制值；默认应由 Worker 自动注入，使用自定义源码时请设置真实 SHA256"
  if [[ "${TEAMNODE_SYNC_BASE_URL}" == "${sync_placeholder}" ]]; then
    die "TeamNode Worker 地址占位符未替换；请从 Worker 地址下载，不要直接使用 GitHub 原始 install.sh"
  fi
}

has_command() { command -v "$1" >/dev/null 2>&1; }

resolve_supervisor_config() {
  local config
  if [[ -n "${SUPERVISOR_CONFIG_FILE:-}" && -f "${SUPERVISOR_CONFIG_FILE}" ]]; then
    printf '%s\n' "${SUPERVISOR_CONFIG_FILE}"
    return 0
  fi
  for config in /etc/supervisor/supervisord.conf /etc/supervisord.conf; do
    if [[ -f "${config}" ]]; then
      printf '%s\n' "${config}"
      return 0
    fi
  done
  return 1
}

resolve_supervisor_conf_dir() {
  if [[ -n "${SUPERVISOR_CONF_DIR}" && -d "${SUPERVISOR_CONF_DIR}" ]]; then
    printf '%s\n' "${SUPERVISOR_CONF_DIR}"
    return 0
  fi
  for directory in /etc/supervisor/conf.d /etc/supervisord.d; do
    if [[ -d "${directory}" ]]; then
      printf '%s\n' "${directory}"
      return 0
    fi
  done
  return 1
}

supervisorctl_exec() {
  local config_file
  config_file="$(resolve_supervisor_config 2>/dev/null || true)"
  if [[ -n "${config_file}" ]]; then
    supervisorctl -c "${config_file}" "$@"
  else
    supervisorctl "$@"
  fi
}

install_os_dependencies() {
  if [[ "${RUN_AS_ROOT}" != true ]]; then
    warn "非 root 安装不会修改系统软件包；将使用当前用户目录内的项目专用 Node.js。"
    return 0
  fi
  log "安装基础依赖：bash、curl、ca-certificates、unzip、tar、Node.js、npm"
  if has_command apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq bash ca-certificates curl coreutils iproute2 passwd tar xz-utils unzip util-linux nodejs npm >/dev/null
  elif has_command apk; then
    apk add --no-cache bash ca-certificates curl coreutils iproute2 tar xz unzip util-linux nodejs npm >/dev/null
  elif has_command dnf; then
    dnf install -y bash ca-certificates curl coreutils iproute tar xz unzip util-linux nodejs npm shadow-utils >/dev/null
  elif has_command yum; then
    yum install -y bash ca-certificates curl coreutils iproute tar xz unzip util-linux nodejs npm shadow-utils >/dev/null
  elif has_command zypper; then
    zypper --non-interactive install bash ca-certificates curl coreutils iproute2 tar xz unzip util-linux nodejs npm >/dev/null
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

  if [[ "${RUN_AS_ROOT}" != true ]]; then
    return 0
  fi

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
  if [[ "${RUN_AS_ROOT}" != true ]]; then
    "$@"
    return 0
  fi
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
  [[ "${RUN_AS_ROOT}" == true ]] || return 0
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
  if ! has_command bash || ! has_command curl || ! has_command sha256sum || ! has_command ss || ! has_command tar || ! has_command unzip || ! has_command nohup || ([[ "${RUN_AS_ROOT}" == true ]] && (! has_command node || ! has_command npm || ! can_run_as_service_user)); then
    is_true "${DRY_RUN}" && die "缺少依赖（dry-run 不会安装依赖）"
    install_os_dependencies
  fi

  has_command bash || die "未找到 bash"
  if [[ "${RUN_AS_ROOT}" == true ]]; then
    has_command node || die "未找到 node"
    has_command npm || die "未找到 npm"
  fi
  has_command sha256sum || die "未找到 sha256sum"
  has_command ss || die "未找到 ss，无法安全检测端口占用"
  has_command tar || die "未找到 tar，无法安装项目专用 Node.js"
  has_command unzip || die "未找到 unzip"
  prepare_user_switch
  install_direct_gateway_dependencies

  NODE_RUNTIME_VERSION="${NODE_RUNTIME_VERSION#v}"
  [[ "${NODE_RUNTIME_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "NODE_RUNTIME_VERSION 必须是三段版本号，例如 20.20.2"

  if has_command node; then
    SYSTEM_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  else
    SYSTEM_NODE_MAJOR="0"
  fi
  [[ "${SYSTEM_NODE_MAJOR}" =~ ^[0-9]+$ ]] || die "无法读取 Node.js 版本"
  if (( SYSTEM_NODE_MAJOR < 14 )); then
    warn "检测到系统 Node.js ${SYSTEM_NODE_MAJOR}；不会升级全局 Node.js，将在本项目目录安装 Node.js ${NODE_RUNTIME_VERSION}"
  fi
}

set_owner() {
  [[ "${RUN_AS_ROOT}" == true ]] || return 0
  chown "$@"
}

ensure_project_node_runtime() {
  if (( SYSTEM_NODE_MAJOR >= 14 )) && has_command npm; then
    log "使用系统 Node.js $(node --version)，不修改其他项目的运行环境"
    return 0
  fi

  if (( SYSTEM_NODE_MAJOR >= 14 )) && ! has_command npm; then
    warn "系统 Node.js ${SYSTEM_NODE_MAJOR} 可用但未找到 npm，将安装项目专用 Node.js ${NODE_RUNTIME_VERSION}"
  fi

  local version="v${NODE_RUNTIME_VERSION}"
  local node_arch
  local asset
  local archive
  local expected_sha256
  local npm_cli

  case "$(uname -m)" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    armv7l|armv7|armhf) node_arch="armv7l" ;;
    ppc64le) node_arch="ppc64le" ;;
    s390x) node_arch="s390x" ;;
    *) die "系统 Node.js 低于 14，且不支持为该架构安装项目专用 Node.js：$(uname -m)" ;;
  esac

  asset="node-${version}-linux-${node_arch}.tar.xz"
  archive="${TMP_DIR}/${asset}"

  log "为本项目安装 Node.js ${version}（系统 Node.js ${SYSTEM_NODE_MAJOR} 保持不变）"
  if [[ -n "${NODE_RUNTIME_SHA256}" ]]; then
    expected_sha256="${NODE_RUNTIME_SHA256}"
  elif [[ "${version}" = "v20.20.2" ]]; then
    # SHA256 values from the official Node.js v20.20.2 SHASUMS256.txt.
    case "${node_arch}" in
      x64) expected_sha256="df770b2a6f130ed8627c9782c988fda9669fa23898329a61a871e32f965e007d" ;;
      arm64) expected_sha256="73093db209e4e9e09dd7d15a47aeaab1b74833830df03efa5f942a1122c5fa71" ;;
      armv7l) expected_sha256="f704ce75d9a194c30c378049b516000e49612c2f046ac83c7435eb33ec2926f0" ;;
      ppc64le) expected_sha256="4ee91307b3b517f880cd63d3f75fc91f4afc926ad9447661b755d50060ba2816" ;;
      s390x) expected_sha256="00590e7e1295d265fd22706e10467c03ecf170873b76c1835ff74b47b90ce6e0" ;;
    esac
  else
    die "NODE_RUNTIME_VERSION=${NODE_RUNTIME_VERSION} 没有内置 SHA256；请同时设置该版本对应的 NODE_RUNTIME_SHA256"
  fi
  [[ "${expected_sha256}" =~ ^[0-9a-fA-F]{64}$ ]] || die "Node.js 项目专用运行时 SHA256 格式无效：${asset}"
  download_verified \
    "https://nodejs.org/dist/${version}/${asset}" \
    "${archive}" "${expected_sha256}" "Node.js ${version}"

  NODE_RUNTIME_DIR="${APP_DIR}/node-runtime"
  rm -rf -- "${NODE_RUNTIME_DIR}"
  install -d -m 0755 "${NODE_RUNTIME_DIR}"
  tar -xJf "${archive}" --strip-components=1 -C "${NODE_RUNTIME_DIR}"

  NODE_BIN="${NODE_RUNTIME_DIR}/bin/node"
  npm_cli="${NODE_RUNTIME_DIR}/lib/node_modules/npm/bin/npm-cli.js"
  [[ -x "${NODE_BIN}" ]] || die "项目专用 Node.js 安装后不可执行：${NODE_BIN}"
  [[ -f "${npm_cli}" ]] || die "项目专用 npm 文件不存在：${npm_cli}"

  # The bundled npm launcher uses /usr/bin/env node.  A wrapper with an
  # absolute Node.js path prevents it from accidentally selecting Node 12.
  NPM_BIN="${NODE_RUNTIME_DIR}/npm"
  cat > "${NPM_BIN}" <<EOF
#!${BASH_BIN}
exec "${NODE_BIN}" "${npm_cli}" "\$@"
EOF
  chmod 0755 "${NPM_BIN}"
  log "项目专用 Node.js 已就绪：$(${NODE_BIN} --version)；系统 Node.js 未被修改"
}

service_node_path() {
  if [[ -n "${NODE_RUNTIME_DIR}" ]]; then
    printf '%s:%s' "${NODE_RUNTIME_DIR}/bin" "${PATH}"
  else
    printf '%s' "${PATH}"
  fi
}

detect_service_backend() {
  local requested="${SERVICE_MODE,,}"
  if [[ "${RUN_AS_ROOT}" != true ]]; then
    if [[ "${requested}" != auto && "${requested}" != none ]]; then
      warn "非 root 安装不写入系统服务，将忽略 SERVICE_MODE=${SERVICE_MODE} 并使用用户级 PM2"
    fi
    SERVICE_BACKEND="none"
    warn "非 root 安装不具备系统级开机自启权限；将使用当前用户目录中的 PM2 保持程序运行"
    return 0
  fi
  case "${requested}" in
    auto)
      if has_command systemctl && [[ -d /run/systemd/system ]]; then
        SERVICE_BACKEND="systemd"
      elif has_command rc-service && has_command rc-update && [[ -x /sbin/openrc-run || -x /usr/sbin/openrc-run || -n "$(command -v openrc-run 2>/dev/null || true)" ]]; then
        SERVICE_BACKEND="openrc"
      elif [[ -d /etc/init.d ]] && (has_command update-rc.d || has_command chkconfig) && has_command runuser && has_command nohup; then
        SERVICE_BACKEND="sysv"
      elif has_command supervisorctl && has_command supervisord && resolve_supervisor_config >/dev/null 2>&1 && resolve_supervisor_conf_dir >/dev/null 2>&1; then
        SERVICE_BACKEND="supervisor"
      elif [[ -x /etc/rc.local ]] && has_command runuser && has_command nohup; then
        SERVICE_BACKEND="rc.local"
      elif has_command crontab && (has_command cron || has_command crond) && has_command runuser && has_command nohup; then
        SERVICE_BACKEND="cron"
      else
        SERVICE_BACKEND="none"
      fi
      ;;
    systemd|openrc|sysv|supervisor|rc.local|cron|none)
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
    supervisor)
      has_command supervisorctl && has_command supervisord || die "未找到 supervisorctl 或 supervisord"
      SUPERVISOR_CONFIG_FILE="$(resolve_supervisor_config 2>/dev/null || true)"
      SUPERVISOR_CONF_DIR="$(resolve_supervisor_conf_dir 2>/dev/null || true)"
      [[ -n "${SUPERVISOR_CONFIG_FILE}" ]] || die "未找到 Supervisor 配置文件；可设置 SUPERVISOR_CONFIG_FILE"
      [[ -n "${SUPERVISOR_CONF_DIR}" ]] || die "未找到 Supervisor 配置目录；可设置 SUPERVISOR_CONF_DIR"
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
  local curl_options=(
    --fail --show-error --location --proto '=https' --tlsv1.2
    --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 300
  )
  if [[ -t 1 && -t 2 && -z "${CI:-}" ]]; then
    curl_options+=(--progress-bar)
  else
    curl_options+=(--silent)
  fi
  curl "${curl_options[@]}" --output "${temporary}" "${url}"

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
  log "完成 ${label}"
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

write_env_value() {
  local key="$1"
  local value="${2-}"
  printf '%s=%q\n' "${key}" "${value}" >> "${ENV_FILE}"
}

redeem_teamnode_relay_token() {
  if ! is_true "${TEAMNODE_SYNC_ENABLED}" || [[ -n "${TEAMNODE_SYNC_SECRET}" || -n "${TEAMNODE_SYNC_RELAY_TOKEN}" ]]; then
    return 0
  fi

  local password="${TEAMNODE_SYNC_ENROLL_PASSWORD:-}"
  if [[ -z "${password}" ]]; then
    if [[ ! -t 0 || ! -t 1 ]]; then
      die "未设置 TEAMNODE_SYNC_RELAY_TOKEN，且当前不是交互终端；请设置 TEAMNODE_SYNC_ENROLL_PASSWORD，或先手动兑换中继令牌"
    fi
    printf '请输入 Worker TeamNode 兑换密码：' >&2
    IFS= read -r -s password
    printf '\n' >&2
  fi
  [[ -n "${password}" ]] || die "兑换密码不能为空"

  local request_file="${TMP_DIR}/teamnode-enroll-request.json"
  local response_file="${TMP_DIR}/teamnode-enroll-response.json"
  printf '%s' "${password}" | TEAMNODE_ENROLL_UUID="${UUID}" "${NODE_BIN}" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(JSON.stringify({
      password: input,
      uuid: process.env.TEAMNODE_ENROLL_UUID,
      includeCloudflareApiKey: true
    })));
  ' >"${request_file}" || die "无法生成 Worker 兑换请求"

  local http_code=""
  local curl_exit=0
  if http_code="$(curl --silent --show-error \
    --connect-timeout 10 --max-time 30 \
    --retry 2 --retry-delay 1 --retry-max-time 45 \
    -X POST \
    -H "Content-Type: application/json" \
    --data-binary "@${request_file}" \
    -o "${response_file}" \
    -w '%{http_code}' \
    "${TEAMNODE_SYNC_BASE_URL%/}/api/teamnode/redeem")"; then
    :
  else
    curl_exit="$?"
    rm -f -- "${request_file}" "${response_file}"
    die "Worker 兑换请求失败（curl exit ${curl_exit}），请检查 Worker 地址和网络连接"
  fi

  if [[ ! "${http_code}" =~ ^2[0-9][0-9]$ ]]; then
    local worker_error
    worker_error="$("${NODE_BIN}" -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(data.error || "").trim().slice(0, 200));
      } catch {}
    ' "${response_file}" 2>/dev/null || true)"
    rm -f -- "${request_file}" "${response_file}"
    if [[ -n "${worker_error}" ]]; then
      die "Worker 兑换失败（HTTP ${http_code}：${worker_error}），请检查兑换密码和 Worker 配置"
    fi
    die "Worker 兑换失败（HTTP ${http_code}），请检查网络和 Worker 配置"
  fi

  local relay_token=""
  if ! relay_token="$("${NODE_BIN}" -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const token = String(data.relayToken || "").trim();
    if (!/^relay_v1_[0-9a-f]{64}$/.test(token)) process.exit(1);
    process.stdout.write(token);
  ' "${response_file}")"; then
    rm -f -- "${request_file}" "${response_file}"
    die "Worker 返回的中继令牌无效或响应格式错误"
  fi

  TEAMNODE_SYNC_RELAY_TOKEN="${relay_token}"

  local cloudflare_api_key=""
  if ! cloudflare_api_key="$("${NODE_BIN}" -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const token = String(data.cloudflareApiKey || "").trim();
    if (token.length > 256 || /[\r\n]/.test(token)) process.exit(1);
    process.stdout.write(token);
  ' "${response_file}")"; then
    rm -f -- "${request_file}" "${response_file}"
    die "Worker 返回的 Cloudflare API Token 格式异常"
  fi
  if [[ -n "${cloudflare_api_key}" ]]; then
    CLOUDFLARE_API_KEY="${cloudflare_api_key}"
    log "已通过 Worker 兑换 Cloudflare DNS API Token（不会打印 Token）"
  else
    warn "Worker 未下发 CLOUDFLARE_API_KEY；直连模式的自动 DNS 更新不可用"
  fi

  unset password TEAMNODE_SYNC_ENROLL_PASSWORD
  rm -f -- "${request_file}" "${response_file}"
  log "已通过 Worker 兑换 TeamNode 中继令牌（兑换密码未写入 .env）"
}

write_runtime_files() {
  log "下载并校验固定版本的 nodejs-argo 源码"
  local source_url="${SOURCE_BASE_URL%/}/index.js"
  # Use the expected digest as a cache key. This prevents a CDN from returning
  # an older index.js after the Worker has injected a newer digest.
  if [[ "${source_url}" == *\?* ]]; then
    source_url="${source_url}&sha256=${SOURCE_INDEX_SHA256}"
  else
    source_url="${source_url}?sha256=${SOURCE_INDEX_SHA256}"
  fi
  download_verified "${source_url}" "${APP_DIR}/app/index.js" "${SOURCE_INDEX_SHA256}" "nodejs-argo index.js"

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
  set_owner -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
  log "安装固定 npm 依赖（禁止 install scripts）"
  run_as_service_user env HOME="${APP_DIR}/home" NPM_CONFIG_CACHE="${APP_DIR}/npm-cache" \
    "${NPM_BIN}" --prefix "${APP_DIR}/app" install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false
}

write_env_file() {
  : > "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  # 重新安装/更新时允许节点重新进行 Tunnel 优先探测。
  rm -f -- "${FILE_PATH}/.no-route"
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
  write_env_value "UPLOAD_URL" "${UPLOAD_URL:-}"
  write_env_value "PROJECT_URL" "${PROJECT_URL:-}"
  write_env_value "SUB_PATH" "${SUB_PATH:-sub}"
  write_env_value "AUTO_ACCESS" "${AUTO_ACCESS:-false}"
  write_env_value "TEAMNODE_SYNC_ENABLED" "${TEAMNODE_SYNC_ENABLED}"
  write_env_value "TEAMNODE_SYNC_BASE_URL" "${TEAMNODE_SYNC_BASE_URL}"
  write_env_value "TEAMNODE_SYNC_KEY_ID" "${TEAMNODE_SYNC_KEY_ID}"
  write_env_value "TEAMNODE_SYNC_SECRET" "${TEAMNODE_SYNC_SECRET}"
  write_env_value "TEAMNODE_SYNC_RELAY_TOKEN" "${TEAMNODE_SYNC_RELAY_TOKEN}"
  write_env_value "TEAMNODE_SYNC_GROUP_KEY" "${TEAMNODE_SYNC_GROUP_KEY}"
  write_env_value "TEAMNODE_SYNC_PROVIDER" "${TEAMNODE_SYNC_PROVIDER:-}"
  write_env_value "TEAMNODE_SYNC_LABEL_PREFIX" "${TEAMNODE_SYNC_LABEL_PREFIX:-}"
  write_env_value "TEAMNODE_SYNC_TIMEOUT_MS" "${TEAMNODE_SYNC_TIMEOUT_MS}"
  write_env_value "TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS" "${TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS}"
  write_env_value "TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS" "${TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS}"
  write_env_value "TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT" "${TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT}"
  write_env_value "CLOUDFLARE_API_KEY" "${CLOUDFLARE_API_KEY}"
  write_env_value "AUTO_DIRECT_FALLBACK" "${AUTO_DIRECT_FALLBACK}"
  write_env_value "CLOUDFLARED_PROTOCOL" "${CLOUDFLARED_PROTOCOL}"
  write_env_value "CLOUDFLARED_LOG_LEVEL" "${CLOUDFLARED_LOG_LEVEL:-info}"
  write_env_value "XRAY_LOG_LEVEL" "${XRAY_LOG_LEVEL:-warning}"
  write_env_value "XRAY_ACCESS_LOG_ENABLED" "${XRAY_ACCESS_LOG_ENABLED:-false}"
  write_env_value "XRAY_SNIFFING_ENABLED" "${XRAY_SNIFFING_ENABLED:-false}"
  write_env_value "DIRECT_MODE" "${DIRECT_MODE:-false}"
  write_env_value "DIRECT_TLS_ENABLED" "${DIRECT_TLS_ENABLED}"
  write_env_value "DIRECT_PORT" "${DIRECT_PORT}"
  write_env_value "DIRECT_HTTP_PORT" "${DIRECT_HTTP_PORT}"
  write_env_value "DIRECT_PORT_CANDIDATES" "${DIRECT_PORT_CANDIDATES}"
  write_env_value "DIRECT_PORT_SCAN_PORTS" "${DIRECT_PORT_SCAN_PORTS}"
  write_env_value "DIRECT_PORT_SCAN_RANGE" "${DIRECT_PORT_SCAN_RANGE}"
  write_env_value "DIRECT_PORT_SCAN_MAX" "${DIRECT_PORT_SCAN_MAX}"
  write_env_value "CF_DNS_ENABLED" "${CF_DNS_ENABLED}"
  write_env_value "CF_DNS_RECORD_NAME" "${CF_DNS_RECORD_NAME}"
  write_env_value "CF_DNS_ZONE_ID" "${CF_DNS_ZONE_ID}"
  write_env_value "CF_DNS_ZONE_NAME" "${CF_DNS_ZONE_NAME}"
  write_env_value "CF_DNS_PUBLIC_IP" "${CF_DNS_PUBLIC_IP}"
  write_env_value "CF_DNS_TTL" "${CF_DNS_TTL}"
  write_env_value "CF_DNS_REPLACE_CNAME" "${CF_DNS_REPLACE_CNAME}"
  write_env_value "NODEJS_ARGO_ENV_FILE" "${ENV_FILE}"
  write_env_value "PLATFORM_PROXY_MODE" "${PLATFORM_PROXY_MODE:-false}"
  set_owner "${SERVICE_USER}:${SERVICE_USER}" "${ENV_FILE}"
}

write_runner_script() {
  cat > "${RUNNER_SCRIPT}" <<EOF
#!${BASH_BIN}
set -u

ENV_FILE="${ENV_FILE}"
NODE_BIN="${NODE_BIN}"
APP_DIR="${APP_DIR}"
LOG_FILE="${FILE_PATH}/nodejs-argo.log"
STOP_MARKER="${FILE_PATH}/.no-route"
child_pid=""

if [[ -f "\${STOP_MARKER}" ]]; then
  printf '[runner] no usable Tunnel or direct route was detected; remove \${STOP_MARKER} after fixing network access\n' >>"\${LOG_FILE}"
  exit 78
fi

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
export HOME="${APP_DIR}/home"
export PM2_HOME="${APP_DIR}/pm2-home"
cd "\${APP_DIR}/app"

while true; do
  "\${NODE_BIN}" "\${APP_DIR}/app/index.js" >>"\${LOG_FILE}" 2>&1 &
  child_pid="\$!"
  wait "\${child_pid}"
  status="\$?"
  child_pid=""
  if [[ "\${status}" -eq 78 || -f "\${STOP_MARKER}" ]]; then
    printf '[runner] node stopped because no usable route was detected\n' >>"\${LOG_FILE}"
    exit 78
  fi
  printf '[runner] node exited with code %s; restarting in 10 seconds\\n' "\${status}" >>"\${LOG_FILE}"
  sleep 10
done
EOF
  set_owner "${SERVICE_USER}:${SERVICE_USER}" "${RUNNER_SCRIPT}"
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
ExecStart=${RUNNER_SCRIPT}
Restart=always
RestartSec=10
RestartPreventExitStatus=78
NoNewPrivileges=true
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
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
  nohup "\${RUNUSER}" -u "\${SERVICE_USER}" -- "\${DAEMON}" >>"${FILE_PATH}/runner-launcher.log" 2>&1 &
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

write_supervisor_service() {
  SUPERVISOR_CONF_FILE="${SUPERVISOR_CONF_DIR}/${SERVICE_NAME}.conf"
  cat >"${SUPERVISOR_CONF_FILE}" <<EOF
[program:${SERVICE_NAME}]
command=${RUNNER_SCRIPT}
directory=${APP_DIR}/app
user=${SERVICE_USER}
autostart=true
autorestart=unexpected
exitcodes=0,78
stopsignal=TERM
stopasgroup=true
killasgroup=true
stdout_logfile=${FILE_PATH}/supervisor-stdout.log
stderr_logfile=${FILE_PATH}/supervisor-stderr.log
stdout_logfile_maxbytes=10MB
stderr_logfile_maxbytes=10MB
EOF
  chmod 0644 "${SUPERVISOR_CONF_FILE}"
}

ensure_supervisor_running() {
  if supervisorctl_exec pid >/dev/null 2>&1; then
    return 0
  fi

  if has_command service; then
    service supervisor start >/dev/null 2>&1 || service supervisord start >/dev/null 2>&1 || true
  elif has_command rc-service; then
    rc-service supervisord start >/dev/null 2>&1 || rc-service supervisor start >/dev/null 2>&1 || true
  fi

  if ! supervisorctl_exec pid >/dev/null 2>&1; then
    log "启动 Supervisor 守护进程"
    nohup supervisord -c "${SUPERVISOR_CONFIG_FILE}" \
      >>"${FILE_PATH}/supervisord-launcher.log" 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      supervisorctl_exec pid >/dev/null 2>&1 && return 0
    done
  fi

  supervisorctl_exec pid >/dev/null 2>&1 || die "Supervisor 守护进程未运行，请检查 ${SUPERVISOR_CONFIG_FILE}"
}

start_supervisor_service() {
  write_supervisor_service
  ensure_supervisor_running
  supervisorctl_exec reread >/dev/null
  supervisorctl_exec update >/dev/null
  supervisorctl_exec start "${SERVICE_NAME}" >/dev/null 2>&1 || supervisorctl_exec status "${SERVICE_NAME}"
}

start_background_runner() {
  if [[ -n "${RUNUSER_BIN}" ]]; then
    nohup "${RUNUSER_BIN}" -u "${SERVICE_USER}" -- "${RUNNER_SCRIPT}" \
      >>"${FILE_PATH}/runner-launcher.log" 2>&1 &
  else
    nohup "${SU_BIN}" -s "${BASH_BIN}" -c 'exec "$@"' "${SERVICE_USER}" -- "${RUNNER_SCRIPT}" \
      >>"${FILE_PATH}/runner-launcher.log" 2>&1 &
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
    PATH="$(service_node_path)" \
    "${PM2_BIN}" delete "${SERVICE_NAME}" >/dev/null 2>&1 || true
  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    PATH="$(service_node_path)" \
    "${PM2_BIN}" kill >/dev/null 2>&1 || true
}

start_pm2_service() {
  validate_pm2_version
  prepare_pm2_paths
  install -d -m 0700 "${PM2_DIR}" "${PM2_HOME_DIR}"
  set_owner -R "${SERVICE_USER}:${SERVICE_USER}" "${PM2_DIR}" "${PM2_HOME_DIR}"

  log "未检测到可用 init/cron，安装 PM2 ${PM2_VERSION} 作为最后的进程守护"
  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    NPM_CONFIG_CACHE="${APP_DIR}/npm-cache" \
    PATH="$(service_node_path)" \
    "${NPM_BIN}" --prefix "${PM2_DIR}" install "pm2@${PM2_VERSION}" \
      --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false

  [[ -x "${PM2_BIN}" ]] || die "PM2 安装完成但未找到可执行文件：${PM2_BIN}"

  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    PATH="$(service_node_path)" \
    "${PM2_BIN}" start "${RUNNER_SCRIPT}" \
      --name "${SERVICE_NAME}" \
      --cwd "${APP_DIR}/app" \
      --interpreter "${BASH_BIN}" \
      --instances 1 \
      --restart-delay 10000 \
      --stop-exit-codes 78 \
      --time \
      --update-env
  run_as_service_user env \
    HOME="${APP_DIR}/home" \
    PM2_HOME="${PM2_HOME_DIR}" \
    PATH="$(service_node_path)" \
    "${PM2_BIN}" save --force

  log "PM2 已启动单实例运行包装器；ARGO 网关端口保持 ${ARGO_PORT}，HTTP 端口保持 ${SERVER_PORT}"
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

validate_direct_port_candidates() {
  local candidate
  local seen=","
  [[ -n "${DIRECT_PORT_CANDIDATES}" ]] || die "DIRECT_PORT_CANDIDATES 不能为空"
  IFS=',' read -r -a candidates <<<"${DIRECT_PORT_CANDIDATES}"
  for candidate in "${candidates[@]}"; do
    candidate="${candidate//[[:space:]]/}"
    validate_local_port "DIRECT_PORT_CANDIDATES" "${candidate}"
    if [[ "${seen}" != *",${candidate},"* ]]; then
      seen+="${candidate},"
    fi
  done
  [[ "${seen}" != "," ]] || die "DIRECT_PORT_CANDIDATES 未包含有效端口"
}

validate_direct_port_scan_config() {
  [[ "${DIRECT_PORT_SCAN_MAX}" =~ ^[0-9]+$ ]] || die "DIRECT_PORT_SCAN_MAX 必须是数字"
  (( DIRECT_PORT_SCAN_MAX >= 0 && DIRECT_PORT_SCAN_MAX <= 4096 )) || die "DIRECT_PORT_SCAN_MAX 必须在 0-4096 之间"

  local range_start
  local range_end
  if [[ "${DIRECT_PORT_SCAN_RANGE}" =~ ^([0-9]+)-([0-9]+)$ ]]; then
    range_start="${BASH_REMATCH[1]}"
    range_end="${BASH_REMATCH[2]}"
    validate_local_port "DIRECT_PORT_SCAN_RANGE 起点" "${range_start}"
    validate_local_port "DIRECT_PORT_SCAN_RANGE 终点" "${range_end}"
    (( range_start <= range_end )) || die "DIRECT_PORT_SCAN_RANGE 起点不能大于终点"
  else
    die "DIRECT_PORT_SCAN_RANGE 格式无效，应为 start-end"
  fi

  local item
  local item_start
  local item_end
  local scan_items=()
  [[ -n "${DIRECT_PORT_SCAN_PORTS}" ]] || return 0
  IFS=',' read -r -a scan_items <<<"${DIRECT_PORT_SCAN_PORTS}"
  for item in "${scan_items[@]}"; do
    item="${item//[[:space:]]/}"
    if [[ "${item}" =~ ^[0-9]+$ ]]; then
      validate_local_port "DIRECT_PORT_SCAN_PORTS" "${item}"
    elif [[ "${item}" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      item_start="${BASH_REMATCH[1]}"
      item_end="${BASH_REMATCH[2]}"
      validate_local_port "DIRECT_PORT_SCAN_PORTS 起点" "${item_start}"
      validate_local_port "DIRECT_PORT_SCAN_PORTS 终点" "${item_end}"
      (( item_start <= item_end )) || die "DIRECT_PORT_SCAN_PORTS 范围起点不能大于终点：${item}"
      (( item_end - item_start <= 1024 )) || die "DIRECT_PORT_SCAN_PORTS 单个范围不能超过 1025 个端口：${item}"
    else
      die "DIRECT_PORT_SCAN_PORTS 包含无效项：${item}"
    fi
  done
}

validate_cloudflared_protocol() {
  case "${CLOUDFLARED_PROTOCOL,,}" in
    http2|quic|auto) CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL,,}" ;;
    *) die "CLOUDFLARED_PROTOCOL 无效：${CLOUDFLARED_PROTOCOL}（可选 http2、quic、auto）" ;;
  esac
}

set_tunnel_firewall_protocols() {
  case "${CLOUDFLARED_PROTOCOL}" in
    http2) TUNNEL_FIREWALL_PROTOCOLS=(tcp); TUNNEL_FIREWALL_PROTOCOL_LABEL="TCP" ;;
    quic) TUNNEL_FIREWALL_PROTOCOLS=(udp); TUNNEL_FIREWALL_PROTOCOL_LABEL="UDP" ;;
    auto) TUNNEL_FIREWALL_PROTOCOLS=(tcp udp); TUNNEL_FIREWALL_PROTOCOL_LABEL="TCP/UDP" ;;
    *) die "无法为未知 Cloudflare Tunnel 协议配置防火墙：${CLOUDFLARED_PROTOCOL}" ;;
  esac
}

ufw_is_active() {
  has_command ufw || return 1
  ufw status 2>/dev/null | grep -Eiq '^Status:[[:space:]]+active'
}

firewalld_is_active() {
  has_command firewall-cmd || return 1
  [[ "$(firewall-cmd --state 2>/dev/null || true)" == "running" ]]
}

nftables_is_active() {
  has_command nft || return 1
  if has_command systemctl && systemctl is-active --quiet nftables 2>/dev/null; then
    return 0
  fi

  local ruleset
  ruleset="$(nft list ruleset 2>/dev/null || true)"
  printf '%s\n' "${ruleset}" | grep -Eq 'hook[[:space:]]+(input|output|forward)'
}

iptables_is_active() {
  has_command iptables || return 1
  local ruleset
  ruleset="$(iptables -S 2>/dev/null || true)"
  printf '%s\n' "${ruleset}" | grep -Eq '^-P[[:space:]]+(INPUT|OUTPUT|FORWARD)[[:space:]]+DROP|[[:space:]]-j[[:space:]]+(DROP|REJECT)([[:space:]]|$)'
}

configure_ufw_tunnel_firewall() {
  local protocol
  local status
  status="$(ufw status 2>/dev/null || true)"
  for protocol in "${TUNNEL_FIREWALL_PROTOCOLS[@]}"; do
    if printf '%s\n' "${status}" | grep -Eiq "^${CLOUDFLARED_TUNNEL_PORT}/${protocol}[[:space:]]+ALLOW[[:space:]]+OUT"; then
      log "ufw 已放行出站 ${protocol^^} ${CLOUDFLARED_TUNNEL_PORT}"
      continue
    fi
    ufw allow out "${CLOUDFLARED_TUNNEL_PORT}/${protocol}" >/dev/null || return 1
    log "ufw 已添加出站 ${protocol^^} ${CLOUDFLARED_TUNNEL_PORT}"
    status="$(ufw status 2>/dev/null || true)"
  done
}

firewalld_direct_rule_exists() {
  local permanent="$1"
  local family="$2"
  local protocol="$3"
  local rules
  if is_true "${permanent}"; then
    rules="$(firewall-cmd --permanent --direct --get-all-rules 2>/dev/null || true)"
  else
    rules="$(firewall-cmd --direct --get-all-rules 2>/dev/null || true)"
  fi
  printf '%s\n' "${rules}" |
    grep -F "${family} filter OUTPUT 0 -p ${protocol} --dport ${CLOUDFLARED_TUNNEL_PORT}" |
    grep -Fq -- "-j ACCEPT"
}

configure_firewalld_tunnel_firewall() {
  local family
  local protocol
  local runtime_changed=false
  for family in ipv4 ipv6; do
    for protocol in "${TUNNEL_FIREWALL_PROTOCOLS[@]}"; do
      if ! firewalld_direct_rule_exists false "${family}" "${protocol}"; then
        firewall-cmd --direct --add-rule "${family}" filter OUTPUT 0 -p "${protocol}" --dport "${CLOUDFLARED_TUNNEL_PORT}" -j ACCEPT >/dev/null || return 1
        runtime_changed=true
      fi
      if ! firewalld_direct_rule_exists true "${family}" "${protocol}"; then
        firewall-cmd --permanent --direct --add-rule "${family}" filter OUTPUT 0 -p "${protocol}" --dport "${CLOUDFLARED_TUNNEL_PORT}" -j ACCEPT >/dev/null || return 1
      fi
      log "firewalld 已配置出站 ${protocol^^} ${CLOUDFLARED_TUNNEL_PORT}（${family}）"
    done
  done

  if [[ "${runtime_changed}" == true ]]; then
    firewall-cmd --reload >/dev/null || return 1
  fi
}

install_direct_gateway_dependencies() {
  if [[ "${RUN_AS_ROOT}" != true || ( "${DIRECT_MODE}" != true && "${AUTO_DIRECT_FALLBACK}" != true ) ]]; then
    return 0
  fi

  local nginx_missing=false
  local certbot_missing=false
  local nginx_was_active=false
  has_command nginx || nginx_missing=true
  if is_true "${DIRECT_TLS_ENABLED}"; then
    has_command certbot || certbot_missing=true
  fi
  if [[ "${nginx_missing}" != true && "${certbot_missing}" != true ]]; then
    return 0
  fi

  if has_command systemctl && systemctl is-active --quiet nginx 2>/dev/null; then
    nginx_was_active=true
  fi

  local dependency_label="Nginx"
  [[ "${certbot_missing}" == true ]] && dependency_label+="、Certbot"
  log "准备直连网关依赖：${dependency_label}"
  local install_failed=false
  if has_command apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    local apt_packages=(nginx)
    [[ "${certbot_missing}" == true ]] && apt_packages+=(certbot)
    apt-get install -y -qq "${apt_packages[@]}" >/dev/null || install_failed=true
  elif has_command apk; then
    local apk_packages=(nginx)
    [[ "${certbot_missing}" == true ]] && apk_packages+=(certbot)
    apk add --no-cache "${apk_packages[@]}" >/dev/null || install_failed=true
  elif has_command dnf; then
    local dnf_packages=(nginx)
    [[ "${certbot_missing}" == true ]] && dnf_packages+=(certbot)
    dnf install -y "${dnf_packages[@]}" >/dev/null || install_failed=true
  elif has_command yum; then
    local yum_packages=(nginx)
    [[ "${certbot_missing}" == true ]] && yum_packages+=(certbot)
    yum install -y "${yum_packages[@]}" >/dev/null || install_failed=true
  elif has_command zypper; then
    local zypper_packages=(nginx)
    [[ "${certbot_missing}" == true ]] && zypper_packages+=(certbot)
    zypper --non-interactive install "${zypper_packages[@]}" >/dev/null || install_failed=true
  else
    install_failed=true
  fi

  if [[ "${install_failed}" == true ]]; then
    warn "无法自动安装 Nginx/Certbot；若 Tunnel 仍不可用，直连回退可能只能在已有组件可用时执行"
  fi

  # 发行版安装 Nginx 时可能自动启动默认站点。仅在安装前没有运行 Nginx
  # 时停止它，避免抢占后续直连探测和节点网关端口；已有站点由管理员自行管理。
  if [[ "${nginx_was_active}" != true ]] && has_command systemctl && systemctl is-active --quiet nginx 2>/dev/null; then
    systemctl disable --now nginx >/dev/null 2>&1 || warn "无法停止发行版默认 Nginx；直连回退会跳过被占用的端口"
  fi
  if [[ "${nginx_was_active}" != true ]] && ! has_command systemctl && has_command service; then
    service nginx stop >/dev/null 2>&1 || true
  fi

  if ! has_command nginx; then
    warn "未找到 nginx；直连模式不会启动，Tunnel 模式仍可继续运行"
  fi
  if is_true "${DIRECT_TLS_ENABLED}" && ! has_command certbot; then
    warn "未找到 certbot；如果 443+80 均可达，将按无证书 HTTP 模式处理"
  fi
}

nft_tunnel_rule_exists() {
  local protocol="$1"
  nft list chain inet nodejs_argo_tunnel output 2>/dev/null |
    grep -Fq -- "${protocol} dport ${CLOUDFLARED_TUNNEL_PORT} accept"
}

persist_nft_tunnel_rules() {
  local config_file="/etc/nftables.conf"
  local fragment="/etc/nftables.d/nodejs-argo-tunnel.nft"
  if [[ -f "${config_file}" ]] && grep -Eq '^[[:space:]]*include[[:space:]]+"/etc/nftables\.d/(\*\.nft|\*)"' "${config_file}"; then
    install -d -m 0755 /etc/nftables.d
    {
      printf '%s\n' 'table inet nodejs_argo_tunnel {'
      printf '%s\n' '  chain output {'
      printf '%s\n' '    type filter hook output priority -50; policy accept;'
      local protocol
      for protocol in "${TUNNEL_FIREWALL_PROTOCOLS[@]}"; do
        printf '    %s dport %s accept comment "nodejs-argo cloudflare tunnel"\n' "${protocol}" "${CLOUDFLARED_TUNNEL_PORT}"
      done
      printf '%s\n' '  }'
      printf '%s\n' '}'
    } > "${fragment}"
    chmod 0644 "${fragment}"
    log "nftables 规则已写入持久化配置：${fragment}"
    return 0
  fi

  warn "nftables 当前运行时规则已添加，但未找到 /etc/nftables.conf 对 /etc/nftables.d/*.nft 的 include；重启后可能需要重新加载规则"
  return 0
}

configure_nftables_tunnel_firewall() {
  if ! nft list table inet nodejs_argo_tunnel >/dev/null 2>&1; then
    nft add table inet nodejs_argo_tunnel || return 1
  fi
  if ! nft list chain inet nodejs_argo_tunnel output >/dev/null 2>&1; then
    nft add chain inet nodejs_argo_tunnel output '{ type filter hook output priority -50; policy accept; }' || return 1
  fi

  local protocol
  for protocol in "${TUNNEL_FIREWALL_PROTOCOLS[@]}"; do
    if ! nft_tunnel_rule_exists "${protocol}"; then
      nft add rule inet nodejs_argo_tunnel output "${protocol}" dport "${CLOUDFLARED_TUNNEL_PORT}" accept || return 1
    fi
    log "nftables 已配置出站 ${protocol^^} ${CLOUDFLARED_TUNNEL_PORT}"
  done
  persist_nft_tunnel_rules
}

iptables_tunnel_rule_exists() {
  local firewall_bin="$1"
  local protocol="$2"
  "${firewall_bin}" -C OUTPUT -p "${protocol}" --dport "${CLOUDFLARED_TUNNEL_PORT}" -j ACCEPT >/dev/null 2>&1
}

configure_iptables_tunnel_firewall() {
  local firewall_bin
  local protocol
  local configured=false
  for firewall_bin in iptables ip6tables; do
    has_command "${firewall_bin}" || continue
    for protocol in "${TUNNEL_FIREWALL_PROTOCOLS[@]}"; do
      if ! iptables_tunnel_rule_exists "${firewall_bin}" "${protocol}"; then
        if "${firewall_bin}" -I OUTPUT 1 -p "${protocol}" --dport "${CLOUDFLARED_TUNNEL_PORT}" -j ACCEPT >/dev/null 2>&1; then
          configured=true
        else
          warn "${firewall_bin} 无法添加出站 ${protocol^^} ${CLOUDFLARED_TUNNEL_PORT} 规则"
          continue
        fi
      else
        configured=true
      fi
      log "${firewall_bin} 已配置出站 ${protocol^^} ${CLOUDFLARED_TUNNEL_PORT}"
    done
  done

  [[ "${configured}" == true ]] || return 1
  if has_command netfilter-persistent; then
    netfilter-persistent save >/dev/null 2>&1 || warn "iptables 运行时规则已添加，但 netfilter-persistent 保存失败"
  else
    warn "iptables 运行时规则已添加，但未找到 netfilter-persistent；重启后可能需要重新加载规则"
  fi
}

configure_tunnel_firewall() {
  if [[ "${RUN_AS_ROOT}" != true ]]; then
    warn "非 root 安装无法修改系统防火墙；请手动放行出站 ${CLOUDFLARED_PROTOCOL} ${CLOUDFLARED_TUNNEL_PORT}"
    return 0
  fi
  if ! is_true "${AUTO_CONFIGURE_FIREWALL}"; then
    log "已关闭防火墙自动配置（AUTO_CONFIGURE_FIREWALL=${AUTO_CONFIGURE_FIREWALL}）；需要放行出站 ${CLOUDFLARED_PROTOCOL} ${CLOUDFLARED_TUNNEL_PORT}"
    return 0
  fi

  set_tunnel_firewall_protocols
  log "检查主机防火墙：Cloudflare Tunnel 使用出站 ${TUNNEL_FIREWALL_PROTOCOL_LABEL} ${CLOUDFLARED_TUNNEL_PORT}"
  if ufw_is_active; then
    if ! configure_ufw_tunnel_firewall; then warn "ufw 自动配置失败；请手动放行出站 ${TUNNEL_FIREWALL_PROTOCOL_LABEL} ${CLOUDFLARED_TUNNEL_PORT}"; fi
    return 0
  fi
  if firewalld_is_active; then
    if ! configure_firewalld_tunnel_firewall; then warn "firewalld 自动配置失败；请手动放行出站 ${TUNNEL_FIREWALL_PROTOCOL_LABEL} ${CLOUDFLARED_TUNNEL_PORT}"; fi
    return 0
  fi
  if nftables_is_active; then
    if ! configure_nftables_tunnel_firewall; then warn "nftables 自动配置失败；请手动放行出站 ${TUNNEL_FIREWALL_PROTOCOL_LABEL} ${CLOUDFLARED_TUNNEL_PORT}"; fi
    return 0
  fi
  if iptables_is_active; then
    if ! configure_iptables_tunnel_firewall; then warn "iptables 自动配置失败；请手动放行出站 ${TUNNEL_FIREWALL_PROTOCOL_LABEL} ${CLOUDFLARED_TUNNEL_PORT}"; fi
    return 0
  fi

  log "未检测到启用的主机防火墙，未添加规则；如果端口仍不通，请检查云平台安全组或上游网络"
}

direct_firewall_ports() {
  local port
  local item
  local range_start
  local range_end
  local seen=","
  local candidates=()
  IFS=',' read -r -a candidates <<<"${DIRECT_PORT_CANDIDATES}"
  candidates+=("${DIRECT_PORT}" "${DIRECT_HTTP_PORT}")
  for port in "${candidates[@]}"; do
    port="${port//[[:space:]]/}"
    [[ -n "${port}" && "${seen}" != *",${port},"* ]] || continue
    seen+="${port},"
    printf '%s\n' "${port}"
  done

  local scan_items=()
  IFS=',' read -r -a scan_items <<<"${DIRECT_PORT_SCAN_PORTS}"
  for item in "${scan_items[@]}"; do
    item="${item//[[:space:]]/}"
    if [[ "${item}" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      range_start="${BASH_REMATCH[1]}"
      range_end="${BASH_REMATCH[2]}"
      for ((port = range_start; port <= range_end; port += 1)); do
        [[ "${seen}" != *",${port},"* ]] || continue
        seen+="${port},"
        printf '%s\n' "${port}"
      done
    else
      port="${item}"
      [[ -n "${port}" && "${seen}" != *",${port},"* ]] || continue
      seen+="${port},"
      printf '%s\n' "${port}"
    fi
  done
}

configure_ufw_direct_firewall() {
  local port
  local status
  status="$(ufw status 2>/dev/null || true)"
  while read -r port; do
    [[ -n "${port}" ]] || continue
    if printf '%s\n' "${status}" | grep -Eiq "^${port}/tcp[[:space:]]+ALLOW[[:space:]]+IN"; then
      log "ufw 已放行入站 TCP ${port}"
      continue
    fi
    ufw allow in "${port}/tcp" >/dev/null || return 1
    log "ufw 已添加入站 TCP ${port}"
    status="$(ufw status 2>/dev/null || true)"
  done < <(direct_firewall_ports)
}

configure_firewalld_direct_firewall() {
  local port
  local changed=false
  while read -r port; do
    [[ -n "${port}" ]] || continue
    if ! firewall-cmd --query-port="${port}/tcp" >/dev/null 2>&1; then
      firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null || return 1
      firewall-cmd --add-port="${port}/tcp" >/dev/null || return 1
      changed=true
    fi
    log "firewalld 已放行入站 TCP ${port}"
  done < <(direct_firewall_ports)
  [[ "${changed}" == true ]] && firewall-cmd --reload >/dev/null || true
}

nft_direct_rule_exists() {
  local port="$1"
  nft list chain inet nodejs_argo_direct input 2>/dev/null |
    grep -Fq -- "tcp dport ${port} accept"
}

persist_nft_direct_rules() {
  local config_file="/etc/nftables.conf"
  local fragment="/etc/nftables.d/nodejs-argo-direct.nft"
  if [[ -f "${config_file}" ]] && grep -Eq '^[[:space:]]*include[[:space:]]+"/etc/nftables\.d/(\*\.nft|\*)"' "${config_file}"; then
    install -d -m 0755 /etc/nftables.d
    {
      printf '%s\n' 'table inet nodejs_argo_direct {'
      printf '%s\n' '  chain input {'
      printf '%s\n' '    type filter hook input priority -50; policy accept;'
      while read -r port; do
        [[ -n "${port}" ]] || continue
        printf '    tcp dport %s accept comment "nodejs-argo direct"\n' "${port}"
      done < <(direct_firewall_ports)
      printf '%s\n' '  }'
      printf '%s\n' '}'
    } >"${fragment}"
    chmod 0644 "${fragment}"
    log "nftables 规则已写入持久化配置：${fragment}"
    return 0
  fi
  warn "nftables 当前运行时入站规则已添加，但未找到 /etc/nftables.conf 的 nftables.d include；重启后可能需要重新加载规则"
}

configure_nftables_direct_firewall() {
  if ! nft list table inet nodejs_argo_direct >/dev/null 2>&1; then
    nft add table inet nodejs_argo_direct || return 1
  fi
  if ! nft list chain inet nodejs_argo_direct input >/dev/null 2>&1; then
    nft add chain inet nodejs_argo_direct input '{ type filter hook input priority -50; policy accept; }' || return 1
  fi

  local port
  while read -r port; do
    [[ -n "${port}" ]] || continue
    if ! nft_direct_rule_exists "${port}"; then
      nft add rule inet nodejs_argo_direct input tcp dport "${port}" accept || return 1
    fi
    log "nftables 已放行入站 TCP ${port}"
  done < <(direct_firewall_ports)
  persist_nft_direct_rules
}

configure_iptables_direct_firewall() {
  local firewall_bin
  local port
  local configured=false
  for firewall_bin in iptables ip6tables; do
    has_command "${firewall_bin}" || continue
    while read -r port; do
      [[ -n "${port}" ]] || continue
      if ! "${firewall_bin}" -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1; then
        if "${firewall_bin}" -I INPUT 1 -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1; then
          configured=true
        else
          warn "${firewall_bin} 无法添加入站 TCP ${port} 规则"
          continue
        fi
      else
        configured=true
      fi
      log "${firewall_bin} 已放行入站 TCP ${port}"
    done < <(direct_firewall_ports)
  done

  [[ "${configured}" == true ]] || return 1
  if has_command netfilter-persistent; then
    netfilter-persistent save >/dev/null 2>&1 || warn "iptables 运行时入站规则已添加，但 netfilter-persistent 保存失败"
  else
    warn "iptables 运行时入站规则已添加，但未找到 netfilter-persistent；重启后可能需要重新加载规则"
  fi
}

configure_direct_firewall() {
  if [[ "${RUN_AS_ROOT}" != true ]]; then
    warn "非 root 安装无法修改系统防火墙；请手动放行入站 TCP ${DIRECT_PORT}、${DIRECT_HTTP_PORT} 及候选端口"
    return 0
  fi
  if ! is_true "${AUTO_CONFIGURE_FIREWALL}"; then
    log "已关闭防火墙自动配置；直连候选端口需要手动放行：$(direct_firewall_ports | paste -sd, -)"
    return 0
  fi

  log "检查主机防火墙：直连候选端口将放行入站 TCP $(direct_firewall_ports | paste -sd, -)"
  if ufw_is_active; then
    if ! configure_ufw_direct_firewall; then warn "ufw 自动配置直连端口失败；请手动放行入站 TCP 候选端口"; fi
    return 0
  fi
  if firewalld_is_active; then
    if ! configure_firewalld_direct_firewall; then warn "firewalld 自动配置直连端口失败；请手动放行入站 TCP 候选端口"; fi
    return 0
  fi
  if nftables_is_active; then
    if ! configure_nftables_direct_firewall; then warn "nftables 自动配置直连端口失败；请手动放行入站 TCP 候选端口"; fi
    return 0
  fi
  if iptables_is_active; then
    if ! configure_iptables_direct_firewall; then warn "iptables 自动配置直连端口失败；请手动放行入站 TCP 候选端口"; fi
    return 0
  fi

  log "未检测到启用的主机防火墙，未添加直连入站规则；云平台安全组或上游网络仍需手动放行候选端口"
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

cleanup_owned_processes() {
  has_command ps || return 0

  local pid
  while read -r pid; do
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    (( pid > 1 && pid != $$ )) || continue
    warn "停止旧安装残留进程：PID ${pid}（$(process_command "${pid}")）"
    terminate_pid "${pid}"
  done < <(
    ps -eo pid=,args= 2>/dev/null |
      awk -v app="${APP_DIR}" -v self="$$" \
         '$1 != self && index($0, app) > 0 && $0 ~ /(node|xray|cloudflared|nginx|run\.sh)/ { print $1 }' |
      sort -u
  )
}

write_rc_local_service() {
  local marker="# nodejs-argo-no-docker: ${SERVICE_NAME}"
  local line="${RUNUSER_BIN} -u ${SERVICE_USER} -- ${RUNNER_SCRIPT} >>${FILE_PATH}/runner-launcher.log 2>&1 & ${marker}"
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
  local line="@reboot ${RUNUSER_BIN} -u ${SERVICE_USER} -- ${RUNNER_SCRIPT} >>${FILE_PATH}/runner-launcher.log 2>&1 ${marker}"
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
    supervisor)
      start_supervisor_service
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

port_is_listening() {
  local port="$1"
  ss -lntH 2>/dev/null |
    awk -v suffix=":${port}" '$4 ~ suffix "$" { found=1 } END { exit(found ? 0 : 1) }'
}

verify_runtime() {
  local server_ready=false
  local argo_ready=false

  log "运行检查：等待 HTTP ${SERVER_PORT} 和 ARGO ${ARGO_PORT} 端口监听（最多 30 秒）"
  for _ in 1 2 3 4 5 6 7 8 9 10 \
    11 12 13 14 15 16 17 18 19 20 \
    21 22 23 24 25 26 27 28 29 30; do
    port_is_listening "${SERVER_PORT}" && server_ready=true
    port_is_listening "${ARGO_PORT}" && argo_ready=true
    if [[ "${server_ready}" = true && "${argo_ready}" = true ]]; then
      log "运行检查通过：HTTP ${SERVER_PORT}、ARGO ${ARGO_PORT} 均已监听"
      return 0
    fi
    sleep 1
  done

  [[ "${server_ready}" = true ]] || warn "HTTP ${SERVER_PORT} 未监听"
  [[ "${argo_ready}" = true ]] || warn "ARGO ${ARGO_PORT} 未监听"
  warn "请查看运行日志：${FILE_PATH}/nodejs-argo.log"
  die "程序未正常启动；安装已中止，请先修复日志中的错误"
}

verify_public_route() {
  local route_ready_marker="${FILE_PATH}/.route-ready"
  local no_route_marker="${FILE_PATH}/.no-route"
  local no_route_reason=""

  log "公网路由心跳：等待 Worker 完成外部连通性验证（最多 60 秒）"
  for _ in 1 2 3 4 5 6 7 8 9 10 \
    11 12 13 14 15 16 17 18 19 20 \
    21 22 23 24 25 26 27 28 29 30 \
    31 32 33 34 35 36 37 38 39 40 \
    41 42 43 44 45 46 47 48 49 50 \
    51 52 53 54 55 56 57 58 59 60; do
    if [[ -f "${no_route_marker}" ]]; then
      no_route_reason="$(head -c 512 "${no_route_marker}" 2>/dev/null || true)"
      die "Worker 公网路由心跳失败；${no_route_reason:-请检查云平台安全组、上游网络和最终域名}"
    fi
    if [[ -f "${route_ready_marker}" ]]; then
      log "公网路由心跳通过：Worker 已从公网验证最终访问路线"
      return 0
    fi
    sleep 1
  done

  warn "Worker 公网路由验证未完成；未找到 ${route_ready_marker}"
  warn "请查看运行日志：${FILE_PATH}/nodejs-argo.log"
  die "程序未完成公网启动验证；安装已中止，请先修复云平台安全组、上游网络或最终域名"
}

stop_supervisor_service() {
  local config_file="${SUPERVISOR_CONF_FILE:-}"
  local candidate

  if [[ -z "${config_file}" || ! -f "${config_file}" ]]; then
    for candidate in \
      "/etc/supervisor/conf.d/${SERVICE_NAME}.conf" \
      "/etc/supervisord.d/${SERVICE_NAME}.conf"; do
      if [[ -f "${candidate}" ]]; then
        config_file="${candidate}"
        break
      fi
    done
  fi

  if has_command supervisorctl && [[ -n "${config_file}" && -f "${config_file}" ]]; then
    supervisorctl_exec stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
    rm -f -- "${config_file}"
    supervisorctl_exec reread >/dev/null 2>&1 || true
    supervisorctl_exec update >/dev/null 2>&1 || true
    return 0
  fi
  [[ -z "${config_file}" ]] || rm -f -- "${config_file}"
}

uninstall() {
  require_root
  validate_app_dir
  prepare_user_switch

  if [[ "${RUN_AS_ROOT}" == true ]]; then
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
  fi

  stop_background_runner
  stop_pm2_service
  [[ "${RUN_AS_ROOT}" == true ]] && stop_supervisor_service

  if has_command crontab; then
    local current_cron
    local marker="# nodejs-argo-no-docker: ${SERVICE_NAME}"
    current_cron="$(crontab -l 2>/dev/null || true)"
    if [[ "${current_cron}" == *"${marker}"* ]]; then
      printf '%s\n' "${current_cron}" | grep -vF -- "${marker}" | crontab - || true
    fi
  fi

  if [[ "${RUN_AS_ROOT}" == true && -f /etc/rc.local ]]; then
    local rc_local_tmp="${APP_DIR}.rc.local.tmp"
    grep -vF -- "# nodejs-argo-no-docker: ${SERVICE_NAME}" /etc/rc.local >"${rc_local_tmp}" || true
    install -m 0755 "${rc_local_tmp}" /etc/rc.local
    rm -f -- "${rc_local_tmp}"
  fi

  cleanup_owned_processes
  if [[ -e "${APP_DIR}/.env" || -L "${APP_DIR}/.env" ]]; then
    rm -f -- "${APP_DIR}/.env" || die "无法清理旧环境文件：${APP_DIR}/.env"
    log "已清理旧环境文件：${APP_DIR}/.env"
  fi
  rm -rf -- "${APP_DIR}"
  log "已卸载：${APP_DIR} 和 ${SERVICE_NAME} 的启动配置"
}

clean_previous_installation() {
  log "清理旧安装、旧服务和旧进程：${APP_DIR}"
  uninstall
  cleanup_owned_processes
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
  configure_install_context
  resolve_source_checksum
  stage "检查安装参数和源码校验"
  validate_app_dir
  if is_true "${UNINSTALL}"; then
    uninstall
    return 0
  fi

  require_root
  require_config
  validate_worker_placeholders
  check_dependencies
  validate_cloudflared_protocol
  NODE_BIN="$(command -v node || true)"
  NPM_BIN="$(command -v npm || true)"
  restore_existing_uuid_if_missing
  generate_uuid_if_missing
  BIN_PATH="${BIN_PATH:-${APP_DIR}/bin}"
  FILE_PATH="${FILE_PATH:-${APP_DIR}/data}"
  validate_local_port "SERVER_PORT" "${SERVER_PORT}"
  validate_local_port "ARGO_PORT" "${ARGO_PORT}"
  validate_local_port "DIRECT_PORT" "${DIRECT_PORT}"
  validate_local_port "DIRECT_HTTP_PORT" "${DIRECT_HTTP_PORT}"
  validate_direct_port_candidates
  validate_direct_port_scan_config
  validate_runtime_paths
  ENV_FILE="${APP_DIR}/.env"
  RUNNER_SCRIPT="${APP_DIR}/run.sh"
  PID_FILE="${APP_DIR}/service.pid"
  prepare_pm2_paths
  detect_service_backend

  if is_true "${DRY_RUN}"; then
    local system_node_label="未找到系统 Node.js"
    if has_command node; then
      system_node_label="$(node --version)"
    fi
    if (( SYSTEM_NODE_MAJOR < 14 )); then
      log "dry-run 检查通过：${system_node_label}，实际安装将使用项目专用 Node.js v${NODE_RUNTIME_VERSION}；启动方式：${SERVICE_BACKEND}"
    else
      log "dry-run 检查通过：Node.js ${system_node_label}，启动方式：${SERVICE_BACKEND}"
    fi
    return 0
  fi

  stage "清理旧安装和占用端口"
  clean_previous_installation

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf -- "${TMP_DIR}"' EXIT
  install -d -m 0750 "${APP_DIR}" "${APP_DIR}/app" "${BIN_PATH}" "${FILE_PATH}"
  create_service_user
  ensure_project_node_runtime
  stage "兑换 TeamNode 中继令牌"
  redeem_teamnode_relay_token

  local machine_arch
  case "$(uname -m)" in
    x86_64|amd64) machine_arch="amd64" ;;
    aarch64|arm64) machine_arch="arm64" ;;
    *) die "不支持的系统架构：$(uname -m)" ;;
  esac

  stage "安装 Cloudflare Tunnel"
  install_cloudflared "${machine_arch}"
  stage "安装 Xray"
  install_xray "${machine_arch}"
  stage "下载并校验节点应用"
  write_runtime_files
  stage "写入环境变量和启动配置"
  write_env_file
  configure_direct_firewall
  configure_tunnel_firewall
  set_owner -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
  chmod 0700 "${APP_DIR}" "${APP_DIR}/data"
  chmod 0600 "${ENV_FILE}"
  write_runner_script
  stage "启动节点和 Cloudflare Tunnel"
  start_service

  stage "验证节点运行状态"
  verify_runtime
  verify_public_route

  stage "安装完成"
  log "安装完成"
  case "${SERVICE_BACKEND}" in
    systemd) log "查看日志：journalctl -u ${SERVICE_NAME}.service -f" ;;
    openrc|sysv|supervisor) log "查看日志：tail -f ${FILE_PATH}/nodejs-argo.log" ;;
    rc.local|cron) log "查看日志：tail -f ${FILE_PATH}/nodejs-argo.log" ;;
    none) log "查看 PM2：${PM2_BIN} status；查看日志：${PM2_BIN} logs ${SERVICE_NAME}" ;;
  esac
  log "TeamNode：${TEAMNODE_SYNC_BASE_URL}"
}

main "$@"
