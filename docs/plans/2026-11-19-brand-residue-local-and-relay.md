# 残留 openmausbot、.local 解析、账号与中继 —— 一页纸设计

日期：2026-11-19
状态：待批准

## 目标

三件事分开做，互不依赖：

1. 清掉 `openmausbot` 残留标识。
2. 修 Android 端 `.local` 不可解析导致的配对失败。
3. 让账号登录与 Relay 中继真正可用。

## 1. 残留 openmausbot

全仓 2145 处，分三层，风险与收益完全不同：

| 层 | 内容 | 规模 | 用户可见 |
| --- | --- | --- | --- |
| A 用户可见 | mDNS 主机名 `openmausbot-<hash>.local`、租约文件 `openmausbot-server.lease` | 2 处 + 引用点 | 是（手机上、错误弹窗里） |
| B 内部标识 | 请求头 `x-openmausbot-*`、Docker 标签 `com.lunabot.*`、localStorage 键、`LUNABOT_*` 环境变量、`/.well-known/openmausbot/environment` | 12 头 / 12 标签 / 7 键 / 19 变量 / 2 路径 | 否 |
| C Android 源码包名 | `com.lunabot.companion`（namespace，对外的 applicationId 已是 `com.lunabot.companion`） | 437 个 .kt/.xml 文件 | 否 |

**A**：改名后旧配对手机将忘记这台电脑，需重配对；租约文件不再被旧名认出。已确认接受。

**B**：`x-openmausbot-*` 与 Docker 标签改了之后，旧容器/旧请求头不再匹配；本地存储键改名等于清空用户偏好。已确认接受。

**C**：纯机械改名（目录 + package 声明 + import），但 437 文件、上千 import，一次 review 不现实，必须拆成独立提交。风险是漏改导致编译失败——由 `./gradlew :app:assembleDist` 把关。

建议：A+B 一次提交，C 单独一次提交（可回滚）。

## 2. Android 的 `.local`

根因：`android/app/src/main/kotlin/.../discovery/NsdDiscovery.kt:528` 的 `hostAddress()`
在 API 34+ 优先返回 NSD 的 Bonjour 名字（`...local`），理由是"名字跟着电脑换网络"。
但 Android 系统 DNS 不解析 `.local`：

```
ping openmausbot-90e339db.local  → unknown host
curl http://192.168.31.175:8810  → 401（通）
```

所以这条"更优"的路在 Android 上是死路，配对必失败（用户已实测报错）。

**改法**：把优先级反过来——先用 `info.hostAddresses` 解析出的 IP，只有在拿不到 IP 时才退回
`.local` 名字。同时也放宽 `.local` 名字前缀（配合第 1 项改成 `lunabot-<hash>.local`）。

影响：`hostAddress()` 是注入函数的默认实现，`NsdResolveTest` / `NsdDiscoveryTest`
用 fake 注入，需要补一条"有地址时选地址"的用例。

## 3. 账号与中继

### 现状（实测）

- 控制面活着：`cloud.dexai.vip/healthz` → `{"ok":true,"service":"openmausbot-control-plane","accounts":3,"installations":4}`
- 发 OTP 可用：`POST /api/auth/email-otp/send-verification-otp` → 200
- 桌面端是 `signed-out`，即**没有登录过**
- Relay 节点**已经在跑**：服务器 `wholesale`(186.241.77.89) 上 `dex-relay-relay-1` 容器，
  `127.0.0.1:18080/healthz` → `{"ok":true,"node":"relay1"}`，Caddy 已把
  `cloud.dexai.vip/v1/host*`、`/v1/phone*` 反代给它

### 根因（2026-11-19 实测修正）

**先前的"域名单分裂"结论针对的是仓库里的 Cloudflare Worker 配置，那不是实际部署。**

实际部署的控制面是 VPS(`wholesale`, 186.241.77.89) 上的 `dex-cloud:local` 容器（监听
`127.0.0.1:8791`，Caddy 把 `cloud.dexai.vip` 反代过去）。它已经是自研实现，与
`cloudflare/control-plane/wrangler.jsonc`（指向 `accounts.lunabot.com`）无关。

该容器当前环境：

```
DEXCLOUD_RELAY_NODES=cloud.dexai.vip     ← 已在客户端白名单内
DEXCLOUD_RELAY_TOKEN_KID=k1
DEXCLOUD_RELAY_TOKEN_SEED=<已配置>
DEXCLOUD_RESEND_API_KEY=<已配置>
DEXCLOUD_EMAIL_FROM=DEX BOT <noreply@dexai.vip>
DEXCLOUD_DEV_CODES=0
DEXCLOUD_ADMIN_EMAILS=（空）
```

并且已验证**签名密钥对配套**：控制面由 seed 导出的公钥与中继
`RELAY_TOKEN_KEYS.k1` 完全一致（`MATCH`）。所以中继链路本身是通的。

### 真正的阻塞：登录邮件发不出去

```
[dex-cloud] control sign-in email failed: email API refused the message (422)
```

Resend 账户里**一个已验证域名都没有**（`GET api.resend.com/domains` → `[]`），
发件地址 `noreply@dexai.vip` 未验证，所以 OTP 邮件被 422 拒绝。没人能完成登录，
于是桌面端一直 `signed-out`，中继自然起不来。

修法（三选一，按推荐排序）：

1. **在 Resend 验证 `dexai.vip`**：加 SPF/DKIM 的 TXT 记录，等 Resend 验证通过。
   之后 OTP 正常投递，登录可用。
2. **改用 SMTP**：配置 `DEXCLOUD_SMTP_URL`（若 VPS 或别处有可用 SMTP）。
3. **开 `DEXCLOUD_DEV_CODES=1`**：OTP 打进容器日志。仅限临时自用，
   等于任何知道邮箱的人都能读日志登录，**不建议长期开**。

### 次要：仓库里的 Worker 配置仍是旧域

`cloudflare/control-plane/{wrangler.jsonc,src/relay.ts}` 仍写
`relayN.lunabot.com`。它不参与当前部署，但属于"残留"，随第 1 项一起改，
以免将来照它部署时再踩同一坑。

## 执行顺序

1. 第 2 项（最小、直接解你眼下的配对问题）→ 重编 APK 验证
2. 第 1 项 A+B → 重编两个包
3. 第 1 项 C（Android 包名，独立提交）
4. 第 3 项：代码改动先落，部署与登录等 Cloudflare 授权

## 验证

- 第 2 项：`./gradlew :app:testDistUnitTest` + 真机配对（局域网 IP）
- 第 1 项：`pnpm exec vitest run companion/test/control.test.ts companion/test/endpoints.test.ts electron/data-dir-lease.node-test.mjs` + `pnpm typecheck`
- 第 3 项：登录后 `companion.state().e2e.enabled === true` 且 `relay !== "off"`