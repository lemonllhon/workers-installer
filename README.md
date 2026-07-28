# nodejs-argo 无 Docker 安装器

这个目录是一个独立的小项目，适合复制到另一个 GitHub 仓库，然后部署为 Cloudflare Worker。

它不会在 Worker 中运行节点，也不会把任何密钥写进 Worker 代码。Worker 只负责安全地提供 `install.sh`；真正的节点进程在目标 Linux 机器上运行，并复用主项目已有的：

- Xray 的 VLESS、VMess、Trojan WebSocket 节点生成；
- Cloudflare Tunnel 固定域名；
- TeamNode HMAC 注册、心跳、自动重新注册和下线通知；
- 地域、ISP、IP 风控标签；
- 订阅内容 Base64 编码并通过 `contentBase64` 上报。

## 1. 部署 Worker

在这个目录执行：

```bash
npx wrangler deploy
```

部署后安装脚本地址为：

```text
https://你的-worker.workers.dev/install.sh
```

同时兼容旧地址拼写：`/inatall.sh`；新部署建议使用 `/install.sh`。

Worker 只返回静态脚本，不保存 `ARGO_AUTH` 或 `TEAMNODE_SYNC_SECRET`。

## 2. 在无 Docker 的 Linux 机器安装

建议先通过文件或安全的环境注入方式设置变量，再执行安装器。不要把密钥提交到仓库：

```bash
export TEAMNODE_SYNC_SECRET='你的 TeamNode 签名密钥'
export ARGO_AUTH='你的 Cloudflare Tunnel token 或 JSON'
export ARGO_DOMAIN='你的固定 Tunnel 域名'
export ARGO_PORT='8001'
export CFIP='你的优选域名或 IP'
export NAME='lemon'
export UUID='你的 UUID'

bash <(curl -fsSL https://你的-worker.workers.dev/install.sh)
```

默认会安装到 `/opt/nodejs-argo-no-docker`，创建 `nodejs-argo-no-docker.service`，并设置开机启动。

默认 TeamNode 参数与主项目一致：

```text
TEAMNODE_SYNC_BASE_URL=https://teamnode.lemon.vin
TEAMNODE_SYNC_KEY_ID=nodejs-argo-prod
TEAMNODE_SYNC_GROUP_KEY=basic
TEAMNODE_SYNC_HEARTBEAT_INTERVAL_MS=300000
TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT=true
```

心跳会包含最新的 `contentBase64`。如果 TeamNode 端只需要注册时的订阅内容，可以设置：

```bash
export TEAMNODE_SYNC_HEARTBEAT_INCLUDE_CONTENT=false
```

## 3. 安全特性

- Worker 内置当前 `index.js` 副本，并校验 `index.js` SHA256；
- Xray、哪吒使用固定版本并校验 SHA256；cloudflared 每次安装时从 Cloudflare 官方最新 release 下载，并校验官方 release 中的 SHA256；
- 不使用第三方 `curl | bash`；
- npm 安装使用固定版本、`--ignore-scripts`、关闭 audit/fund；
- 配置文件权限为 `600`；
- 节点服务使用独立的系统用户；
- systemd 使用 `NoNewPrivileges`、`PrivateTmp` 和受限写目录；
- Worker 和安装器都不包含真实密钥。

cloudflared 默认使用 Cloudflare 官方最新版本；运行时会每 24 小时自动检查更新。若需要固定版本，可在安装时设置 `CLOUDFLARED_VERSION=2026.7.3`；安装器会从对应官方 release 自动读取并校验 SHA256。

如果需要升级源码、Xray 或哪吒版本，请先更新 `public/agent/index.js` 或 `public/install.sh`，再重新部署 Worker。

## 4. 卸载

```bash
bash <(curl -fsSL https://你的-worker.workers.dev/install.sh) --uninstall
```

卸载只处理 `/opt/nodejs-argo-no-docker` 和本安装器创建的 systemd 服务，不会执行全局 PM2 删除。
