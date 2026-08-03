# workers-installer

这是一个 Cloudflare Worker 安装器项目，用于在没有 Docker 的 Linux 机器上部署 nodejs-argo，并在 Cloudflare Tunnel 不可用时自动选择可验证的直连路线。

目标机器提供 VLESS、VMess、Trojan 三种 WebSocket 节点。Worker 不运行节点程序，只负责：

- 动态生成并校验 `install.sh` 和 `/agent/index.js`；
- 兑换每台机器专属的 TeamNode 中继令牌；
- 从公网回访 Tunnel 或直连路线；
- 代理健康节点的注册、心跳和下线请求；
- 隔离公网路线异常的 UUID，不展示节点详情，也不转发 TeamNode。

## 目录

- [一、路线概览](#一路线概览)
- [二、部署 Cloudflare Worker](#二部署-cloudflare-worker)
- [三、安装节点](#三安装节点)
- [四、安装参数](#四安装参数)
- [五、心跳、端口与直连探测](#五心跳端口与直连探测)
- [六、监控面板与 UUID 隔离](#六监控面板与-uuid-隔离)
- [七、运行、日志与排障](#七运行日志与排障)
- [八、覆盖安装与卸载](#八覆盖安装与卸载)
- [九、升级 Worker](#九升级-worker)
- [十、安全注意事项](#十安全注意事项)

## 一、路线概览

程序始终优先检查 Cloudflare Tunnel。`DIRECT_USE_CLOUDFLARE_PROXY` 只决定 Tunnel 失败后的标准直连方式，不会强制跳过可用的 Tunnel。

```text
阶段 1 检查控制面和 Cloudflare Edge 7844
  ├─ 7844 可尝试 → 启动 Tunnel → Worker 回访 ARGO_DOMAIN
  │                              ├─ 成功：Tunnel 模式
  │                              └─ 失败：进入直连探测
  └─ 7844 明确阻断 → 跳过 cloudflared 的下载、安装、更新和启动 → 进入直连探测

直连探测
  ├─ 默认小黄云：源站 HTTP 80 可达 → Cloudflare 边缘 HTTPS 443
  ├─ 关闭小黄云：源站 80+443 均可达 → Certbot + 本机 HTTPS 443
  ├─ 标准路线失败：扫描灰云 HTTP 非标准端口
  └─ 全部失败：写入 .no-route，以退出码 78 停止
```

### 域名和节点地址

`ARGO_DOMAIN` 永远预留给 Cloudflare Tunnel。直连域名由安装器自动在最左侧标签前加 `zhilian`：

```text
Tunnel 域名：boxd06.openlemon.cyou
直连域名：  zhilianboxd06.openlemon.cyou
```

| 实际路线 | 客户端连接地址 `add` | WebSocket `host` / TLS `sni` | 端口与 TLS |
| --- | --- | --- | --- |
| Cloudflare Tunnel | `CFIP` | `ARGO_DOMAIN` | `CFPORT`，默认 TLS 443 |
| 小黄云直连 | `CFIP` | `zhilian...` | Cloudflare 边缘 TLS 443，源站 HTTP 80 |
| Certbot 直连 | `zhilian...` | `zhilian...` | 本机 TLS 443，HTTP 80 用于 ACME 和跳转 |
| 非标准 HTTP 直连 | `zhilian...` | `zhilian...` | Worker 发现的灰云 HTTP 端口，无 TLS |

每台机器必须使用唯一的 `ARGO_DOMAIN`，否则会派生出相同的直连域名并互相覆盖 DNS。

## 二、部署 Cloudflare Worker

### 1. 登录与 Secret

```bash
cd workers-installer
npx wrangler login
```

在 Cloudflare 控制台打开：

```text
Workers & Pages
→ workers-installer
→ Settings
→ Variables and Secrets
```

必须配置以下 Secret：

| 名称 | 用途 |
| --- | --- |
| `TEAMNODE_SYNC_SECRET` | TeamNode 主密钥，只保存在 Worker |
| `TEAMNODE_SYNC_ENROLL_PASSWORD` | 安装节点时兑换中继令牌的密码 |

命令行配置方式：

```bash
npx wrangler secret put TEAMNODE_SYNC_SECRET
npx wrangler secret put TEAMNODE_SYNC_ENROLL_PASSWORD
```

不要在 Worker 中配置固定的 `TEAMNODE_SYNC_RELAY_TOKEN`。Worker 会根据 UUID 为每台机器签发独立令牌。

### 2. Cloudflare DNS API Token

需要自动保留 Tunnel CNAME、创建直连 A/AAAA、切换小黄云或灰云时，再配置：

```bash
npx wrangler secret put CLOUDFLARE_API_KEY
```

变量名虽然叫 `CLOUDFLARE_API_KEY`，实际建议填写 Cloudflare 自定义 API Token，不要使用 Global API Key。

Token 权限：

| 使用方式 | 权限 |
| --- | --- |
| 两种直连方式都需要 | `Zone > DNS > Edit`、`Zone > Zone > Read` |
| 默认小黄云额外需要 | `Zone > Config Rules > Edit` |

区域资源选择包含目标域名所在的 Zone。Certbot 灰云路线不会调用 Flexible Configuration Rule，因此不要求 `Config Rules:Edit`。

### 3. 面板访问控制

面板默认公开。如需 Basic Auth：

```bash
npx wrangler secret put DASHBOARD_PASSWORD
```

可选 Text 变量 `DASHBOARD_USER` 用于修改用户名，默认是 `admin`。如果要恢复公开访问，请删除 `DASHBOARD_PASSWORD`，不要把它设置为空字符串。

### 4. 构建和部署

Workers Builds 使用：

```text
根目录：/
构建命令：留空
部署命令：npx wrangler deploy
非生产分支部署命令：npx wrangler deploy
```

手动部署：

```bash
npx wrangler deploy
```

`wrangler.jsonc` 中的 `keep_vars: true` 会保留控制台配置的变量和 Secret。自动修复配置时，不要删除 `durable_objects` 和 `migrations`。

添加 Worker Custom Domain 后，可以使用：

```text
https://install.lemon.vin/
https://install.lemon.vin/install.sh
```

### 5. Worker 路径

| 地址 | 用途 |
| --- | --- |
| `/` | 在线机器面板 |
| `/install.sh` | 动态安装脚本 |
| `/inatall.sh` | 兼容旧拼写 |
| `/agent/index.js` | 节点程序源码 |
| `/agent/package-lock.json` | 节点 npm 依赖锁文件 |
| `/healthz` | Worker 健康检查 |
| `/api/nodes` | 在线机器 JSON |

每次请求 `/install.sh` 时，Worker 都会重新计算 `/agent/index.js` 与 `/agent/package-lock.json` 的 SHA256 并注入下载地址。安装器校验两者后通过 `npm ci` 安装固定版本依赖。不要直接运行仓库中的 `public/install.sh`，其中的地址和校验值是构建占位符。

## 三、安装节点

以下示例使用 `https://install.lemon.vin/install.sh`，请按实际 Worker 地址替换。

### 1. 安装前提

- Linux `amd64` 或 `arm64`；
- 能通过 HTTPS 访问 Worker、GitHub Release 和 npm；
- 每台机器使用唯一的 `ARGO_DOMAIN` 和 Tunnel 凭据；
- 推荐 root 安装，以便自动安装 Nginx/Certbot、配置主机防火墙和系统服务；
- 云厂商安全组需要由用户在控制台放行，安装器只能修改机器内部防火墙。

系统 Node.js 低于 20 时，安装器会在项目目录安装专用 Node.js 20，不替换其他项目使用的全局 Node.js。

### 2. 交互式安装

不传兑换密码时，安装器会在终端中隐藏输入：

```bash
env \
  ARGO_AUTH='你的 Tunnel Token 或 JSON' \
  ARGO_DOMAIN='boxd06.openlemon.cyou' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash -c 'curl -fsSL --retry 3 -H "Cache-Control: no-cache" "https://install.lemon.vin/install.sh?ts=$(date +%s)" -o /tmp/install-lemon.sh && bash /tmp/install-lemon.sh'
```

### 3. 非交互式安装

自动化环境可以通过环境变量提供兑换密码：

```bash
env \
  ARGO_AUTH='你的 Tunnel Token 或 JSON' \
  TEAMNODE_SYNC_ENROLL_PASSWORD='Worker 上配置的兑换密码' \
  ARGO_DOMAIN='boxd06.openlemon.cyou' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash -c 'curl -fsSL --retry 3 -H "Cache-Control: no-cache" "https://install.lemon.vin/install.sh?ts=$(date +%s)" -o /tmp/install-lemon.sh && bash /tmp/install-lemon.sh'
```

真实兑换密码不要写入公开脚本、README、GitHub 或长期保留的 Shell 历史。

### 4. 选择小黄云或 Certbot

默认开启小黄云，下面的开关可以省略：

```bash
DIRECT_USE_CLOUDFLARE_PROXY=true
```

默认路线要求 VPS 公网 HTTP 80 可达。程序把 `zhilian...` A/AAAA 设置为 Proxied，并为这个主机名创建 Flexible 回源规则。Cloudflare 接收 HTTPS 443，VPS 只监听 HTTP 80，不安装 Certbot。节点 `add` 使用 `CFIP`。

关闭小黄云并使用本机证书，只需在安装命令的 `env` 中增加：

```bash
DIRECT_USE_CLOUDFLARE_PROXY=false
```

`DIRECT_LETSENCRYPT_EMAIL` 默认是 `admin@lemon.vin`，不指定也能申请和续期。需要使用自己的通知邮箱时再覆盖：

```bash
DIRECT_LETSENCRYPT_EMAIL='你的有效邮箱'
```

Certbot 路线只有在 Worker 确认同一地址族的公网 TCP 80 和 443 都可达后才会启用。程序会把 `zhilian...` 改为 DNS Only，先在 80 完成 HTTP-01，再让 Nginx 同时监听 80/443；启动后立即检查一次续期，之后每 12 小时检查并重新加载 Nginx。

如果证书连续重试仍失败，程序会降级到已经验证的灰云 HTTP 端口。频繁覆盖安装会删除安装目录中的 Certbot 状态并重新申请证书，可能触发 Let's Encrypt 频率限制；普通重启请使用服务管理命令，不要反复重跑安装器。

### 5. 非 root 安装

非 root 用户可以完整安装到自己的用户目录，不需要先执行 `sudo`。直接以当前用户运行安装命令即可，默认目录是：

```text
$HOME/.local/share/nodejs-argo-no-docker
```

完整示例：

```bash
curl -fsSL --retry 3 \
  -H 'Cache-Control: no-cache' \
  "https://install.lemon.vin/install.sh?ts=$(date +%s)" \
  -o /tmp/install-lemon.sh

env \
  ARGO_AUTH='你的 Tunnel Token 或 JSON' \
  TEAMNODE_SYNC_ENROLL_PASSWORD='Worker 上配置的兑换密码' \
  ARGO_DOMAIN='boxd06.openlemon.cyou' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash /tmp/install-lemon.sh \
    --app-dir "$HOME/.local/share/nodejs-argo-no-docker"
```

非 root 模式：

- 不修改 `/opt`、`/etc` 或系统级服务；
- 不安装系统 Nginx、Certbot 或系统 Node.js；
- 缺少 Node.js/npm 时只在项目目录安装专用运行时；
- 使用当前用户目录中的 PM2 保持进程运行；非 root 模式不具备系统级开机自启权限，机器重启后可能需要手动启动；
- 通常不能监听 80/443，因此标准直连回退需要系统已经提供可用 Nginx 和相应权限；Tunnel 模式不受此入站端口限制。

root 安装使用 systemd 时通过服务能力监听 80/443；使用 OpenRC、SysV、Supervisor、rc.local、cron 或 root PM2 时，安装器会复制项目私有的 Node/Nginx 可执行文件并只授予 `CAP_NET_BIND_SERVICE`，不会修改系统 Node.js/Nginx。文件系统或内核不支持该能力时，会跳过不可绑定的低端口并继续探测非特权高端口。

可用以下参数指定用户目录：

```bash
bash /tmp/install-lemon.sh --app-dir "$HOME/你的目录"
```

## 四、安装参数

### 必填参数

| 参数 | 说明 |
| --- | --- |
| `ARGO_AUTH` | Cloudflare Tunnel Token 或 JSON |
| `ARGO_DOMAIN` | 固定 Tunnel 域名；同时用于派生 `zhilian...` 直连域名 |

TeamNode 同步启用时，还必须通过交互输入或 `TEAMNODE_SYNC_ENROLL_PASSWORD` 提供兑换密码。

### 常用参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `CFIP` | 空 | Tunnel 和小黄云节点的连接地址，例如 `cdst.lemon.vin`；建议明确设置，未设置时运行时会使用内置回退地址 |
| `NAME` | 空 | 节点名称前缀 |
| `UUID` | 自动生成或复用旧值 | 节点身份；覆盖安装不指定时优先读取旧 `.env` |
| `ARGO_PORT` | `8001` | 本机 Tunnel HTTP/WebSocket 网关 |
| `CLOUDFLARED_PROTOCOL` | `http2` | `http2`、`quic` 或 `auto` |
| `AUTO_DIRECT_FALLBACK` | `true` | Tunnel 失败后是否探测直连 |
| `DIRECT_USE_CLOUDFLARE_PROXY` | `true` | `true` 为小黄云；`false` 为 Certbot 灰云 |
| `AUTO_CONFIGURE_FIREWALL` | `true` | 自动修改已启用的主机防火墙 |
| `PUBLIC_ROUTE_VERIFY_TIMEOUT_SECONDS` | `600` | 安装器等待端口发现和最终公网路线验证，范围 30–600 秒 |
| `FORCE_KILL_PORTS` | `false` | 强制终止占用项目端口的其他进程，谨慎使用 |
| `SERVICE_MODE` | `auto` | root 安装的守护方式：`systemd`、`openrc`、`sysv`、`supervisor`、`rc.local`、`cron` 或 `none` |
| `TEAMNODE_SYNC_ENABLED` | `true` | 是否注册并同步 TeamNode |

### 证书参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `DIRECT_LETSENCRYPT_EMAIL` | `admin@lemon.vin` | Let's Encrypt 注册和通知邮箱 |
| `DIRECT_CERT_FILE` | 空 | 自备证书；必须与 `DIRECT_KEY_FILE` 同时设置 |
| `DIRECT_KEY_FILE` | 空 | 自备私钥；设置后不由 Certbot 续期 |
| `DIRECT_CERTIFICATE_ATTEMPTS` | `3` | 证书申请重试次数，范围 1–5 |
| `DIRECT_CERTIFICATE_RETRY_DELAY_MS` | `30000` | 证书重试间隔，范围 5000–300000 毫秒 |

### 网络和扫描参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `DIRECT_IPV4_ENABLED` | `true` | 允许直连使用 IPv4；自动探测会按结果重写 |
| `DIRECT_IPV6_ENABLED` | `true` | 允许直连使用 IPv6；自动探测会按结果重写 |
| `CF_DNS_PUBLIC_IP` | 自动检测 | 固定公网 IPv4 |
| `CF_DNS_PUBLIC_IPV6` | 自动检测 | 固定公网 IPv6 |
| `DIRECT_PORT_CANDIDATES` | `80,443,8080,8443,8880,2053,2083,2087,2096` | 初始公网入站候选端口 |
| `DIRECT_PORT_SCAN_PORTS` | 见下方 | 扩展扫描的明确端口和范围 |
| `DIRECT_PORT_SCAN_RANGE` | `1024-65535` | 扩展扫描抽样范围 |
| `DIRECT_PORT_SCAN_MAX` | `256` | 扩展扫描最大样本数，最大 `4096`；`0` 关闭扩展扫描 |

`DIRECT_PORT_SCAN_PORTS` 默认值：

```text
8000,8008,8081,8088,8090,8181,8444,8888,9000,9443,10000,11550-11570,20000,30000,40000,50000,60000
```

`DIRECT_CLOUDFLARE_PROXY_ENABLED`、`DIRECT_REUSE_*`、`DIRECT_MODE`、`DIRECT_PORT` 和 `DIRECT_HTTP_PORT` 是程序根据探测结果维护的运行状态，通常不要作为用户偏好手动设置。

### 运行时参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `SERVER_PORT` | `3000` | Node HTTP 服务，只做本机监听检查 |
| `TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS` | `300000` | TeamNode 心跳间隔 |
| `TEAMNODE_SYNC_COMMAND_POLL_INTERVAL_MS` | `15000` | 面板检测指令轮询间隔，允许 5–60 秒 |
| `NODE_RUNTIME_VERSION` | `20.20.2` | 系统 Node.js 低于 20 时使用的项目专用版本 |
| `NODE_RUNTIME_SHA256` | 内置或手动提供 | 自定义 Node.js 版本时的 SHA256 |

## 五、心跳、端口与直连探测

### 1. 端口角色

| 端口 | 方向 | 是否公网探测 | 用途 |
| --- | --- | --- | --- |
| `3000` | 本机监听 | 否 | Node HTTP、订阅和状态接口 |
| `8001` | 本机监听 | 否 | Tunnel HTTP/WebSocket 网关 |
| `3001` | 本机回环 | 否 | Xray 内部 TCP 入口 |
| `3002` | 本机回环 | 否 | Xray VLESS WebSocket |
| `3003` | 本机回环 | 否 | Xray VMess WebSocket |
| `3004` | 本机回环 | 否 | Xray Trojan WebSocket |
| `7844/TCP` | 本机出站 | 本机预检 | cloudflared HTTP/2 连接 Cloudflare Edge |
| `7844/UDP` | 本机出站 | 本机预检 | cloudflared QUIC 连接 Cloudflare Edge |
| `80/443/候选端口` | 公网入站 | Worker 外部回访 | 直连入口和证书前提 |

Cloudflare Tunnel 不需要开放入站 7844。安装器只检查节点到 Cloudflare Edge 的出站 7844；Worker 不会连接 `install.lemon.vin:7844`，也不会把 VPS 的 7844 当作入站端口。

`3000`、`8001` 和 Xray 的 `3001–3004` 都是本机服务端口，始终从直连候选和公网扫描中排除。安装完成前还会检查 `3002/3003/3004` 是否真实监听。

### 2. 安装阶段 1

阶段 1 会显示具体协议、Edge 地址、端口和进度：

1. 本机访问 Worker HTTPS，确认控制面可用；
2. 根据 `CLOUDFLARED_PROTOCOL` 检查 TCP、UDP 或两者的 7844；
3. 7844 明确阻断、显式直连或平台代理模式时，跳过 cloudflared 的下载、安装、更新、防火墙配置和启动；
4. 此时不检查直连入站端口，因为节点尚未建立临时监听。

每个 Edge 使用 6 秒硬超时，避免终端长时间没有任何输出。UDP 预检只能发现明显阻断，QUIC 最终仍以 cloudflared 实际握手为准。

### 3. Tunnel 最终心跳

Tunnel 启动后同时验证：

- 本机到 Cloudflare Edge 的 7844 传输；
- Worker 对最终 `ARGO_DOMAIN` 的 HTTP/HTTPS 回访；
- Worker 分别对 `/vless-argo`、`/vmess-argo`、`/trojan-argo` 完成 WebSocket 升级。

只有传输、页面和三种协议 WebSocket 全部成功才会显示 Tunnel 模式可用。默认最多尝试 5 次，每次间隔 4 秒；可用 `STARTUP_TUNNEL_PROBE_ATTEMPTS` 和 `STARTUP_TUNNEL_PROBE_RETRY_DELAY_MS` 调整。

### 4. 直连端口顺序

1. 如果覆盖安装保存了上次成功路线，先复验它实际需要的地址族和端口；
2. 小黄云偏好先检查源站 80；
3. Certbot 偏好先检查同一地址族的 80+443；
4. 标准路线不成立后，按初始候选端口寻找灰云 HTTP；
5. 初始候选失败后，按 `DIRECT_PORT_SCAN_PORTS` 和 `DIRECT_PORT_SCAN_RANGE` 扩展抽样；
6. 找到任一可用地址族后，只在另一地址族复验相同路线所需端口；
7. 全部失败时退出码 78 停止，不反复拉起异常节点。

Worker 每个地址族、每批最多回访 4 个端口，为 Cloudflare Worker 的并发外连限制保留余量。单端口 TCP 回访硬超时为 3.5 秒。

`DIRECT_PORT_SCAN_RANGE` 不是逐个扫描全部 1024–65535，而是均匀抽样补足到 `DIRECT_PORT_SCAN_MAX`。默认 256 个样本在单地址族全部超时的理论最坏时间约 224 秒。扫描会在安装器总等待时间结束前 45 秒停止，为 DNS 生效和最终 HTTP/WebSocket 回访保留时间。默认已经使用：

```bash
PUBLIC_ROUTE_VERIFY_TIMEOUT_SECONDS=600
```

### 5. IPv4 和 IPv6

| 外部回访结果 | 监听和 DNS |
| --- | --- |
| 仅 IPv4 成功 | 只监听 IPv4，只创建 A |
| 仅 IPv6 成功 | 只监听 IPv6，只创建 AAAA |
| 相同路线双栈都成功 | 同时监听 IPv4/IPv6，创建 A 和 AAAA |
| IPv4 成功、IPv6 同端口失败 | 立即使用 IPv4，删除或不发布 AAAA |
| IPv4 本批失败、IPv6 成功 | 使用 IPv6-only 路线 |
| 两者都失败 | 不发布直连记录并停止 |

程序按回访结果重写 `DIRECT_IPV4_ENABLED` 和 `DIRECT_IPV6_ENABLED`，不会发布未经 Worker 验证的地址族。

### 6. 防火墙边界

安装器可以修改目标机器上已经启用的 UFW、firewalld、nftables 或 iptables：

- Tunnel：按协议放行出站 TCP/UDP 7844；
- 直连：放行初始候选、扩展明确端口，以及与实际均匀抽样算法一致的最多 `DIRECT_PORT_SCAN_MAX` 个入站 TCP 端口；
- 不会把整个 `DIRECT_PORT_SCAN_RANGE` 无限制全部开放。

如果当前路线不使用 Tunnel，安装器不会配置 7844，也不会下载或更新 cloudflared。Tunnel 路线使用安装器校验过的版本，并以 `--no-autoupdate` 运行；升级只会在后续安装仍判定需要 Tunnel 时发生。

云厂商安全组、上游防火墙和运营商网络不在机器内部，必须在厂商控制台放行。只有 Worker 从公网成功回访，才能说明完整链路真正可用。

### 7. Nginx 长连接配置

直连 Nginx 会按 VPS 能力自动使用 CPU Worker，并应用适合 WebSocket 长连接的配置：

- `worker_rlimit_nofile 65535`，每个 Worker 最多 8192 个连接；
- 启用 `multi_accept`、TCP `nopush/nodelay` 和 socket keepalive；
- 关闭代理缓存、响应缓冲和请求缓冲；
- WebSocket 代理读写超时为 24 小时；
- 保留真实来源和转发协议 Header；
- Certbot 路线启用 TLS 1.2/1.3 和共享 TLS session cache。

这些设置用于减少长连接被错误中断并提高并发利用率，但实际速度仍受 VPS 带宽、CPU、路由质量、Cloudflare 和客户端网络限制。

## 六、监控面板与 UUID 隔离

面板显示：

- 节点名称、地区、Provider、系统、架构、CPU 和内存；
- 公网 IPv4 和 IPv6；
- TeamNode 心跳和最终公网路线；
- Cloudflare Tunnel、直连协议、端口、HTTP 状态和失败原因；
- 在线、超时、离线筛选。

### UUID 隔离

公网路线明确异常时，Worker：

1. 只保存 UUID、首次/最后拦截时间、10 分钟恢复期限和拦截次数；
2. 删除同 UUID 的可见节点详情；
3. 不写入 `/api/nodes`，不显示在面板；
4. 不向 `teamnode.lemon.vin` 转发注册、心跳或下线；
5. 后续相同 UUID 的异常或状态不明上报继续丢弃。

超过 10 分钟未恢复不会自动解除隔离。只有节点明确通过最终公网路线验证，并且 TeamNode 同步成功，Worker 才会原子解除隔离并重新展示节点。

### 节点保留时间

- 累计心跳少于 5 次的节点，在下线或超时后直接删除；
- 累计至少 5 次心跳的节点，明确下线后 0–5 分钟显示“超时”，5–10 分钟显示“离线”，之后删除；
- 未明确下线但超过心跳阈值的节点显示“离线”，最后活动超过 10 分钟后删除。

Worker 不会主动替节点生成心跳。`TEAMNODE_DASHBOARD_HEARTBEAT_TIMEOUT_MS` 可调整超时阈值，`TEAMNODE_DASHBOARD_ONLINE_TTL_MS` 可调整删除时间。

### 立即检测

点击节点上的“立即检测”后：

1. Worker 排队一次性检测指令；
2. 节点轮询并在本机执行 7844 检测；
3. 节点把结果回传面板；
4. Worker 仍以最终域名回访判断完整路线。

“本机未响应检测指令”表示机器离线、服务未运行或没有及时轮询，不能直接等同于 7844 被关闭。

## 七、运行、日志与排障

### 1. 启动方式

安装器按系统能力选择：

```text
systemd → OpenRC → SysV/init.d → Supervisor → rc.local → cron/crond → PM2
```

root 安装默认目录：

```text
/opt/nodejs-argo-no-docker
```

正常重启不需要重新输入兑换密码。UUID 和中继令牌保存在权限为 `0600` 的 `.env`。

### 2. 日志

安装器只补齐本应用实际缺失的启动工具，不批量安装或升级系统软件。系统 Node.js/npm 永远不会由包管理器安装或升级：版本满足要求时只读复用，否则把项目专用 Node.js/npm 下载到应用目录。Nginx/Certbot 仅在启用直连功能且确实缺失时安装，并禁止升级系统已有版本；缺少 `setcap` 时只降级高端口，不自动安装 libcap。

依赖安装不会隐藏包管理器输出：apt 会显示软件源索引和 dpkg 过程，apk、dnf、yum、zypper 会显示各自的下载/安装进度；日志先列出“本应用缺失软件包”，完成后再逐项显示工具状态和版本。

systemd：

```bash
journalctl -u nodejs-argo-no-docker.service -f
```

项目日志：

```text
/opt/nodejs-argo-no-docker/data/nodejs-argo.log
/opt/nodejs-argo-no-docker/data/runner-launcher.log
/opt/nodejs-argo-no-docker/data/xray-boot.log
/opt/nodejs-argo-no-docker/data/cloudflared-boot.log
/opt/nodejs-argo-no-docker/data/nginx-boot.log
```

### 3. 安装后检查

```bash
APP_DIR=/opt/nodejs-argo-no-docker

for key in UUID TEAMNODE_SYNC_RELAY_TOKEN; do
  if grep -q "^${key}=" "${APP_DIR}/.env"; then
    echo "${key}=present"
  else
    echo "${key}=missing"
  fi
done

grep -Ei 'TeamNode|注册|心跳|同步|公网路线|证书|失败|error' \
  "${APP_DIR}/data/nodejs-argo.log" | tail -80
```

正常日志应出现“TeamNode 注册成功”或“TeamNode 心跳成功”。公网路线异常时会显示 UUID 已隔离且未向 TeamNode 推送。

检查订阅：

```bash
curl -fsS http://127.0.0.1:3000/sub -o /tmp/sub-check
wc -c /tmp/sub-check

base64 -d /opt/nodejs-argo-no-docker/data/sub.txt \
  | grep -E '^(vless|vmess|trojan)://'
```

### 4. Tunnel 转发目标

Cloudflare Tunnel Public Hostname 的 Service 必须指向：

```text
http://127.0.0.1:8001
```

内部路径：

```text
/vless-argo  → 127.0.0.1:3002
/vmess-argo  → 127.0.0.1:3003
/trojan-argo → 127.0.0.1:3004
```

如果 Tunnel 仍指向旧端口，通常会出现 502、400 或客户端延迟 `-1`。

### 5. 关闭 TeamNode 同步

重新运行安装器并增加：

```bash
TEAMNODE_SYNC_ENABLED=false
```

## 八、覆盖安装与卸载

### 覆盖安装

覆盖安装会：

- 删除旧目录前读取旧 UUID；
- 读取 `.route-ready` 中已验证路线作为复验提示；
- 停止本安装器创建的服务、runner 和 PM2；
- 删除旧 `.env` 和安装目录；
- 重新兑换中继令牌并创建新 `.env`；
- 重新执行 Tunnel 优先和 Worker 公网回访。

旧路线只是提示，不会绕过验证。相同 UUID 在 TeamNode 仍存在时，注册冲突会自动转为心跳复用；上游记录已删除时，心跳 404 会触发重新注册。

最新版会在旧 `.env` 存在时自动复用 UUID。需要显式保存时：

```bash
UUID_OLD="$(sed -n 's/^UUID=//p' /opt/nodejs-argo-no-docker/.env | head -n 1)"
```

覆盖命令可增加：

```bash
UUID="${UUID_OLD}"
FORCE_KILL_PORTS=true
```

只有确认其他进程可以被终止时才使用 `FORCE_KILL_PORTS=true`。

### 卸载

```bash
curl -fsSL https://install.lemon.vin/install.sh -o /tmp/install-lemon.sh
bash /tmp/install-lemon.sh --uninstall
```

卸载只处理本安装器创建的目录和启动配置，不删除系统全局 PM2，也不删除 Cloudflare 控制台中的远端 Tunnel。

## 九、升级 Worker

修改以下文件后重新部署：

```text
public/install.sh
public/agent/index.js
src/index.js
```

```bash
npx wrangler deploy
```

如果启用了 Workers Builds，推送到连接分支后等待 Cloudflare 构建完成。目标机器只有在 Worker 已部署新代码后，才能从 `/install.sh` 下载到新版本。

## 十、安全注意事项

- 不要把真实 Tunnel Token、兑换密码、API Token、UUID 或 TeamNode 主密钥提交到 GitHub；
- `TEAMNODE_SYNC_SECRET` 只放 Worker Secret；
- 兑换密码应足够长并定期更换；
- 节点只保存按 UUID 签发的中继令牌；
- `ARGO_AUTH` 和中继令牌会写入目标机器 `.env`，保护文件权限；
- Cloudflare API Token 应限制到目标 Zone 和最小权限；
- 面板默认公开并显示公网 IP，需要私有访问时设置 `DASHBOARD_PASSWORD`；
- `FORCE_KILL_PORTS=true` 可能终止其他业务进程；
- 更换 `TEAMNODE_SYNC_SECRET` 后，已安装机器需要重新运行安装器兑换令牌；
- 如果 Token 或密码曾出现在公开日志或仓库中，应立即撤销并重新创建。
