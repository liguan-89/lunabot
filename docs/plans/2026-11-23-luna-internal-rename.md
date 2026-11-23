# 2026-11-23 内部命名统一：OpenMausBot/DexBot/MausBot 遗留命名 → Luna 系

状态：**计划页，等拍板**。用户 2026-11-23 拍板「不留遗留命名，能改的一起改，不管存量（我们没有存量用户）」。
自有部署随升级迁移：VPS 云电脑 ×1、本地 Mac 桌面 ×1、安卓手机 ×1。

三份只读清点（2026-11-23，本线 Explore 代理产出）已经把改动面数清了，本文只做决策分层，
不再重复罗列细节；实施时按文内文件指针直接定位。

## 〇、先拍板的 6 个命名决定

| # | 项 | 推荐 | 备选 | 理由 |
| --- | --- | --- | --- | --- |
| 1 | env 前缀 `LUNABOT_` → | **`LUNABOT_`** | `LUNA_` | 仓库新名已漂移到 LUNABOT_（`LUNABOT_TOKEN/URL`、evals `LUNABOT_URL`、`AMBIENT_PREFIXES=["LUNABOT_","LUNABOT_"]`），顺势收拢成一个前缀，不再造第三个变体 |
| 2 | 数据目录 `/data/.lunabot` → | **`.lunabot`** | — | server 默认已是 `~/.lunabot`（`server/data-dir.ts`，且有 `.dexbot`→`.lunabot` 一次性迁移先例可直接扩展） |
| 3 | provider id `"dex"` → | **`"luna"`**（模型 id `dex/gpt-x` → `luna/gpt-x`） | 暂留 `dex` | 改了才有「不留遗留」的终局；读取侧做 legacy 前缀映射（见 L3-2） |
| 4 | `{"app":"dexbot"}` / healthcheck → | **`{"app":"lunabot"}`** | — | 与 dex-cloud `waitHealthy`、compose 检查四处锁步改（现有 `compose.yaml:38` 还在 grep openmausbot 的 stale 先例就是不同步的下场） |
| 5 | npm 包名 `dexbot` → | **`lunabot`** | 暂留 | 发布契约；未对外发布过包则零成本，发布过则一次性（查 npm registry） |
| 6 | relay 域名 `*.lunabot.com` → | **查清归属再定** | 换 `*.dexai.vip` 系 | `lunabot.com` 在 hugedomains 手里（#42 先例）；openmausbot.com 归属待查（wrangler/DNS）。不在手上就只能收编到 dexai.vip，那是独立运维线 |

## 一、改动面清点结论（实施时的地图）

### LUNABOT_ 前缀（~490 个真实 env 名）
- 总量：全仓去重 ~503（含 ~15 假阳性：heredoc 定界符、UI 占位 token），server 代码「已知名」权威枚举在 `server/bot-box/env.test.ts:7-60`（~225 条）。
- **没有统一 env 访问器**：`process.env.LUNABOT_*` 直读 328 处，无法单点改读；但有 6 个集中清单文件必须逐一同步：
  `server/bot-box/env.ts:31-56`（BOX_ENV_LUNABOT_NAMES/PREFIXES/NEVER/NEVER_PREFIXES）、
  `server/bot-box/env.test.ts`（权威枚举，新名要过此测试）、
  `server/testing/lunabot-env.ts:4`（AMBIENT_PREFIXES）、
  `src/components/keys/key-catalog.ts:89-149`（UI 密钥 env 名目录）、
  `connector/src/settings.ts:80-81`（密钥转发名单）、
  `server/cloud-home.ts:18` + `server/cloud-home-start.ts:39`（云家 env 契约清单）。
- 易漏三件套：动态家族 `LUNABOT_MCP_TOKEN_<n>` / `LUNABOT_GATE_CONFIG_<n>` / `LUNABOT_REMOTE_MCP_CONFIG_<n>`（`server/bot-box/env.ts:48`）、
  动态拼接 `LUNABOT_${driverPrefix}_SESSION_IDLE_*`（`server/drivers/session-idle.ts:26-40`）、
  `LUNABOT_CLOUD_*` 60 名（`BOX_ENV_NEVER_PREFIXES` 保证不进 bot box 的那条也要跟着改）。

### openmausbot / maus / mausbot（~1867 / ~2042 行）
- `/opt/lunabot-browser` ~25 处：Dockerfile:107-109,122、podman、`server/container-workspace.ts:32,37-38`（锁目录+workspace 脚本名）、`server/browser-runtime.ts:167`、`server/browser-relay.ts:185`、ci.yml:775、`scripts/docker-image.test.ts:163,244`（断言锁死，必须同步）、docs 双份（`docs/deploy-vps.md` + `apps/docs/content/docs/self-hosting/deploy-vps.mdx`）。
- `maus` 镜像用户：Dockerfile:88,226-235,235、podman Containerfile、service-unit 文档/fixture。
- mausbot 标识符：`server/mausbot-notifications.ts`、`routes/mausbot-notifications.ts`、`agents-mausbot-tools.ts`、`chief-level.ts` holdsMausBotTools、`/run/mausbot/secrets.json`（cloud-home-start.ts:336）等。
- scoped npm `@openmausbot/{relay,companion,docs,control-plane}` + 根 package.json filters 6 处 + wrangler.jsonc。
- relay 域名 4 处代码 + wrangler（`shared/pairing-link.ts:24`、`electron/relay-token.mjs:10`、`dex-cloud/src/control.js:22`、`cloudflare/control-plane/src/relay.ts:17`）。

### dexbot（~497 行）
- `package.json:2` name、`server/environment.ts:165` npx 检测、
  `{"app":"dexbot"}` 生成点 ×3（`server/index.ts:13251`、`routes/status.ts:55`、`routes/instances.ts:97`）、
  Dockerfile healthcheck `grep -q dexbot` ×2（:213,:237）+ podman、
  `.well-known/dexbot/environment`（客户端默认路径：`cli-reach.ts:8`、`cli.ts:304,324,408,839`、`headless/*`；服务端已双收 dexbot|lunabot）、
  `x-dexbot-cli(-owner)` 头（发送方 cli.ts:277、headless/connect.ts:21；接收方 request-auth.ts:570,573 已双收）、
  `.dexbot-secrets`（secret-folder.ts:4，checkpoints.ts 已双列）、apparmor `dexbot-chrome`（host-setup.ts:31，docs 三处名不一致顺手统一）。
- 大量测试断言锁 `app:"dexbot"`：request-auth.e2e / cli.test / remote-sessions / workspace-backup-workflow / cli-lifecycle 等。
- 根 `compose.yaml:38` 检查 openmausbot 与现返回 dexbot 不匹配（stale）——本线顺手修正。

### dex-cloud 控制面（与服务器锁步）
- provisioner 注入云电脑容器的 9 个 env（`dex-cloud/src/provisioner.js:62-73`）：LUNABOT_CLOUD_ROLE/MACHINE_ID/ADMIN_URL/BOOTSTRAP_SECRET、LUNABOT_PUBLIC_URL、LUNABOT_DATA_DIR(=/data)、LUNABOT_CLOUD_TRUSTED_PROXIES、LUNABOT_CLOUD_CLIENT_IP_HEADER、LUNABOT_SERVER_NAME。
- `provisioner.js:46-48` waitHealthy 对 `dexcloud-<id>:8080/api/health` 文本 `includes("openmausbot")`、其测试 provisioner.test.js:104 断言 `{"app":"openmausbot"}`——**与服务器实际返回 `{"app":"dexbot"}` 不符**（能工作说明只看 HTTP 200 或另有匹配，实施 PR-D 时实测核实），改名时统一成新值并让断言真实。
- 配对头 `x-lunabot-cloud-*`（provisioner.js:191-193 ↔ cloud-home.ts:21 起）。
- 容器/卷名 `dexcloud-<id>(-data)`、网络名 `dexcloud`、镜像名 `lunabot-cloud-home:local`（已是 Luna）；DB 文件 dex-cloud.db、`DEXCLOUD_*` 自身配置前缀（❓ 可选一并改 LUNACLOUD_，涉及 .env/部署脚本）。
- `store.js` 存量：hostname/origin 已固化在 DB 行；`relay_host_id` **严禁轮换**（手机永久 pin，台账已钉）。

## 二、分层实施（每层独立 PR，可独立回滚）

### L1 纯代码机械重命名（零迁移风险）
内部 env 名（harness/bot-box/测试/进程间 ~400 名）、mausbot 文件名与标识符、UI 占位 token、文档散文、
假阳性清理（LUNABOT_EOF 等不在 env 语义里的顺带改掉防混淆）。

### L2 镜像/部署层锁步（一个发布窗内完成，PR-C+PR-D 必须同批合并）
Dockerfile ENV 与两处 healthcheck、podman 两文件、compose、deploy/install.sh、update.sh、
dex-cloud provisioner 注入 env + waitHealthy + 配对头、`scripts/docker-image.test.ts` 断言、ci.yml。
**顺序**：先合服务器双读层（PR-A），再合镜像/控制面切新名，最后删回退读。

### L3 有数据迁移风险的四类（每类带迁移方案）
1. **`.lunabot` 数据目录**：`server/data-dir.ts` 扩展现有 rename 模式（`.lunabot`→`.lunabot` 一次性，显式 ENV 永不迁移的现行规则保持）；`deploy/e2e/update.sh` 迁移哨兵链 ~11 处同步。
2. **`dex/<model>` 模型 id**：读取侧 legacy 映射 `dex/`→新前缀（命中点：config.json 的 defaultModelSelection/newBotDefaults、bots.json 的 bot/task modelSelection、routines.json、providers/ai-checks.json、cloud-send-chats BOT_SETTINGS、package-import）；写入侧全新 id。自有云电脑 config 里现存 `dex/claude-opus-4.8` 等即靠此迁移。
3. **phone-secret keychain id** `openmausbot-phone-credential-v1`：升级 v2 + 读旧写新一次。
4. **composio user_id `openmausbot_<uuid>`**：持久化在 Composio 外部侧。❓ 拍板：保留旧前缀生成（永不再改）或换 `lunabot_<uuid>` 新用户（已连 app 要重连）。推荐换新（无存量用户），受影响者重连一次。

### L4 改前必查的外部契约
- openmausbot.com 域名归属（wrangler `zones` / DNS whois）→ 决定 relay 域名走向（决定 #6）。
- npm `dexbot` 包是否已被发布/占用。
- `.well-known` 双路径兼容保持到自有部署全部升级完。
- Android 已 `com.lunabot.companion` ✓；`.mimosa/hook-state` 快照残留可清理（非源码）。
- `relay_host_id` 不动；`bootstrap_secret`/配对签名串格式不动（只改头前缀名，锁步改两侧）。

## 三、PR 序列（草案）

| PR | 内容 | 验证 |
| --- | --- | --- |
| A | 双读层：6 个集中清单文件引入新名优先/旧名回退 + env.test 权威枚举扩容 | 定向 vitest（bot-box env、cloud-home、tool-scope） |
| B | server 内部 LUNABOT_ → LUNABOT_ 全量（含动态家族、328 处直读） | T1 定向 + typecheck；`scripts/testing` fixture |
| C | Dockerfile/podman/compose/deploy 脚本 + docker-image.test 断言 | `scripts/docker-image.test.ts` 全绿 + 本地 buildx 构建 cloud-home 冒烟 |
| D | dex-cloud provisioner/router/waitHealthy/配对头 + 测试（含修 stale 断言） | dex-cloud flow 11/11 + provisioner.test |
| E | dexbot→lunabot 字符串组（健康字段/headers/包名/secrets/apparmor/compose:38 stale） | 相关 e2e 断言批量更新后全绿 |
| F | pi-custom-provider：env 名、provider id、`dex/` legacy 读取映射 + 迁移 | pi.test 114 + pi-custom-provider.test + 存量 config 样本迁移单测 |
| G | lunabot-browser 目录 + workspace 锁目录 + clientInfo + docs 双份 | chrome resolve/browser-relay 测试 |
| H | mausbot 标识符批 + @openmausbot scoped 包名 + 根 filters | typecheck + 受影响面定向 |
| I | 文档双份 + .env.example + CONTRIBUTING/SECURITY | i18n:check（若动文案）+ 文档链接自查 |
| 收尾 | 自有 VPS 演练：升级 dex-cloud → 重建云电脑容器（全链 env/health/配对）→ 本地 Mac 升级 → 手机回归 | 真机验收 |

## 四、验证门槛与出界

- 每步 T0/T1；C/D 合并后跑 `pnpm control:omb` 全链 fixture；最后过 T2 全量；T3（打包/发版）按用户节奏。
- **不做**：品牌文案层（产品名已是 Luna Bot）、域名迁移本身（另立运维线）、Android 包名（已完成）、`relay_host_id`（严禁轮换）、`.lunabot` 以外的数据目录变体。
- 回滚策略：每 PR 独立 revert；L2 锁步组若需回滚整组一起回。
