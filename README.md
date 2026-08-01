# workers-installer

这是一个独立的 Cloudflare Worker 安装器项目，用于在没有 Docker 的 Linux 机器上部署 nodejs-argo。

Worker 不运行节点程序，只负责：

- 提供经过动态校验的 `install.sh`；
- 提供 `/agent/index.js` 源码下载；
- 代理 TeamNode 注册、心跳和下线请求；
- 在用户输入兑换密码后，为每台机器签发专属中继令牌。

目标机器运行的程序包含三种 WebSocket 协议：VLESS、VMess、Trojan，并通过 Cloudflare Tunnel 对外提供固定域名访问。

## 一、部署前准备

在 Cloudflare 账户中准备一个 Worker，并确保当前目录是本项目：

```bash
cd workers-installer
npx wrangler login
```

### Cloudflare 控制台设置

在 Cloudflare 控制台打开：

```text
Workers & Pages
→ workers-installer
→ Settings
→ Variables and Secrets
```

以下两个值选择 **Secret** 类型，并配置在 Production 环境：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `TEAMNODE_SYNC_SECRET` | Secret | TeamNode 主密钥，只在 Worker 代理请求时使用 |
| `TEAMNODE_SYNC_ENROLL_PASSWORD` | Secret | 目标机器安装时输入的兑换密码 |
| `CLOUDFLARE_API_KEY` | Secret，可选 | 用于保留/恢复 `ARGO_DOMAIN` 的 Tunnel CNAME，并为自动派生的直连域名创建 DNS-only A/AAAA 记录；安装兑换时按请求下发到目标机器的 0600 `.env` |

如果需要根页面在线机器面板，再添加：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `DASHBOARD_PASSWORD` | Secret，可选 | 设置后启用根页面 Basic Auth；不设置时面板公开 |
| `DASHBOARD_USER` | Text | 可选，默认用户名为 `admin` |

如果同时使用 Preview/非生产部署，需要在对应环境再次配置这些值。

### 命令行配置 Secret

也可以在项目目录执行以下命令，效果与控制台添加 Secret 相同：

以下两项缺一不可。缺少任意一项时，Worker 虽然可能可以部署，但目标机器无法完成密码兑换或 TeamNode 请求签名：

```bash
npx wrangler secret put TEAMNODE_SYNC_SECRET
npx wrangler secret put TEAMNODE_SYNC_ENROLL_PASSWORD
```

填写说明：

- `TEAMNODE_SYNC_SECRET`：TeamNode 主密钥，只保存于 Worker，不会写入安装脚本或目标机器。
- `TEAMNODE_SYNC_ENROLL_PASSWORD`：安装时使用的兑换密码，建议使用随机生成的强密码。

执行命令后，Wrangler 会在终端中隐藏输入内容。输入完成后，Secret 会保存到 Cloudflare Worker，不会写入 GitHub 仓库：

不要配置固定的 `TEAMNODE_SYNC_RELAY_TOKEN`。Worker 会根据目标机器的 UUID 自动签发专属中继令牌。

当前面板默认公开，不需要配置 `DASHBOARD_PASSWORD`。如果以后需要限制访问，再配置：

```bash
npx wrangler secret put DASHBOARD_PASSWORD
```

配置后面板默认用户名为 `admin`，也可以通过 Worker 变量 `DASHBOARD_USER` 修改。暂时要保持公开，请不要设置 `DASHBOARD_PASSWORD`；如果之前已经设置，请在 Cloudflare 的“变量和机密”中删除它。

### Workers Builds 构建配置

在 Cloudflare 的 Build 设置中使用：

```text
根目录：/
构建命令：留空
部署命令：npx wrangler deploy
非生产分支部署命令：npx wrangler deploy
```

仓库中的 `wrangler.jsonc` 是部署配置的来源，当前 Worker 名称必须保持为 `workers-installer`。其中的 `keep_vars: true` 用于保留 Cloudflare 控制台配置的变量和机密；真实 Secret 不写入 `wrangler.jsonc`。如果 Cloudflare 自动创建修复 PR，应确认它没有删除 `durable_objects` 和 `migrations` 配置，再合并。

部署 Worker：

```bash
npx wrangler deploy
```

如果以后更换 TeamNode 主密钥或兑换密码，重新执行对应的 `npx wrangler secret put ...` 命令即可；更换主密钥后，已经安装的目标机器需要重新运行安装器兑换中继令牌。

部署后默认地址：

```text
https://你的-worker.workers.dev/install.sh
```

如果要使用自己的域名，例如 `install.lemon.vin`，请在 Cloudflare 的 Worker 设置中添加 Custom Domain，然后使用：

```text
https://install.lemon.vin/install.sh
```

可用的 Worker 地址：

| 地址 | 用途 |
| --- | --- |
| `/` | 在线机器面板（未配置 `DASHBOARD_PASSWORD` 时公开） |
| `/install.sh` | 推荐的安装脚本地址 |
| `/inatall.sh` | 兼容旧拼写的安装脚本地址 |
| `/agent/index.js` | 节点源码地址 |
| `/healthz` | Worker 健康检查 |
| `/api/nodes` | 在线机器 JSON 接口（未配置 `DASHBOARD_PASSWORD` 时公开） |

每次请求 `install.sh` 时，Worker 会重新计算当前 `agent/index.js` 的 SHA256，并注入源码地址和校验值。因此不要直接使用 GitHub 原始文件中的 `public/install.sh`。

`SOURCE_INDEX_SHA256` 通常不需要手动设置。安装器会使用 Worker 自动注入的 64 位十六进制 SHA256；空值或常见包装器传入的 `""` 会按未设置处理。只有使用自定义 `SOURCE_BASE_URL` 时，才需要同时提供对应的真实 `SOURCE_INDEX_SHA256`。安装器还会将 SHA256 加入源码下载 URL，避免 CDN 返回旧版本文件。

### lemon-监控面板

部署后直接打开：

```text
https://你的-worker.workers.dev/
```

未设置 `DASHBOARD_PASSWORD` 时，面板和 `/api/nodes` 都可以被任何人查看，不需要登录。面板会分别显示可用的公网 IPv4、IPv6，以及节点名称、`ARGO_DOMAIN`、地区、Provider、最后心跳时间、操作系统、系统架构、CPU 和内存总量，并显示节点实际上报的 Cloudflare Tunnel 连通性、传输协议、所需端口、HTTP 状态码、失败原因和最后检查时间；不显示 UUID 或其他敏感配置。Tunnel 连通性由节点先探测 Cloudflare Tunnel 传输端口，再访问 `ARGO_DOMAIN` 检查边缘返回，不把 TeamNode 心跳直接当作 Tunnel 在线。当前 HTTP/2 配置通常显示需要放行出站 TCP `7844`；QUIC 显示 UDP `7844`；自动协议显示 TCP/UDP `7844`。只有 Worker 成功转发 TeamNode 注册或心跳后，机器才会进入列表；累计心跳少于 5 次的节点，在明确下线或 Worker 确认其超过心跳检测阈值后直接删除，不进入超时/离线保留流程。累计达到 5 次心跳的节点，明确下线后的前 5 分钟显示“超时”，第 5–10 分钟显示“离线”，超过 10 分钟后自动删除。没有明确下线通知的节点，Worker 会在下一次轮询发现其超过 5 分钟没有心跳时显示“离线”，并在最后一次活动超过 10 分钟后自动删除；恢复心跳后自动回到“在线”。Worker 不会主动替节点生成心跳，只有通过中继令牌认证且成功转发到 TeamNode 的节点请求才会更新面板状态。可用 Worker 变量 `TEAMNODE_DASHBOARD_HEARTBEAT_TIMEOUT_MS` 调整心跳阈值；可用 `TEAMNODE_DASHBOARD_ONLINE_TTL_MS` 调整自动删除时间，但必须不小于 30 秒。

如果以后设置了 `DASHBOARD_PASSWORD`，根页面和 `/api/nodes` 会启用 Basic Auth，默认用户名为 `admin`。

在线状态由 Cloudflare Durable Object 持久化，多台机器可以同时注册，不会因为 Worker 实例切换而互相覆盖。节点每 5 分钟分别检测一次公网 IPv4/IPv6，Worker 还会用 `CF-Connecting-IP` 补充当前心跳的出口地址，并保留已知的两种地址；如果目标机器经过 NAT 或代理，显示的可能是 NAT 或代理出口地址。

## 二、安装无 Docker 节点

### 需要设置的参数

必须设置：

- `ARGO_AUTH`：Cloudflare Tunnel Token 或 JSON；
- `ARGO_DOMAIN`：固定 Tunnel 域名，例如 `boxd06.openlemon.cyou`；始终预留给 cloudflared，不再被直连 A 记录覆盖。

直连域名不需要手动传入。安装器会在 `ARGO_DOMAIN` 最左侧标签前自动加上固定前缀 `zhilian`，例如：

```text
Tunnel：boxd06.openlemon.cyou
直连： zhilianboxd06.openlemon.cyou
```

切换直连后，Cloudflare DNS、Let's Encrypt 证书、Nginx `server_name`、Worker 最终回访以及 VLESS/VMess/Trojan 的 `add`、`host`、`sni` 都使用直连域名；`ARGO_DOMAIN` 继续保留给原 Cloudflare Tunnel。每台机器仍必须使用唯一的 `ARGO_DOMAIN`，以免两台机器派生出同一个直连域名。

常用可选参数：

- `ARGO_PORT`：Tunnel 连接的本地端口，默认 `8001`；
- `CLOUDFLARED_PROTOCOL`：Tunnel 传输协议，可选 `http2`、`quic`、`auto`，默认 `http2`；
- `AUTO_CONFIGURE_FIREWALL`：root 安装时是否自动配置已启用的主机防火墙，默认 `true`；Tunnel 模式配置出站 7844，直连探测还会放行 `DIRECT_PORT_CANDIDATES`、`DIRECT_PORT`、`DIRECT_HTTP_PORT` 和 `DIRECT_PORT_SCAN_PORTS` 中明确列出的入站 TCP 端口；
- `DIRECT_IPV4_ENABLED`、`DIRECT_IPV6_ENABLED`：控制直连 Nginx 与 DNS 启用的地址族，默认都为 `true`；自动路线选择会根据 Worker 的实际公网回访结果重写这两个值，不会发布未通过回访的地址族；
- `CF_DNS_PUBLIC_IP`、`CF_DNS_PUBLIC_IPV6`：可选的固定公网 IPv4/IPv6；不设置时节点分别自动检测，直连域名对应创建 DNS-only `A`/`AAAA` 记录；
- `CFIP`：节点连接地址，例如 `cdst.lemon.vin`；
- `NAME`：节点名称前缀；
- `UUID`：新机器不设置时自动随机生成；覆盖已有安装且不设置时，自动复用旧 `.env` 中的 UUID；显式指定时优先使用指定值；
- `FORCE_KILL_PORTS=true`：清理旧安装时强制终止相关端口上的其他进程，谨慎使用。
- `NODE_RUNTIME_VERSION`：仅当系统 Node.js 低于 14 时使用的项目专用 Node.js 版本，默认 `20.20.2`；不会升级或替换系统 Node.js。
- `NODE_RUNTIME_SHA256`：仅在自定义 `NODE_RUNTIME_VERSION` 且该版本没有内置校验值时，填写对应 Node.js 官方 Linux 压缩包的 64 位 SHA256。
- `TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS`：节点轮询面板检测指令的间隔，默认 `15000` 毫秒，允许范围为 5–60 秒。
- `PUBLIC_ROUTE_VERIFY_TIMEOUT_SECONDS`：安装器等待 Tunnel/直连公网路线心跳的时间，默认 `180` 秒，允许范围为 30–600 秒。

如果目标机已有 Node.js 12，安装器不会把它升级成全局版本，也不会影响其他项目；它会在
安装目录内的 `node-runtime/` 安装并使用项目专用 Node.js 20.20.2。已有 Node.js 14 或更高版本
且可用 npm 时，默认直接复用系统版本。

安装权限说明：

- root 安装默认使用 `/opt/nodejs-argo-no-docker`，并按系统能力配置 systemd、OpenRC、SysV、Supervisor
  或 cron 开机自启；没有可用机制时使用项目目录内的 PM2 保持运行。
- 非 root 安装会自动切换为当前用户，默认安装到
  `$HOME/.local/share/nodejs-argo-no-docker`，不会写入 `/opt`、`/etc` 或系统级服务，也不会修改系统 Node.js。
  此模式会在项目目录内安装需要的 Node.js 和 PM2，并立即启动程序；由于没有系统级权限，不能保证重启后自动启动。
- 非 root 安装不能把 `APP_DIR`、`BIN_PATH` 或 `FILE_PATH` 指向当前用户目录之外；如目标目录不可写，请用
  `--app-dir "$HOME/.local/share/nodejs-argo-no-docker"` 显式指定可写目录。

以下示例使用 `install.lemon.vin`。如果你使用自己的 Worker 域名，请将命令中的地址全部替换为自己的 `/install.sh` 地址。

安装器地址提供的是当前已部署到 Worker 的版本。修改本地文件后，必须先执行
`npx wrangler deploy`，或提交到已连接的 Workers Builds 分支并等待部署完成，目标机器才会下载到新版本。

### 快速安装：交互式或一键运行

下面两种命令都先下载到临时文件，再由 `bash` 执行，不使用 `curl | bash` 或 `<(...)`。请把
`https://install.lemon.vin/install.sh` 替换成你自己的 Worker 地址。

通常不需要填写 `ARGO_PORT`（默认 `8001`）或 `UUID`（新机器会自动生成）。

#### 方式 A：交互式安装（推荐）

运行后在提示处输入 Worker 兑换密码；密码不会写入命令行参数或目标机器的 `.env`：

```bash
env \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash -c 'curl -fsSL --retry 3 -H "Cache-Control: no-cache" "https://install.lemon.vin/install.sh?ts=$(date +%s)" -o /tmp/install-lemon.sh && bash /tmp/install-lemon.sh'
```

#### 方式 B：非交互式一键安装

适合自动化环境或不方便输入密码的环境。将 Worker 上配置的兑换密码填入
`TEAMNODE_SYNC_ENROLL_PASSWORD`：

```bash
env \
  ARGO_AUTH='你的 Tunnel Token' \
  TEAMNODE_SYNC_ENROLL_PASSWORD='Worker 上配置的兑换密码' \
  ARGO_DOMAIN='你的域名' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash -c 'curl -fsSL --retry 3 -H "Cache-Control: no-cache" "https://install.lemon.vin/install.sh?ts=$(date +%s)" -o /tmp/install-lemon.sh && bash /tmp/install-lemon.sh'
```

如果是覆盖旧安装，再增加 `FORCE_KILL_PORTS='true'`；新机器不建议默认开启。真实兑换密码不要写入公开脚本、README、GitHub 或 Shell 历史。

#### 无 root 权限时安装

不需要先执行 `sudo`。直接以当前用户运行下面的命令，安装器会自动选择用户目录并使用用户级 PM2：

```bash
env \
  ARGO_AUTH='你的 Tunnel Token' \
  TEAMNODE_SYNC_ENROLL_PASSWORD='Worker 上配置的兑换密码' \
  ARGO_DOMAIN='你的域名' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash -c 'curl -fsSL --retry 3 -H "Cache-Control: no-cache" "https://install.lemon.vin/install.sh?ts=$(date +%s)" -o /tmp/install-lemon.sh && bash /tmp/install-lemon.sh'
```

非 root 默认目录为 `$HOME/.local/share/nodejs-argo-no-docker`。如该目录所在磁盘不可写，使用
`--app-dir "$HOME/你的目录"` 覆盖目录。此模式不会尝试安装系统软件包，不会删除或升级其他项目使用的
Node.js 12；当前项目缺少可用 Node.js/npm 时，只在自己的目录内下载项目专用运行时。安装完成后程序会立即运行，
但没有 root 权限时无法配置系统级开机自启。

### 新机器首次安装

先下载 Worker 动态生成的安装脚本。不要直接下载 GitHub 中的
`public/install.sh`，因为其中的源码地址和 SHA256 是占位符：

```bash
sudo -i

rm -f /tmp/install-lemon.sh
curl -fsSL --retry 3 \
  -H 'Cache-Control: no-cache' \
  "https://install.lemon.vin/install.sh?ts=$(date +%s)" \
  -o /tmp/install-lemon.sh

bash -n /tmp/install-lemon.sh
```

然后执行安装。未设置 `TEAMNODE_SYNC_ENROLL_PASSWORD` 时，脚本会在终端中隐藏输入兑换密码：

```bash
env \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash /tmp/install-lemon.sh
```

新机器不指定 `UUID` 时，安装器会自动生成 UUID。安装完成后，中继令牌会写入：

```text
/opt/nodejs-argo-no-docker/.env
```

目标机器只保存 `TEAMNODE_SYNC_RELAY_TOKEN`，不会保存 Worker 的
`TEAMNODE_SYNC_SECRET`。

### 旧版本机器覆盖安装最新版

覆盖安装会先停止本安装器创建的进程和服务，再删除旧的安装目录并重新安装。它适用于修复旧版安装器、更新后台运行逻辑、更新心跳逻辑或重新生成三种协议。

最新版安装器在覆盖已有安装且未指定 `UUID` 时，会自动复用旧 `.env` 中的 UUID，这样面板中的节点身份不会因为重新安装而改变。仍建议先读取并显式传入旧 UUID，不要直接打印整个 `.env`：

```bash
sudo -i

UUID="$(sed -n 's/^UUID=//p' /opt/nodejs-argo-no-docker/.env | head -n 1)"
if [ -z "${UUID}" ]; then
  echo '旧安装中没有找到 UUID，请手动指定一个 UUID' >&2
  exit 1
fi
```

下载并检查最新版安装器：

```bash
rm -f /tmp/install-lemon.sh
curl -fsSL --retry 3 \
  -H 'Cache-Control: no-cache' \
  "https://install.lemon.vin/install.sh?ts=$(date +%s)" \
  -o /tmp/install-lemon.sh

bash -n /tmp/install-lemon.sh
```

使用原来的 `UUID` 覆盖安装：

```bash
env \
  UUID="${UUID}" \
  FORCE_KILL_PORTS='true' \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash /tmp/install-lemon.sh
```

覆盖安装过程中会再次要求输入兑换密码，并为这个 UUID 重新获取中继令牌。不要同时设置 `TEAMNODE_SYNC_SECRET` 和 `TEAMNODE_SYNC_RELAY_TOKEN`；让 Worker 完成兑换即可。

如果旧 `.env` 已经被删除，安装器无法自动恢复原来的 UUID；此时需要从旧备份或原来的安装参数中找回并显式传入。只有新机器没有旧 `.env` 时，未指定 UUID 才会生成新的节点身份。

### 交互式安装

不设置兑换密码变量，安装器会隐藏提示输入密码：

```bash
curl -fsSL https://你的-worker.workers.dev/install.sh \
  -o /tmp/install-lemon.sh &&

env \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash /tmp/install-lemon.sh
```

安装器流程：

1. 生成或校验 UUID；
2. 提示输入 Worker 兑换密码；
3. Worker 校验密码，并根据 UUID 签发专属中继令牌；
4. 将中继令牌写入目标机器的 `.env`；
5. 下载并校验 cloudflared、Xray 和节点源码；
6. 启动并优先探测 Cloudflare Tunnel；
7. Tunnel 不可用时探测直连端口并自动切换。

兑换密码不会写入 `.env`，也不会打印到日志。

### 非交互式安装

自动化环境没有可用终端时，可以通过环境变量提供兑换密码：

```bash
curl -fsSL https://你的-worker.workers.dev/install.sh \
  -o /tmp/install-lemon.sh &&

env \
  TEAMNODE_SYNC_ENROLL_PASSWORD='Worker 上配置的兑换密码' \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash /tmp/install-lemon.sh
```

不要把真实兑换密码写入公开脚本、README、GitHub 或 Shell 历史。

`ARGO_PORT` 默认是 `8001`，通常不需要填写。`FORCE_KILL_PORTS=true` 只在覆盖旧安装、确认其他程序占用节点端口且需要强制清理时添加；新机器安装不建议默认开启。

安装器会检测已启用的 UFW、firewalld、nftables 或 iptables，并按 `CLOUDFLARED_PROTOCOL` 尝试幂等放行出站 `7844`：`http2` 为 TCP，`quic` 为 UDP，`auto` 为 TCP 和 UDP。Cloudflare Tunnel 是出站连接，不需要为了 Tunnel 打开入站 `7844`。云平台安全组、VPS 上游防火墙或服务商网络策略不在机器内部，安装器无法代为修改；面板会通过节点探测结果显示端口是否仍被阻断。

安装阶段 1 会先做网络前提检查，再下载和启动节点：

| 端口/地址 | 方向 | 检查方式 | 用途 |
| --- | --- | --- | --- |
| `TEAMNODE_SYNC_BASE_URL`，通常是 `install.lemon.vin` 的 HTTPS | 本机出站 | 安装器发起 HTTPS 心跳 | 确认 Worker 可访问，后续才能兑换令牌并执行公网回访 |
| Cloudflare Edge `7844/TCP` | 本机出站 | `http2` 或 `auto` 时做 TCP 连接心跳 | 确认 Tunnel 的 HTTP/2 传输路径 |
| Cloudflare Edge `7844/UDP` | 本机出站 | `quic` 或 `auto` 时做最佳努力 UDP 心跳 | 提前发现明显的 UDP 阻断；最终以 cloudflared 的 QUIC 握手为准 |
| `SERVER_PORT`（默认 3000）和 `ARGO_PORT`（默认 8001） | 本机监听 | 服务启动后用 `ss` 检查 | 应用内部端口，不属于公网入口，不会交给 Worker 探测 |
| `DIRECT_PORT_CANDIDATES`、`DIRECT_PORT_SCAN_PORTS`、`DIRECT_PORT_SCAN_RANGE` | 公网入站 | 服务启动后分别建立 IPv4/IPv6 临时监听；节点强制使用对应地址族请求 Worker，Worker 再分别回访公网 TCP 端口 | 覆盖两种地址族各自的云安全组、上游网络和运营商入口限制，决定直连端口；3000/8001 不参与 |

阶段 1 的 7844 预检会逐项显示协议、Edge 地址、端口和序号，每个 Edge 使用 6 秒硬超时，因此不会在空白状态下无限等待。所选协议的 7844 被明确判定为阻断后，安装器会跳过 cloudflared 下载、Tunnel 防火墙配置和 Tunnel 启动，节点直接进入 Worker 直连端口心跳；只有结果可用或无法可靠判断时才保留 Tunnel 路线。阶段 1 不能提前判断直连入站端口，因为此时节点还没有监听这些端口；直连端口必须在启动后的 Worker 外部回访中确认。即使扫描范围包含 `SERVER_PORT` 或 `ARGO_PORT`，安装器和节点也会把这两个本机端口从直连探测及直连防火墙候选中排除。安装器只有在本机服务监听检查和最终公网路线检查都通过后才完成安装。

启动阶段的 Tunnel 路由心跳默认最多重试 5 次、每次间隔 4 秒；可用 `STARTUP_TUNNEL_PROBE_ATTEMPTS` 和 `STARTUP_TUNNEL_PROBE_RETRY_DELAY_MS` 调整。Tunnel 心跳包括节点到 Cloudflare Edge 的 7844 出站连通性，以及 Worker 对最终 `ARGO_DOMAIN` 的回访；Worker 不会把 `install.lemon.vin:7844` 当作 Tunnel 目标，因为 7844 是节点到 Cloudflare Edge 的传输端口。

安装器默认也会准备 Nginx 和 Certbot，并尝试在已启用的主机防火墙中放行 `DIRECT_PORT_CANDIDATES`、当前直连端口以及 `DIRECT_PORT_SCAN_PORTS` 明确列出的入站 TCP 端口。自动路线选择需要 `CLOUDFLARE_API_KEY`：节点启动后先启动并验证 Cloudflare Tunnel；Tunnel 失败后，节点会检测公网 IPv4/IPv6，为当前一批候选端口分别建立 `0.0.0.0` 与 `[::]` 临时 TCP 监听，再强制通过对应地址族请求 `install.lemon.vin`，使 Worker 分别回访本次请求对应的公网地址。这一步能够独立覆盖 IPv4/IPv6 的云平台安全组、上游防火墙和运营商入口策略，不再把两种地址族混用。如果 TCP `443` 和 `80` 在所有启用地址族上都能从公网到达，则切换为 HTTPS 直连，在应用目录内申请并定期续期 Let's Encrypt 证书；Nginx 同时监听 IPv4/IPv6，自动派生的 `zhilian...` 直连域名创建 DNS-only `A`/`AAAA` 记录。证书申请默认最多尝试 3 次、每次失败后等待 30 秒，最终仍失败则自动改用 HTTP。如果 `443` 和 `80` 不同时可达，则优先寻找 IPv4/IPv6 共同可用的非标准 HTTP 端口；扫描结束仍没有共同端口时，才降级到单一可达地址族，并删除另一地址族的直连 DNS 记录。如果初始候选端口全部失败，节点会继续按 `DIRECT_PORT_SCAN_PORTS` 和 `DIRECT_PORT_SCAN_RANGE` 分批扩展探测，默认最多检查 256 个端口；可用 `DIRECT_PORT_SCAN_MAX=0` 关闭扩展扫描。能够从 `ARGO_AUTH` 解析固定 Tunnel ID 时，安装器还会保留或恢复 `ARGO_DOMAIN -> <Tunnel-ID>.cfargotunnel.com` 的代理 CNAME；旧版本遗留在 `ARGO_DOMAIN` 上的直连 A/AAAA 记录会被迁移掉。直连网关启动后，Worker 会按启用地址族分别检查公网 TCP，再向 `zhilian...` 最终域名发起 HTTP/HTTPS 请求；只有所有启用地址族和最终请求都通过，节点才会注册到面板。

直连地址族会按机器实际网络能力自动选择：

| 机器网络和公网回访结果 | Nginx 监听 | Cloudflare DNS | 持久化配置 |
| --- | --- | --- | --- |
| 仅 IPv4 可用 | `0.0.0.0:端口` | 只创建 DNS-only `A` | `DIRECT_IPV4_ENABLED=true`、`DIRECT_IPV6_ENABLED=false` |
| 仅 IPv6 可用 | `[::]:端口` | 只创建 DNS-only `AAAA` | `DIRECT_IPV4_ENABLED=false`、`DIRECT_IPV6_ENABLED=true` |
| IPv4、IPv6 都可用且存在共同端口 | 同时监听 `0.0.0.0` 和 `[::]` | 同时创建 DNS-only `A`、`AAAA` | 两个变量都为 `true` |
| 双栈机器没有共同端口，但其中一个地址族存在可达端口 | 只监听最终选中的可达地址族 | 删除不可达地址族记录，只保留可达的 `A` 或 `AAAA` | 根据实际回访结果启用一个地址族 |
| IPv4、IPv6 都没有公网可达端口 | 不启动直连网关 | 不发布新的直连记录 | 写入 `.no-route` 并以退出码 `78` 停止 |

默认的自动路线会根据 Worker 外部回访结果重写 `DIRECT_IPV4_ENABLED` 和 `DIRECT_IPV6_ENABLED`，不需要在安装命令中指定。只有手动设置 `DIRECT_MODE=true` 并关闭自动探测时，才需要自行指定。例如 IPv4-only：

```bash
DIRECT_IPV4_ENABLED=true
DIRECT_IPV6_ENABLED=false
```

IPv6-only：

```bash
DIRECT_IPV4_ENABLED=false
DIRECT_IPV6_ENABLED=true
```

这两个变量不能同时设置为 `false`。公网地址默认分别自动检测；需要固定地址时可使用 `CF_DNS_PUBLIC_IP` 和 `CF_DNS_PUBLIC_IPV6`。

如果 Tunnel 和直连都探测不到可用路线，程序不会继续空转重启：会在数据目录写入 `.no-route`，以退出码 `78` 停止，systemd、Supervisor 和 PM2 也会停止拉起。修复云平台安全组、上游防火墙或运营商网络后，重新运行安装器会清除该标记并再次按 Tunnel 优先顺序探测。直连模式下不会启动 Cloudflare Tunnel，也不会删除 Cloudflare 控制台中的远端 Tunnel 资源；仅清理本机运行进程和凭据文件，避免误删共享 Tunnel。

这三个扩展探测参数可以不指定，安装器会使用以下默认值：

```text
DIRECT_PORT_SCAN_PORTS=8000,8008,8081,8088,8090,8181,8444,8888,9000,9443,10000,11550-11570,20000,30000,40000,50000,60000
DIRECT_PORT_SCAN_RANGE=1024-65535
DIRECT_PORT_SCAN_MAX=256
```

实际探测顺序如下：

1. 第一批只并发检查标准入口 `80,443`，但 IPv4 和 IPv6 分成两个 Worker 请求独立回访。如果两种地址族的两个端口都开放且证书组件可用，则选择双栈 HTTPS 443；只有一个公网地址族时，对该地址族应用相同规则。
2. 标准入口不能形成可用方案时，按默认顺序检查 `8080,8443,8880,2053,2083,2087,2096`，每批最多 4 个端口；检测到双栈机器时优先选择两种地址族共同开放的端口。
3. 初始候选全部失败后，先检查 `DIRECT_PORT_SCAN_PORTS` 明确列出的端口，再从 `DIRECT_PORT_SCAN_RANGE` 中均匀抽样补足到 `DIRECT_PORT_SCAN_MAX`，仍然每批最多 4 个端口。范围扫描不是逐个检查 `1024-65535` 的全部端口。
4. 同一批端口在节点上按地址族并发建立临时监听，Worker 分别回访 IPv4/IPv6；批次之间串行执行。单端口公网 TCP 回访硬超时为 3.5 秒，发现满足当前地址族要求的端口后停止后续批次，并在 `finally` 阶段关闭整批临时监听。双栈机器扫描结束仍没有共同端口时，会保留至少一个真正可达的地址族，而不是发布不可达的 `A` 或 `AAAA`。

Worker 接口按每个地址族最多接受每批 4 个端口，为 Cloudflare Worker 的并发外连限制保留余量；IPv4/IPv6 使用两个独立请求，不会把 8 条连接塞进同一个 Worker 请求。默认选择顺序是 `80,8080,8443,8880,2053,2083,2087,2096,443`，然后才是其余自定义或扩展结果；非标准端口被选中时使用普通 HTTP。`SERVER_PORT`（默认 3000）和 `ARGO_PORT`（默认 8001）始终排除，扩展扫描还会排除 `22,25,53,110,143,587,3306,3389`。

将 `DIRECT_PORT_SCAN_MAX` 设置为 `0` 可关闭扩展扫描，最大值为 `4096`。默认 256 个端口在全部表现为超时的理论最坏情况下约需 `256 / 4 × 3.5 = 224` 秒，加上批次请求开销可能超过安装器默认的 180 秒等待时间。需要大范围探测时建议同时设置：

```bash
PUBLIC_ROUTE_VERIFY_TIMEOUT_SECONDS=600
```

这些变量应写入目标机器的 `/opt/nodejs-argo-no-docker/.env`，或在首次安装命令的 `env` 中传入，不需要配置为 Worker Secret。自动防火墙配置会放行 `DIRECT_PORT_SCAN_PORTS` 中明确列出的端口，但不会把整个 `DIRECT_PORT_SCAN_RANGE` 全量开放；使用范围抽样时，云安全组和已启用的主机防火墙必须允许对应端口，否则 Worker 会正确报告为不可达。

安装器只能修改目标机器上的 UFW、firewalld、nftables 或 iptables；云厂商安全组、上游防火墙和运营商网络仍需在厂商控制台放行。当前使用的 Cloudflare API Token 只应授予目标 Zone 的 DNS Read/Edit 权限，不要把 Token 放入 GitHub、公开安装命令或日志；如果曾经暴露过 Token，应先在 Cloudflare 中撤销并重新创建。

面板每台在线机器的 Cloudflare Tunnel 状态旁提供“立即检测”。点击后由 `install.lemon.vin` 排队并下发一次性检测指令，目标机器本地执行 7844 探测，再把结果回传到面板；启动前和每次心跳还会由 Worker 从公网验证最终 Tunnel/直连域名。7844 是 Tunnel 的出站传输端口，Worker 不能通过“连接本机入站 7844”判断 Tunnel；最终域名的公网请求才是 Tunnel 路由是否真正可访问的验证。对 `http2`，本机 TCP 7844 连接超时或失败会显示“出站端口被阻断”；这表示本机已经执行探测。若机器离线、服务未运行或没有在指令有效期内收到指令，面板会显示“本机未响应检测指令”，不能把这种情况直接等同于端口关闭。`quic` 的 UDP 端口不能用普通 TCP 连接判断，面板会以 cloudflared 实际 Tunnel 状态和协议要求为准。

### 安装完成后检查心跳

兑换成功只说明 Worker 已签发中继令牌，还需要确认 Node.js 已加载 `.env` 并成功发送心跳：

安装器会按 `1/10` 到 `10/10` 显示阶段进度，包括阶段 1 网络心跳预检、兑换令牌、下载并校验组件、写入配置、启动服务和运行检查。交互式终端下载组件时还会显示下载进度。安装检查分为三类：阶段 1 检查控制面和 Tunnel 出站前提；启动后只在本机等待 `SERVER_PORT` 和 `ARGO_PORT` 进入监听状态；随后单独等待 Worker 从公网验证最终 Tunnel/直连路线。3000/8001 等本机服务端口不会被当成公网入口探测，只有本机监听和最终公网路线都通过才会显示安装成功。

```bash
APP_DIR=/opt/nodejs-argo-no-docker

grep -E '^(TEAMNODE_SYNC_ENABLED|TEAMNODE_SYNC_BASE_URL|TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS)=' \
  "${APP_DIR}/.env"

for key in UUID TEAMNODE_SYNC_RELAY_TOKEN; do
  if grep -q "^${key}=" "${APP_DIR}/.env"; then
    echo "${key}=present"
  else
    echo "${key}=missing"
  fi
done

grep -Ei 'TeamNode|注册|心跳|同步|relay|失败|error' \
  "${APP_DIR}/data/nodejs-argo.log" | tail -50
```

日志中应出现：

```text
TeamNode 注册成功
TeamNode 心跳成功
```

也可以检查本机 Node.js 服务和订阅内容：

```bash
ps aux | grep -E 'run.sh|index.js' | grep -v grep

curl -fsS -o /tmp/sub-check http://127.0.0.1:3000/sub
wc -c /tmp/sub-check
```

确认日志出现“注册成功”或“心跳成功”后，刷新监控面板。面板现在每 30 秒只更新节点内容，不会重新加载整个页面。

### 关闭 TeamNode 同步

如果某台机器不需要 TeamNode：

```bash
curl -fsSL https://你的-worker.workers.dev/install.sh \
  -o /tmp/install-lemon.sh &&

env \
  TEAMNODE_SYNC_ENABLED='false' \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  bash /tmp/install-lemon.sh
```

## 三、端口和协议转发

默认端口关系如下：

| 端口 | 用途 |
| --- | --- |
| `3000` | Node HTTP 服务、订阅和状态接口 |
| `8001` | Cloudflare Tunnel HTTP/WebSocket 网关 |
| `3002` | Xray VLESS WebSocket |
| `3003` | Xray VMess WebSocket |
| `3004` | Xray Trojan WebSocket |

Cloudflare Tunnel 的 Public Hostname 必须指向：

```text
http://127.0.0.1:8001
```

网关路径为：

```text
/vless-argo  → 127.0.0.1:3002
/vmess-argo  → 127.0.0.1:3003
/trojan-argo → 127.0.0.1:3004
```

如果 Tunnel 仍然指向旧端口，通常会出现 502、400 或客户端测速延迟 `-1`。

检查三种协议是否生成：

```bash
base64 -d /opt/nodejs-argo-no-docker/data/sub.txt \
  | grep -E '^(vless|vmess|trojan)://'
```

## 四、启动和重启

安装器按以下顺序自动选择启动方式：

```text
systemd → OpenRC → SysV/init.d → Supervisor → rc.local → cron/crond
```

如果系统没有可用的 init 或 cron，安装器会使用固定版本 PM2（默认 `5.4.3`）保证 Node 进程退出后自动重启，但无法保证机器重启后自动启动。

节点路由选择顺序为：

```text
启动前 Tunnel 7844 出站心跳 → Worker 公网路由心跳 → 直连候选端口发现心跳/扩展端口发现 → 两者都失败则退出码 78 停止
```

切换到直连时会停止本机 `cloudflared`、删除本机 `tunnel.json`/`tunnel.yml`，并在下一次启动时只运行直连网关。远端 Cloudflare Tunnel 不会被自动删除。

可手动指定：

```bash
export SERVICE_MODE=auto
bash /tmp/install-lemon.sh
```

可用模式：`auto`、`systemd`、`openrc`、`sysv`、`supervisor`、`rc.local`、`cron`、`none`。

如果系统已经安装并配置了 Supervisor，`auto` 会优先使用它，并在
`/etc/supervisor/conf.d/` 或 `/etc/supervisord.d/` 写入本安装器的配置。没有可用
Supervisor 时仍会继续尝试其他启动方式。

运行包装器会先加载 `/opt/nodejs-argo-no-docker/.env`，再启动 Node.js，因此
`ARGO_DOMAIN`、`BIN_PATH`、TeamNode 中继令牌等变量不会依赖 `su/runuser` 的隐式环境继承。
启动器和子进程日志位于：

```text
/opt/nodejs-argo-no-docker/data/nodejs-argo.log
/opt/nodejs-argo-no-docker/data/runner-launcher.log
/opt/nodejs-argo-no-docker/data/xray-boot.log
/opt/nodejs-argo-no-docker/data/cloudflared-boot.log
```

正常重启不会重新输入兑换密码。UUID 和中继令牌会保存在：

```text
/opt/nodejs-argo-no-docker/.env
```

只有删除 `.env`、重新安装，或更换 Worker 的 `TEAMNODE_SYNC_SECRET` 后，才需要重新兑换。

## 五、重复安装和清理

每次正式安装前，安装器会：

- 在删除旧目录前读取旧 `.env` 中的 UUID，用于保持节点身份；
- 停止本安装器创建的服务、runner 和 PM2；
- 明确删除旧的 `/opt/nodejs-argo-no-docker/.env`；
- 删除旧的 `/opt/nodejs-argo-no-docker`；
- 清理本安装器对应的旧进程；
- 检查 `3000`、`8001`、`3001-3004` 端口；
- 默认拒绝误杀其他业务进程。

清理完成后，安装器会根据本次参数和兑换结果重新创建全新的 `.env`，不会保留旧的
`ARGO_AUTH`、TeamNode 中继令牌或其他旧配置行。旧 UUID 只会在内存中暂时复用，不会通过旧 `.env` 直接复制其他配置。

确认需要强制终止端口占用时，才设置：

```bash
FORCE_KILL_PORTS=true
```

卸载：

```bash
curl -fsSL https://你的-worker.workers.dev/install.sh -o /tmp/install-lemon.sh && bash /tmp/install-lemon.sh --uninstall
```

卸载只处理本安装器创建的目录和启动配置，不会删除系统全局 PM2。

卸载后重新安装并保留原 UUID：

```bash
APP=/opt/nodejs-argo-no-docker
UUID_OLD="$(sed -n 's/^UUID=//p' "${APP}/.env" 2>/dev/null | head -n 1)"

curl -fsSL https://你的-worker.workers.dev/install.sh \
  -o /tmp/install-lemon-uninstall.sh &&
bash /tmp/install-lemon-uninstall.sh --uninstall &&

curl -fsSL https://你的-worker.workers.dev/install.sh \
  -o /tmp/install-lemon-install.sh &&
env \
  UUID="${UUID_OLD}" \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash /tmp/install-lemon-install.sh
```

安装时会再次交互输入兑换密码；自动化环境再增加
`TEAMNODE_SYNC_ENROLL_PASSWORD='Worker 上配置的兑换密码'`。

## 六、升级 Worker 和节点源码

更新以下文件后重新部署 Worker：

```text
public/install.sh
public/agent/index.js
src/index.js
```

重新部署：

```bash
npx wrangler deploy
```

如果已启用 Cloudflare Workers Builds，连接的 GitHub 分支更新后会由 Cloudflare 自动构建；Worker Secret 不会因为代码重新部署而写入仓库。

## 七、安全注意事项

- TeamNode 主密钥只放在 Worker Secret；
- 兑换密码只用于首次获取中继令牌；
- 中继令牌按 UUID 签发并保存于目标机器 `.env`，权限为 `0600`；
- 在线机器状态保存在 Durable Object；面板默认公开，设置 `DASHBOARD_PASSWORD` 后根页面和 JSON 接口启用 Basic Auth；
- `ARGO_AUTH` 也会写入目标机器 `.env`，不要提交到 GitHub；
- Worker 和公开安装脚本中不包含真实主密钥；
- `FORCE_KILL_PORTS=true` 可能终止其他服务，使用前确认端口；
- 当前 Worker 不限制兑换密码的尝试次数，兑换密码应使用足够长的随机值并定期更换；
- 公开面板会显示机器出口 IP，请确认这是你愿意公开的信息；
- 更换 `TEAMNODE_SYNC_SECRET` 后，已有机器需要重新运行安装器完成令牌兑换。
