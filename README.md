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

### 在线机器面板

部署后直接打开：

```text
https://你的-worker.workers.dev/
```

未设置 `DASHBOARD_PASSWORD` 时，面板和 `/api/nodes` 都可以被任何人查看，不需要登录。面板显示来源 IP、节点名称、`ARGO_DOMAIN`、地区、Provider 和最后心跳时间，不显示 UUID。只有 Worker 成功转发 TeamNode 注册或心跳后，机器才会进入列表；收到下线请求会立即删除。默认超过 10 分钟没有新心跳，机器会从 Durable Object 和前端列表中删除。

如果以后设置了 `DASHBOARD_PASSWORD`，根页面和 `/api/nodes` 会启用 Basic Auth，默认用户名为 `admin`。

在线状态由 Cloudflare Durable Object 持久化，多台机器可以同时注册，不会因为 Worker 实例切换而互相覆盖。来源 IP 是 Cloudflare 看到的设备出口 IP；如果目标机器经过 NAT 或代理，显示的可能是 NAT 或代理出口地址。

## 二、安装无 Docker 节点

### 需要设置的参数

必须设置：

- `ARGO_AUTH`：Cloudflare Tunnel Token 或 JSON；
- `ARGO_DOMAIN`：固定 Tunnel 域名。

常用可选参数：

- `ARGO_PORT`：Tunnel 连接的本地端口，默认 `8001`；
- `CFIP`：节点连接地址，例如 `cdst.lemon.vin`；
- `NAME`：节点名称前缀；
- `UUID`：不设置时自动随机生成；
- `FORCE_KILL_PORTS=true`：清理旧安装时强制终止相关端口上的其他进程，谨慎使用。

### 交互式安装

不设置兑换密码变量，安装器会隐藏提示输入密码：

```bash
env \
  FORCE_KILL_PORTS='true' \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  ARGO_PORT='8001' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash <(curl -fsSL https://你的-worker.workers.dev/install.sh)
```

安装器流程：

1. 生成或校验 UUID；
2. 提示输入 Worker 兑换密码；
3. Worker 校验密码，并根据 UUID 签发专属中继令牌；
4. 将中继令牌写入目标机器的 `.env`；
5. 下载并校验 cloudflared、Xray、哪吒和节点源码；
6. 启动节点及 Cloudflare Tunnel。

兑换密码不会写入 `.env`，也不会打印到日志。

### 非交互式安装

自动化环境没有可用终端时，可以通过环境变量提供兑换密码：

```bash
env \
  TEAMNODE_SYNC_ENROLL_PASSWORD='Worker 上配置的兑换密码' \
  FORCE_KILL_PORTS='true' \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  ARGO_PORT='8001' \
  CFIP='cdst.lemon.vin' \
  NAME='lemon' \
  bash <(curl -fsSL https://你的-worker.workers.dev/install.sh)
```

不要把真实兑换密码写入公开脚本、README、GitHub 或 Shell 历史。

### 关闭 TeamNode 同步

如果某台机器不需要 TeamNode：

```bash
env \
  TEAMNODE_SYNC_ENABLED='false' \
  ARGO_AUTH='你的 Tunnel Token' \
  ARGO_DOMAIN='你的域名' \
  bash <(curl -fsSL https://你的-worker.workers.dev/install.sh)
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
systemd → OpenRC → SysV/init.d → rc.local → cron/crond
```

如果系统没有可用的 init 或 cron，安装器会使用固定版本 PM2（默认 `5.4.3`）保证 Node 进程退出后自动重启，但无法保证机器重启后自动启动。

可手动指定：

```bash
export SERVICE_MODE=auto
bash /tmp/install-lemon.sh
```

可用模式：`auto`、`systemd`、`openrc`、`sysv`、`rc.local`、`cron`、`none`。

正常重启不会重新输入兑换密码。UUID 和中继令牌会保存在：

```text
/opt/nodejs-argo-no-docker/.env
```

只有删除 `.env`、重新安装，或更换 Worker 的 `TEAMNODE_SYNC_SECRET` 后，才需要重新兑换。

## 五、重复安装和清理

每次正式安装前，安装器会：

- 停止本安装器创建的服务、runner 和 PM2；
- 删除旧的 `/opt/nodejs-argo-no-docker`；
- 清理本安装器对应的旧进程；
- 检查 `3000`、`8001`、`3001-3004` 端口；
- 默认拒绝误杀其他业务进程。

确认需要强制终止端口占用时，才设置：

```bash
FORCE_KILL_PORTS=true
```

卸载：

```bash
bash <(curl -fsSL https://你的-worker.workers.dev/install.sh) --uninstall
```

卸载只处理本安装器创建的目录和启动配置，不会删除系统全局 PM2。

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
