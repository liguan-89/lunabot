# dex-cloud Boat relay：让 Cloud home 的云端桌面真正可用

## 为什么

线上 My Cloud 本身健康，但 bot 选择「云端桌面」时必然报
`cc-unavailable`：dex-cloud 的 provisioner 从不向 Cloud home 传
`LUNABOT_CLOUD_BOAT_URL` / `LUNABOT_CLOUD_BOAT_TOKEN`，Admin 也没有
`/api/cloud/services/boat/...` 路由（公网探测 404）。这不是 Boat 临时故障，
而是 self-hosted dex-cloud 的 included Boat service 尚未实现。

## 现状与约束

- Cloud home 侧已经支持两种 relay base：`/api/box/v1` 走旧 box 方言翻译，
  `/api/v1` 直接讲 Boat public API v1（`server/boat-relay.ts`）。
  dex-cloud 没有历史挂载点，直接实现 `/api/cloud/services/boat/api/v1`。
- Cloud home 调用的面是透明代理型 API，而不是 agent API：
  `GET/POST /sandboxes`、`GET/PATCH/DELETE /sandboxes/{id}`、
  `POST /sandboxes/{id}/commands`、`GET /commands/{processId}`、
  `POST /desktop|resume|stop`、`GET /artifacts`、`GET/POST /files*`、
  `GET /deletion-operations/{id}`。绝不转发 `/prompt`、`/events` 等 Boat agent 面。
- 真正的 Boat API key 只能留在 dex-cloud Admin；Cloud home 拿的是每台 Cloud
  独立的 `box_omb_…` relay token。relay token 只在库中存 SHA-256。
- dex-cloud 当前没有真实支付和套餐计量实现。本线先把 cap 当作运营成本控制：
  默认每台 Cloud 1 台未删除 cloud computer、每月 50 小时、每小时 20 次启动；
  三个值可用 env 调整。错误文案保持客户端已识别的英文合同
  （`hours_used`、`at_once`、`too_many_starts`、`subscription_inactive`）。

## 改动

1. `dex-cloud/src/config.js`
   - `LUNABOT_CLOUD_BOAT_TOKEN`：Admin 持有的真实 Boat API key（只进内存，不日志）。
   - `LUNABOT_CLOUD_BOAT_API`：默认 `https://boat.dev/api/v1`，必须是无凭据、无 query 的 https base。
   - `LUNABOT_CLOUD_BOAT_AT_ONCE` / `_MONTHLY_HOURS` / `_STARTS_PER_HOUR`：成本控制上限。
2. `dex-cloud/src/store.js`
   - `clouds.boat_token_hash`：每台 Cloud 当前 relay token 的 SHA-256。
   - `boat_sandboxes`：relay 创建的 sandbox 归属（`cloud_id`）、名称、状态、删除标记、当前唤醒段起点。
   - `boat_usage_segments`：启动/唤醒计费段，支持 UTC 月份重叠求和。
   - `boat_operations`：删除操作 id 归属，防止跨 Cloud 探查。
3. `dex-cloud/src/boat-relay.js`
   - `box_omb_` bearer token 鉴权 → Cloud → owner 账号；Cloud ended 或订阅 inactive 拒绝。
   - sandbox id 必须先属于该 Cloud；LIST 在上游响应后过滤，绝不泄漏同一 Boat 账号下其它 Cloud 的机器。
   - 透明转发 allow-list 内的 v1 方法和路径，替换 Authorization，保留 Idempotency-Key 与 X-Ascii-Confirm-Delete。
   - create 串行化，落实 at-once/月小时/启动频率 cap；create/resume 成功后开计费段，stop/delete 或观察到 archived/error/cancelled 时关闭。
   - DELETE 成功后记录 deletion operation；按 id 查询时校验归属。
   - 上游网络失败返回 relay 自己的 `service_unavailable`/`upstream_unavailable` 信封；不记录 token、body 或桌面链接。
4. `dex-cloud/src/provisioner.js`
   - 配置齐全时为每次重新供给生成并安装新的 per-Cloud relay token：
     `LUNABOT_CLOUD_BOAT_URL=${origin}/api/cloud/services/boat/api/v1` 与 `LUNABOT_CLOUD_BOAT_TOKEN`。
   - 已有容器缺 relay token hash 时，`start()` 走重新供给而不是启动一个永远没有云端桌面的旧容器。
5. `dex-cloud/src/server.js`：接入 `/api/cloud/services/boat/api/v1`。
6. 文档与 `.env.example`：补 Boat 配置与部署说明；`docs/cloud-pro.md` 的 v1 relay 地址按实现修正。

## 验证

- node:test 覆盖：token 鉴权、跨 Cloud sandbox 404、LIST 过滤、create 转发与归属记录、
  并发 create 不突破 at-once、hours/starts cap、delete operation 归属、二进制 artifacts 透传。
- provisioner 测试：create container env 含 v1 relay URL 和 token，库中只有 hash；缺 hash 的已有云会重新供给。
- T0：`node --test dex-cloud/test/boat-relay.test.js dex-cloud/test/provisioner.test.js`。
- T1：`pnpm typecheck`（如只动 dex-cloud 则至少 dex-cloud 自身测试与 oxlint 相关文件）。

## 上线步骤（另需用户确认）

1. 用户安全提供 Boat API key，写入服务器 `/opt/dex-cloud/.env` 的 `LUNABOT_CLOUD_BOAT_TOKEN`。
2. 部署 dex-cloud，重建 Admin 容器。
3. 对现有 My Cloud 触发重新供给，使 Cloud home 获得 relay URL/token。
4. 用真实 API 调一次 create/list，再在 App 里发送需要云端桌面的消息验证。
