# 把中继从控制面拆出去

日期：2026-11-22
状态：待执行（运维操作，需要一台机器）

## 现状

自部署控制面 `cloud.dexai.vip` 同时提供三件事，全部落在 `186.241.77.89` 这一台上：

| 域名 | 谁在听 | 提供什么 |
| --- | --- | --- |
| `cloud.dexai.vip` | Caddy → `127.0.0.1:8791` | 账号、许可证、云电脑开通（Cloud Admin） |
| `cloud.dexai.vip` | Caddy → `127.0.0.1:8791` | 控制面 `/v1/*`：installation、配对信箱、relay token、presence |
| `cloud.dexai.vip` | Caddy → `127.0.0.1:18080` | 中继 `/v1/host`、`/v1/host/data`、`/v1/phone`（`dex-relay-relay-1` 容器） |
| `cloud.dexai.vip` | Caddy → 静态文件 | APK 更新清单 `/update.json`、下载页 |

`relay1.dexai.vip` / `relay2.dexai.vip` 也解析到同一台，但**没有各自的 Caddy site block**，TLS 握手失败（`alert internal error`）。所以 `DEXCLOUD_RELAY_NODES` 实际只能填 `cloud.dexai.vip` 一个。

### 后果

1. **节点轮换是假的。** 代码支持 1–4 个节点，手机按顺序重试；现在填多个也只是同一台机器。
2. **单点故障没有拆开。** 中继挂了，已配对手机连不上电脑；控制面挂了，连配对信箱和 APK 更新都拿不到。而这两件事本应独立——中继只影响"手机连电脑"，控制面只影响"新设备配对/发版"。

对比：托管版的中继是真两台（`relay1.openmausbot.com` → `2.31.195.146`，`relay2.openmausbot.com` → `2.28.194.247`）。

## 目标形态

```
控制面 cloud.dexai.vip        → 186.241.77.89（现有）
中继   relay3.dexai.vip       → <另一台机器>
        cloud.dexai.vip        → 保留（旧手机钉的就是它）
```

`DEXCLOUD_RELAY_NODES=relay3.dexai.vip,cloud.dexai.vip`：新配对拿到两个节点，老手机继续用 `cloud.dexai.vip`。

## 步骤

### 1. 选一台机器

要求：公网可达、有 80/443、Docker 可用、至少 2 GB 内存（`relay/deploy/compose.yaml` 里 `mem_limit: 3g`，`ulimits.nofile: 65536`）。

现成的 SSH 别名里有 `cube-hk`（103.118.42.124）、`us2`、`mall`，或另租。**别选 `wholesale`** —— 那正是要拆开的那台。

### 2. 加 DNS

`relay3.dexai.vip` 的 A 记录指向新机器 IP。DNS 在 Cloudflare（`dexai.vip` 已迁入本账号），DNS-only 即可（TLS 由新机器上的 Caddy 自己办）。

**注意白名单**：`companion/src/e2e/descriptor.ts` 的 `RELAY_HOST` 只认 `relay[1-9][0-9]?\.lunabot\.com` 和 `(relay[1-9][0-9]?|cloud)\.dexai\.vip`。`relay3.dexai.vip` 匹配，无需改代码。若想用别的域名，必须同时改六处白名单（见 PR #42 的第一个提交）。

### 3. 在新机器上起中继

```sh
git clone <repo> /opt/dex-relay && cd /opt/dex-relay/relay/deploy

# relay.env：与现有机器的 relay 用同一套 token 公钥，这样控制面签的 token 两台都认
cat > relay.env <<'EOF'
RELAY_NODE=relay3
RELAY_TOKEN_KEYS={"k2":"<与 wholesale 上相同的 Ed25519 公钥 b64u>"}
RELAY_METRICS_TOKEN=<至少 32 字符的随机串，或留空关闭 /metrics>
EOF

RELAY_DOMAIN=relay3.dexai.vip RELAY_IMAGE=<镜像> docker compose up -d
```

`RELAY_TOKEN_KEYS` 与 `RELAY_NODE` 都从现有部署照抄（`ssh wholesale 'docker inspect dex-relay-relay-1 --format "{{range .Config.Env}}{{println .}}{{end}}"'`；现有是 `RELAY_NODE=relay1`、key id `k2`，与控制面 `DEXCLOUD_RELAY_TOKEN_KID=k2` 对应）。**两台必须同 key**，否则新节点会以 4401 拒掉控制面签的 token。`RELAY_NODE` 只是这台节点的名字（`^relay[1-9][0-9]?$`），和域名不必一致，但不能和现有节点重名。

镜像现为 `dex-relay:local`（在 wholesale 上本地 build）；新机器上要么推一份到 registry，要么在新机器 `docker build relay/` 后同样打 `dex-relay:local` 标签。

### 4. 验收新节点

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://relay3.dexai.vip/healthz        # 200
# WebSocket 升级（带正确的子协议）
curl -s -m 8 --http1.1 -o /dev/null -w '%{http_code}\n' -i -N \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Protocol: omb-relay.v1' https://relay3.dexai.vip/v1/host          # 101
```

### 5. 让控制面签发两个节点

`wholesale:/opt/dex-cloud/.env`：

```
DEXCLOUD_RELAY_NODES=relay3.dexai.vip,cloud.dexai.vip
```

重启 `dex-cloud-cloud-1`。之后 `POST /v1/installations/self/relay-token` 返回的 `nodes` 就有两个，按 rendezvous hash 排序（`cloudflare/control-plane/src/relay.ts` 的 `orderNodes` 同款算法）。

### 6. 验证旧手机不受影响

老手机钉的 `r` 里有 `cloud.dexai.vip`，白名单还认，且 `cloud.dexai.vip` 继续服务中继——**不需要重新配对**。新配对会拿到 `relay3` 优先。

### 7. 可选：之后把中继从控制面机器上摘掉

等所有已配对手机都换过节点（或用户接受"老手机重配一次"）后：

- `wholesale:/etc/caddy/Caddyfile` 删掉 `cloud.dexai.vip` 里的 `/v1/host*` 和 `/v1/phone*` 两个 handle
- 停掉 `dex-relay-relay-1` 容器
- `DEXCLOUD_RELAY_NODES=relay3.dexai.vip`

这一步才真正把单点拆开。**先别做**——做了之后，钉着 `cloud.dexai.vip` 的老手机会失联。

## 不做这一步的代价

保持现状可以正常用，只是：

- 中继挂了，手机连不上电脑（直连 Wi-Fi/Tailscale 仍可用）
- 控制面挂了，已配对设备的中继也一起挂（因为同一台机器）
- 没有冗余，滚动重启就是一次停机

## 记录

执行时把每一步的实际输出追加到本文件末尾。
