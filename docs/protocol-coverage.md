# Luna Bot 协议手册（Android 覆盖图）

> 依据：`server/index.ts`、`shared/wire.ts`、`shared/notification.ts`、`companion/src/routes.ts`、
> `android/core/` 与 `ios/Sources/CompanionCore/`。行号会随上游变动，以函数名和路径为准。
>
> Android 列：✅ 已封装且有界面入口 · ▣ 已封装、仅内部使用（配对/流/水合）· ✗ 未实现。
> 最后核对：2026-11-10（桌面 0.1.151 / Android 1.5.4）。

## 0. 一条请求经过哪几层

```
手机 → companion sidecar（配对令牌 + 白名单）→ server/index.ts handleRequest → store → SSE 回推
```

- **白名单**：`companion/src/routes.ts` 的 `ALLOWED` 放行；`EXPLAINED` 返回 403 并带拒绝理由；
  其余 404 `no route`。未认证先 401。旁路只有 `POST /api/pair` 与 `GET /api/health`。
- **鉴权**：`Authorization: Bearer <token>`。配对两种形状：`POST /api/pair`（companion，token/device/serverName）
  与 `POST /api/auth/pair`（6 位码换 session，JSON-only，415 拒绝表单）。
- **事件流**：`GET /api/events?screens=on&since=<STREAM_ID:seq>`。回放窗口 500 帧；
  `hello.resumed=false` 表示游标失效，必须全量水合（`Store.hydrate`）。
- **幂等**：`sendId`（消息 / 编辑）、`uploadId`（附件）、`pairRequestId`（跨路由重放配对）。
- **异步**：发消息、编辑重跑、压缩上下文、webhook 测试返回 **202**，真正的结果走 SSE 帧。

## 1. HTTP 端点地图

### 1.1 配对、健康、事件

| 端点 | 用途 | Android |
|---|---|---|
| `POST /api/pair` | companion 配对（credential/code + deviceName） | ▣ `Client.pair` |
| `POST /api/auth/pair` | 服务器配对码 | ▣ `Client.pairWithServer` |
| `GET /api/health` | 存活探测（未认证只回 app 名） | ▣ 配对探测 |
| `GET /.well-known/lunabot/environment` | 服务器身份 | ▣ 每次请求前核对 |
| `GET /api/events` | SSE 全量事件 | ▣ `Session.runStream` |
| `GET /api/auth/session`、`POST /api/auth/logout` | 当前会话 / 注销 | ✗（登出只删本地 token） |

### 1.2 bots

| 端点 | 用途 | Android |
|---|---|---|
| `GET /api/bots?messages=N` | 舰队水合 | ▣ |
| `POST /api/bots` | 新建 bot | ✅ |
| `PATCH /api/bots/:id/profile` | 受限档案 | ✅ |
| `PATCH /api/bots/:id/model` | 默认模型 / effort | ✅ |
| `POST /api/bots/:id/avatar/generate` | 生成头像（慢，201） | ✅ |
| `POST /api/bots/:id/read` | 标已读 | ✅ |
| `POST /api/bots/:id/always-allow` | 记忆授权键（409 无待批卡） | ✅ |
| `POST /api/bots/:id/compact` | 压缩上下文（202） | ✅ |
| `POST /api/bots/:id/interrupt` | 停止回合 | ✅ |
| `PATCH /api/bots/:id/cards/:mid` | 非请求卡 answered/dismissed（请求卡必须 respond，409） | ✗ |
| `GET /api/bots/:id/overview` | 单 bot 摘要 | ✅ |
| `GET/POST /api/bots/:id/skills`、`…/skills/:name` | 技能文件管理 | ✗（仅安装/审阅流） |
| `GET /api/bots/:id/soul`、`…/soul/apply-file`、`…/discard-file` | SOUL.md 与漂移 | ✗ |
| `GET /api/bots/:id/history`、`POST …/history/rollback` | 档案变更史 / 回滚 | ✗ |
| `GET/PUT/DELETE /api/bots/:id/memory*` | MEMORY.md、日志、主题 | ✗ |
| `GET /api/bots/:id/checkpoints`、`POST …/restore` | 工作区快照 | ✗ |
| `POST/PATCH/DELETE /api/bots/:id/projects`、`PATCH …/order` | 话题文件夹 | ✗（只能选，不能管） |
| `DELETE /api/bots/:id`、`PATCH /api/bots/:id` | 桌面级增删改 | ✗（有意） |

### 1.3 threads / messages

| 端点 | 用途 | Android |
|---|---|---|
| `GET /api/threads/:id/messages?limit&before&around` | 分页 / 定位 | ✅ |
| `POST /api/bots/:id/messages`、`POST /api/groups/:id/messages` | 发消息（202 receipt） | ✅ |
| `POST /api/threads/:id/respond`、`POST /api/bots/:id/respond` | 答卡（requestId/behavior/reviewedSha256） | ✅ 只用 thread 形 |
| `POST /api/threads/:id/messages/:mid/reactions` | emoji 反应 | ✅ |
| `POST /api/bots/:id/messages/:mid/edit` | 编辑并分叉（202） | ✅ |
| `POST /api/bots/:id/active-branch` | 切换版本 / 分支 | ✅ |
| `GET /api/search?q` | 全量子串检索 | ✅ |
| `GET /api/threads/:id/export?format` | 导出 Markdown/JSON | ✅ |
| `GET /api/threads/:id/messages/:mid/image` | 屏幕消息像素 | ✅ |
| `POST /api/threads/:id/messages/:mid/file` | 按消息授权下载文件 | ✅ |
| `GET /api/threads/:id/events` | 线程运行时检查器 | ✗ |
| `POST /api/bots/:id/requests/:rid(/interrupt)` | guarded 请求快照 / 中止 | ✗ |

### 1.4 任务、队列、房间

| 端点 | 用途 | Android |
|---|---|---|
| `POST/PATCH/DELETE /api/bots/:id/tasks(/:tid)` | 任务 CRUD、pin/snooze/archive/模型 | ✅ |
| `POST /api/bots/:id/tasks/:tid` | 切换任务（`?messages=`） | ✅ |
| `DELETE /api/bots/:id/queue/:qid` | 撤回排队（404 `no such queued message`） | ✅ |
| `POST /api/bots/:id/queue/:qid/steer` | 队首插话 | ✗（白名单也未放行） |
| `POST/PATCH/DELETE /api/groups/:id/tasks(/:tid)` | 房间任务 | ✅ |
| `POST /api/groups/:id/read` | 房间已读 | ✅ |
| `POST /api/groups/:id/interrupt` | **停止房间回合** | ✗ **白名单已放行，客户端没封装** |
| `PATCH/DELETE /api/groups/:id` | 改 / 删房间 | ✗（有意） |
| `PATCH /api/groups/:id/setup` | 房间引导 | ✗ |

### 1.5 附件、例程、连接器、电脑

| 端点 | 用途 | Android |
|---|---|---|
| `POST /api/attachments?uploadId` | 图片上传 | ✅ |
| `POST /api/files?name&uploadId` | 文档上传（25MB） | ✅ |
| `GET /api/attachments/:name` | 图片/语音（Range） | ✅ |
| `GET/POST/PATCH/DELETE /api/routines*` | 例程 CRUD | ✅ |
| `POST /api/routine-runs/:id/seen\|cancel` | 运行已读 / 取消 | ✅ |
| `POST /api/routine-runs/seen-all` | 全部已读 | ✗（白名单未放行） |
| `GET /api/connectors/catalog\|connected` | 连接器目录 / 已连 | ✅ |
| `POST /api/connectors/:slug/authorize` | 发起 OAuth | ✅ |
| `GET /api/connectors/tools`、`DELETE …/accounts/:aid` | 工具清单 / 解绑账号 | ✗ |
| `POST /api/bots/:id/secret-cards/:mid/provide` | HPKE 提交凭据 | ✅（QR pin + P-256 HPKE；仅受保护路由/e2e） |
| `POST /api/bots/:id/secret-cards/:mid/resume\|dismiss` | 凭据卡推进 | ✅ |
| `GET/POST /api/bots/:id/connector-cards/:mid/*` | 内联连接卡 | ✅ 卡片显示 + 发起 OAuth（1.6.1） |
| `POST /api/bots/:id/computer/screenshot` | 云 / VM 单帧截图 | ✅ |
| `POST /api/bots/:id/local-computer/screenshot` | 本地 VM 截图 | ▣ 调用，但白名单未放行 → 404 |
| `POST /api/bots/:id/computer/join` | 云桌面 | ✅ |
| `GET /api/bots/:id/computer`、`…/control`、`…/viewer-close` | 云电脑状态 / 控制租约 | ✗ |

### 1.6 配置与观测

| 端点 | 用途 | Android |
|---|---|---|
| `GET /api/config` | 配置状态（脱敏） | ✅ |
| `PUT/PATCH /api/config` | **仅** `tts.{key,provider}` 放行 | ✅ |
| `GET /api/instances` | 引擎清单 | ✅ |
| `POST /api/instances/:id/claude-update` | 升级 Claude | ✅ |
| `GET /api/tts/voices\|prepare`、`POST /api/tts/speak` | 语音 | ✅ |
| `GET /api/team-map` | 团队图 | ✗（白名单放行，客户端未封装） |
| `GET /api/usage`、`/api/admin-activity`、`/api/decisions` | 用量 / 审计 | ✗ |
| `GET /api/section-context` | 团队简报 | ✗ |
| `PATCH/PUT/DELETE /api/sidebar-sections` | 分组管理 | ✗（仅 POST 指派） |

### 1.7 白名单明确拒绝（不要做）

| 家族 | 理由（routes.ts 原文意译） |
|---|---|
| `/api/companion`、`/api/devices` | 远程访问设置只能在电脑上改；手机丢了不能失去锁手机的能力 |
| config 除语音 key/引擎外 | API key 只能在电脑上配 |
| `/api/local-computer` | Local VM 在电脑上安装 |
| `/api/webhooks` | 建 webhook 等于暴露公网触发器；轮换密钥会弄断发送方 |
| `/api/teams` 导入导出 | 团队打包在电脑上完成 |
| connector 整服务 DELETE | 账号级解绑可以，卸载整个服务属于电脑 |
| queue steer | 手机只能取消，不能插话（房间场景涉及他人） |
| secret card 的 `provided` | 手机不能声称“主机已存好凭据” |

## 2. SSE 帧地图

| 帧 | 触发 | Android |
|---|---|---|
| `hello` | 每次连接；`resumed` 决定回放还是水合 | ✅ |
| `message` | 新消息落盘；推进 activeLeaf（仅当 parent == 当前叶） | ✅ |
| `message.patch` | reaction、卡结算、附件 digest | ✅ 整条替换；不清流、不退役队列 |
| `thread` | 编辑分叉 / 切换分支 | ✅ |
| `bot` | bot 元数据 / 任务页 | ✅ |
| `bot.deleted` | 删 bot | ✅ 级联清 |
| `bot.queued` | 队列快照（整表替换，含墓碑） | ✅ 丢弃 `reason` |
| `group` / `group.deleted` | 房间 | ✅ |
| `notify` | 通知 | ✅ 缺 `avatarUrl` 字段 |
| `screen` | 实时截屏 | ✅ 丢弃 `threadId` |
| `computer` | 云电脑供应 / 唤醒 | ❌ 解码后忽略 |
| `config` | 配置变化（整份 config 展开） | ❌ `Frame.Config` 零字段 |
| `runtime` | 约 20 种运行时事件 | ⚠️ 只消费 `content.delta` 与 `turn.completed/failed/aborted` |
| `sections` | 侧栏顺序 | ❌ Unknown（客户端自派生，注释声明故意） |
| `routine` / `routine.run` / `routine.deleted` | 例程与运行 | ❌ Unknown，只能手动刷新 |
| `webhook` / `webhook.attempt` / `webhook.deleted` | webhook | ❌ Unknown（无 UI，合理） |
| `computer-control` | 帮助租约 | ❌ Unknown，takeover 后看不到 held |

## 3. 通知类型

| kind | 含义 | 是否阻塞 | Android 通道 |
|---|---|---|---|
| `approval` | 请求卡到达人 | 是 | 阻塞通道 + 通知栏「允许/拒绝」 |
| `question` | 模型提问 | 是 | 阻塞通道 |
| `takeover` | **需要你接手电脑** | 是 | 阻塞通道（本轮修正） |
| `done` | 回合 / 例程完成 | 否 | `bot_messages` |
| `routine-failed` / `routine-deferred` | 例程失败 / 被压后 | 否 | 专用 / `bot_messages` |
| `turn-failed` | 回合没能启动 | 否 | `bot_messages` |
| `incident` | 失败且无 Chief 接盘 | 否 | `bot_messages` |
| `delegation-settled` | 委派结果回收 | 否 | `bot_messages` |
| `spend` | 月度花费（adminOnly） | 否 | `bot_messages` |

- 通知去重键：`openmaus.{threadId}.{seq}`；`seq` 缺省回退 title。
- 服务端已发 `avatarUrl`（横幅大图标）与 `groupId`（房间归组）；Android 只消费了 `groupId`。
- `bot.notifications === false` 时服务端一票否决，连审批也不发（这是产品选择，不是 bug）。

## 4. 已确认的协议错位（本轮已修）

| 问题 | 后果 | 修复 |
|---|---|---|
| 服务端发 `waitingForTeammates`，Android/iOS 解码 `waitingOnTeammate` | 「等待队友」永远不出现；忙/闲判断把它当工作 | `@SerialName("waitingForTeammates")`（Models.kt） |
| `OptionCard.expired` 未解码 | 过期卡 `isPending` 永真：动态常亮、按钮消失、通知栏审批无法回答 | 新增字段并纳入 `isPending`；卡片显示「此请求已过期」 |
| `takeover` 走 `bot_messages` | 「需要你接手电脑」与「做完了」同级 | 纳入 `isBlocking` 与阻塞通道 |

### 仍需确认

- `spend` 通知对配对手机是否可达：取决于设备 token 是否带 admin scope。
- `cancelQueued` 的本地删除发生在返回值检查之前，但 404「已排空」确实应该删行；
  只有网络失败才保留。行为看起来正确，注释与代码措辞不一致，需产品确认。
- 所有 `notificationSink.deliver` 调用点是否都带 `seq`（缺省会让同线程通知互相覆盖）。

## 5. 模型与语义缺口（按用户可见度）

1. **四类消息卡**：`connector`、`secret`、`routine.run`、`goal.run` 现在都有 `Message.Kind`
   和卡片渲染（1.6.1），不再落 `UNKNOWN` 后整行消失。
   - 连接器卡可直接在聊天里发起 OAuth；例程状态卡与团队目标收据显示状态、摘要和错误。
   - 凭据卡已支持 HPKE 提交：扫码配对 pin 桌面 P-256 recipient key，AAD 绑定设备、bot、会话、卡片、target 与 requestKey；旧配对或 LAN/Bonjour 明文路由仍降级为在电脑上填写。
2. **`expired` 已修**（见上）。
3. **通知缺 bot 头像**：`avatarUrl` 未解码。需要后台按令牌拉图，成本中等。
4. **机器人附的文档不可见**：`Message.attachments.kind == "file"` 没有渲染路径；
   用户自己发的文件有文本标签，机器人用 `attach_file` 附的文档/视频在手机上是空白。
5. **活动芯片只有名字**：`tool.summary/input/output/fullResult` 未解码，看不到命令与输出。
6. **共享归属丢失**：`sender`、`via:"api"`、`peerAsk/peerPost`、`aside` 未解码；
   共享工作区里别人发的行、bot 代发的行在手机上显示成「我」。
7. **没有耗时 / 花费**：`turnStartedAt`、`usage`、房间 `working` 未解码。
8. **运行时等待不可见**：`turn.wait_started/wait_ended` 被丢；「排队等电脑、前面还有谁」看不到。
9. **`kind:"file"` 附件**（见 4）。
10. **`pinnedMessageId`、`rewound`**：钉住的消息与「已回退」提示缺失。

## 6. 语义陷阱

1. **`sendId` 是幂等键**：重复提交返回原消息（202）；文本/replyTo 不匹配、或该 sendId 已被取消 → 409。
2. **`uploadId` 必须是 UUID**：非 UUID → 400；同 id 重传才幂等。
3. **`reviewedSha256` 只属于技能卡**：必须来自完整 preview 且为 64 位十六进制，否则只能拒绝。
4. **`expectedX` 乐观锁**：soul/memory/config/guarded send 都有，冲突一律 409，应提示“刷新后重试”而不是报错。
5. **202 之后等哪帧**：发送 → `message` / `bot`；编辑 → `thread`；压缩 → `message`（compaction）。
6. **`bot.queued` 是整表快照**：解析失败不能当空队（客户端已用 `queuesReadable` 防）。
7. **`message.patch` 不推进叶子、不清流**：只做整条替换；新消息才会推进。
8. **屏幕帧不入回放**：重连后最后一屏不会补发；慢客户端直接丢屏。本地 Mac 没有 HTTP 截图兜底。
9. **403 不等于掉线**：客户端只把 401 当 Unauthorized；403（白名单拒绝）会走普通失败与路由漫游。
10. **404 的两种含义**：撤回队列的 404 是「已排空」，不能当路由不存在；客户端靠服务端原文判断。
11. **snooze 的 null / 0 / 时间戳**：null = 立即唤醒，0 = 有活动才醒，数字 = 时间戳；必须整毫秒。
12. **`config` 帧整份展开**：成员可见性不同，手机拿到的是收窄后的视图；目前完全没用。

## 7. 下一步路线图（按价值 / 成本）

| 优先级 | 功能 | 协议依据 | 成本 | 风险 |
|---|---|---|---|---|
| 1 | 凭据请求卡（HPKE） | `/secret-cards/:mid/provide` 已放行；iOS 参考完整 | 大 | 高（凭据），必须保留 HTTPS-only、内存态、重试复用信封 |
| 2 | 机器人附件 `kind:"file"` 渲染 | `attachments` 已解码 | 小 | 低 |
| 3 | 连接器工具清单 / 账号解绑 | `GET /api/connectors/tools`、`DELETE …/accounts/:aid` | 中 | 低 |
| 4 | 通知头像 + 运行等待 | `avatarUrl`、`turn.wait_*` | 中 | 低 |
| 5 | 例程 / webhook 帧消费 | `routine*`、`webhook*` | 中 | 低 |
| 6 | 登出吊销服务端配对 | `POST /api/auth/logout` | 小 | 低（sidecar 会 404，仅服务器直连生效） |
| 7 | 停止房间回合 | `POST /api/groups/:id/interrupt` 已放行 | 小 | 低 |
| 8 | 团队图只读 | `GET /api/team-map` 已放行 | 中 | 低 |
| 9 | 列表页直接开对讲 | 纯 UI | 小 | 无 |
| 10 | App 内语言 | 本地 | 小 | 低 |

## 8. 源码索引

- 路由与鉴权：`server/index.ts`（`handleRequest`）、`companion/src/routes.ts`
- 帧契约：`shared/wire.ts`、`shared/runtime-events.ts`、`shared/notification.ts`
- Android 协议层：`android/core/.../Client.kt`、`Session.kt`、`Frames.kt`、`Store.kt`
- Android 通知：`android/app/.../notifications/`
- iOS 参考：`ios/Sources/CompanionCore/`（`Client.swift`、`Session.swift`、`PhoneSecret.swift`）
