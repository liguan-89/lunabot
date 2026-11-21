# Plan: composio broker 自部署（摘除上游 worker 依赖）

## Why

打包应用当前默认连上游作者的私人 worker
（`electron/managed-composio.mjs` 的
`https://openmausbot-composio.milindsoni201.workers.dev`）——全部安装实例的
connected-apps 流量、installation token 验证、Composio webhook 事件队列都
经过它。供应链敞口：上游随时可停服、可观察流量、可改行为。唯一出路是按
`cloudflare/composio-broker/README.md` 的 fork 路径自建。

## Decisions

| 项 | 值 | 说明 |
| --- | --- | --- |
| Worker 名 | `lunabot-composio` | 账号内命名空间，品牌一致 |
| D1 名 | `lunabot-composio` | `wrangler d1 create` 生成真实 `database_id` 后回填 |
| ratelimit namespace_id | `9101`/`9102`/`9103` | 账号内自选整数即可，不是预建资源 |
| CI 部署 | 沿用 `ci.yml` `deploy-composio-broker` job | `CLOUDFLARE_API_TOKEN` repo secret 就位后每次 main push 自动部署；未设时 warn 跳过 |

## Steps（按序，标注执行方）

### A. 用户本人（一次）

1. `cd lunabot && pnpm exec wrangler login` —— 浏览器授权本机。
   替代：Cloudflare dashboard 建 API token（Workers Scripts:Edit + D1:Edit +
   Workers R2? 不需要 —— Workers Scripts:Edit + D1:Edit + Account.Workers
   Scripts 足够），`export CLOUDFLARE_API_TOKEN=...` 后本会话可全程无交互。
2. Composio 账号：composio.dev 注册 → 建 project → 拿 project API key
   （`COMPOSIO_API_KEY`）。本机 `~/.lunabot/config.json` 当前 composio 段全空，
   从未有过项目 key，这步省不掉。

### B. 会话（auth 到位后一条龙）

3. `pnpm exec wrangler d1 create lunabot-composio` → 拿 `database_id`，
   回填 `wrangler.jsonc`（当前是 `REPLACE_AFTER_D1_CREATE` 哨兵）。
4. `pnpm exec wrangler d1 migrations apply lunabot-composio --remote
   --config cloudflare/composio-broker/wrangler.jsonc` —— 0001-0005 全上。
5. 首部署（README 路径）：`.dev.vars.production` 写 `COMPOSIO_API_KEY=...`
   → `wrangler deploy --secrets-file .dev.vars.production` → 立即删文件。
   此后 `wrangler secret put` 维护，不再走文件。
6. 记录部署输出里的 workers.dev 子域 → 更新
   `electron/managed-composio.mjs` 的 `DEFAULT_MANAGED_COMPOSIO_BROKER_URL`
   为本分支提交 → PR → 合并后新装实例即走自有 broker。
7. Composio webhook 订阅（README §One-time owner setup 第 3 步）：
   先 GET 查无订阅 → POST 建订阅指向
   `https://lunabot-composio.<subdomain>.workers.dev/v1/composio/webhook`，
   `enabled_events` 按 README → 拿 `secret` →
   `wrangler secret put COMPOSIO_WEBHOOK_SECRET`。
8. 可选：`wrangler secret put CLOUD_GRANT_SECRET` / `STATS_TOKEN` /
   `CLOUD_ADMIN_URL`（付费 Cloud grant、fleet 计数、唤醒休眠 Cloud；
   不设则对应路由 503/404，不影响桌面端基本功能）。
9. repo secret `CLOUDFLARE_API_TOKEN` 入库 → CI 接管后续部署。

### C. 验收

- `curl https://lunabot-composio.<subdomain>.workers.dev/v1/me` → 401（无
  token 即正常，证明 worker 活着且鉴权生效）。
- 隔离 fixture 起服务配 `OMB_COMPOSIO_BROKER_URL` 指向新 worker →
  connected-apps 注册流走通（installation 注册 → token 颁发 → /v1/me
  200）。
- `wrangler tail` 无异常；D1 `installations` 表出现记录。

## Risks / Notes

- `database_id` 哨兵会让误部署直接报错——故意为之，不许提交真实部署前
  忘回填的版本。
- 上游 worker 数据无法迁移（也不应迁移）：用户重新 connect 各 app 即可，
  installation token 本就是 per-installation 随机的。
- `REGISTRATION_MODE` 保持 `open`；若要关闸改 `closed` 即可，不影响存量。
- 迁移顺序硬约束（README）：0004 先于使用 shared_users 的代码、0005 先于
  使用 sweep progress 的代码——全新部署一次 apply 全部即可满足。
