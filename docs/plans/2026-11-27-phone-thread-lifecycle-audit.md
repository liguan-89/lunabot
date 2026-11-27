# Android 新建话题与首条消息生命周期审计

## 背景

用户报告两类发版前体验问题：

1. 新建话题界面点了以后长时间像没有反应；
2. 新建话题里第一条用户消息已经发出，但长时间没有任何回应。

v2.1.12 发版因此暂停在 bump PR #136 未合并状态。本工作线先把链路断点审计清楚，确认真 bug 后修复，再决定是否恢复发版。

## 审计链路

Android 端一条用户可见链路是：

`点击新建话题 → createTask 请求 → 本地 Bot/Room frame 更新 → 导航进入新 thread → 输入并发送首条消息 → POST 携带正确 threadId/sendId → 服务端创建/分派回合 → stream 回推用户/排队/助手帧 → Android transcript 刷新`

每一环都要回答两个问题：

- 用户是否立即知道自己点击生效了；
- 如果后续慢或失败，界面是否明确显示“等待/排队/失败”，而不是静默。

## 重点不变量

- 新建话题期间必须有明确进行中状态，失败必须回到可重试状态并给出当前页可见反馈。
- createTask 成功后导航目标必须是新 `(botId/roomId, threadId)`，不得沿用旧 thread。
- 首条消息发送目标必须捕获发送时的目标 threadId；新建后立刻发送不得落回旧话题。
- 网络请求不能无界静默挂起；传输失败、401、服务端拒绝、排队三种语义在 UI 上不能混成“没反应”。
- stream 断连或帧乱序不能导致已接受消息永久不显示；至少要能通过 refresh/重连恢复。
- 真实模型慢与消息未处理必须在 UI 上可区分：已发送、排队、运行中、失败应是不同状态。

## 审计方法

1. 静态追踪 `Session.createTask/switchTask/send`、`ChatScreen` action、`RosterScreen` 新建入口、导航 target 解析、stream frame apply。
2. 检查 silent catch、无超时等待、旧闭包捕获 threadId、状态重置时机、重复点击与连接切换竞态。
3. 用 fake `CompanionClient` 单元测试模拟：
   - createTask 慢、失败、成功后 stream 延迟；
   - 创建完成立刻发送首条消息；
   - 发送时连接切换/401/传输错误；
   - queued receipt 与普通 accepted receipt；
   - 重复点击与快速切换 thread。
4. 必要时用隔离服务端 fixture + Android 模拟器验证真实点击链，记录 `tap → create response → navigation → send receipt → first assistant frame` 时间线。

## 修复原则

只修审计确认的问题。优先做最小修复：补齐进行中/失败反馈、纠正 threadId 或导航竞态、恢复 stream/refresh 兜底；不顺手重构无关 UI 或协议。

## 验证

- T0：改动文件对应 Android core/app 单测 + 编译。
- T1：`:core:test`、`:app:testDebugUnitTest`、`:app:compileDebugKotlin`；若改 UI 行为，补 Robolectric/compose 可测逻辑或 instrumented 覆盖。
- 若需要设备验证，使用 T3 device tools 与隔离 fixture，不用真实用户数据。
- 合并前按仓库规则再评 T2；本线完成后才恢复 v2.1.12 发版决策。

## 非目标

- 不承诺模型响应速度本身；只保证用户能区分“模型慢/排队/失败/断线”。
- 不改变 server 会话分派协议，除非审计证明现有 wire 语义本身缺字段或错误。
- 不处理 v2.1.12 发布流程本身；发布仍从 #136 继续。

## 审计结论（2026-11-27 首轮）

已确认并修复：

1. 新建话题请求虽然有 30 秒 action timeout，不会无限挂起，但聊天页与 roster 在等待期间没有明确进行态；已补聊天页状态行、roster 创建 spinner 与无障碍进行态。
2. 纯文本发送没有置 `sendingMessage`，导致点击后输入框立即清空，而 `LiveTail` 设计中的“发送 POST 到服务端 busy 之间”的空窗没有任何行；已让纯文本发送复用发送中状态。
3. 服务端接受消息后会同步写入 transcript，并在 POST receipt 返回权威 `message`；Android 此前丢弃该字段，完全依赖 stream 帧。stream 延迟或刚断线时，已接受消息也会迟迟不显示。现在 receipt 中的消息立即按既有去重路径合并进 `CompanionState`，后续 stream 帧不会重复。

已排除/暂未证实为 bug：

- `SessionP1Test` 已证明发送闭包捕获的是发送时 task：即使 fleet active thread 已切到 `task-b`，纯文本消息仍 POST `task-a`。
- `createTask` 服务端默认 select 新 task，响应 `publicBot` 带新 active thread、tasks 与消息页；Android 用响应里的 `created.target` 导航，未发现固定沿用旧 threadId 的路径。
- action 请求有 30 秒 wall-clock timeout；「卡半天」首先是反馈缺失，不是无限等待。
- server `startOrQueueDirectMessage` 在分派前同步 append 用户消息；accepted/queued 是两种明确 receipt，未发现服务端首条消息必然丢失。

遗留风险（未在本轮扩大修复）：

- 纯文本发送仍走无 `sendId` 的旧兼容路径；附件发送才有幂等 sendId。它能解释不确定网络失败后的重复风险，但不是本轮「无反馈」的直接根因；若要改需先确认旧服务端对未知字段的兼容策略。
- 真实模型慢仍需要 UI 通过 busy/queue/stream 行表达；本轮只保证接受消息和发送过程不再静默。

## 验证记录（2026-11-27）

已完成：

1. Android loopback 集成验证：`AndroidThreadNavigationTest.creating a task shows progress and the first send lands before its stream frame` 使用真实 Compose、真实 `Session` 与 MockWebServer 覆盖完整链路。受控证据包括：create POST pending 时显示「正在创建新话题…」；pending 期间重复点击不会发出第二个 create POST；create response 后导航目标变为 `created`；首条消息 POST body 捕获 `"threadId":"created"`；发送 pending 时显示「正在发送…」与工作中行；receipt 中的用户消息先于 stream 上屏；后续 `content.delta` 能进入 streaming 状态并渲染。该测试与整个 `AndroidThreadNavigationTest` 文件均绿。
2. Android T1：`:core:test :app:testDebugUnitTest :app:compileDebugKotlin` 绿。
3. 隔离 server fixture：`node --experimental-strip-types scripts/control-lunabot.ts launch` 启动于 `http://127.0.0.1:21659`，`doctor` 绿，fake pi available。canonical `send` 对 isolated bot 的首条文本返回 `success=true` 与 message id；`wait --for turn` settled，transcript 同时包含用户消息、fake pi 首条回答与 digest。用户消息 at `1795763142076`，助手文本 at `1795763142326`，服务端接受后约 250ms 产生首条助手文本。
4. server 定向测试：`server/phones/sends.test.ts`、`server/phones/steer.test.ts`、`server/bot-access.test.ts` 25/25 绿；`server/paired-thread-targets-api.test.ts`、`server/thread-page-frames.e2e.test.ts` 9/9 绿。后者覆盖 paired client 显式 thread 行为、create task frame/page 语义，以及 active thread 切换时不漂移。

限制：

- canonical control surface 没有独立的「phone 新建话题」verb，因此真实 server fixture 只证明首条消息接受、分派与回写；phone 端 create/send 点击链由 Android loopback 集成测试证明。
- Android 模拟器人工链路未完成：T3 `device_open` 连续返回 `Failed to connect to MCP server 't3-code'. Please try again.`，按设备工具纪律未改用 adb 手工点击。若恢复 device tools 或用户明确允许直连 adb，可补做真实模拟器点击链。

### 模拟器补验（2026-11-27，绕过 T3）

在 `test_dsh` Android 15 模拟器安装当前 debug APK，清空测试 app 数据后用 pairing deep link 配对隔离 fixture（`10.0.2.2` 到 host loopback）。手工 adb 点击链通过：进入 `DeviceProbe` → + → 新建话题；新话题页出现「还没有消息」，服务端 active thread 从原默认 thread 切到 `6a1a0e04-6b47-497e-be48-45f0dc0f3928`。输入并发送 `devicefirst1515`：tap `1795763707488`，服务端用户消息 at `1795763707538`（约 50ms），助手 `Hello from pi` at `1795763708039`（tap 后约 551ms）。设备 UI 同时显示用户气泡和助手回复；截图证据 `/tmp/lifecycle-device-final.png`。本轮只补真实链路可达性与回刷，未用慢网络在设备上捕捉瞬时 pending 文案；慢/pending 行为由 Robolectric 受控门控测试证明。

## 全量动作审计（2026-11-27 第二轮）

范围扩大到 Android 端所有用户可触发的异步动作，按「动作 → 进行中反馈 → 失败反馈 → threadId/连接竞态 → 现有测试」盘点。

### 已有完整或基本完整反馈的动作

- 新建话题/首条发送/附件发送：第一轮已补进行中与 receipt 立即上屏，并有 Robolectric 门控测试。
- 话题 sheet 的切换、重命名、置顶、归档、删除、延后提醒：统一 `saving` 阻止关闭与重复提交，失败留在当前 sheet；已有多项 Robolectric 覆盖。
- 智能体资料/模型/头像/compact、团队记忆、例程编辑、例程行内运行/开关/取消、群/分区创建、配对、分享 sheet、提问/审批/密钥/连接器卡片、附件下载与打开：均有本地 busy/saving/answering/opening 状态或明确的结果页；失败走当前卡片、`actionError` 或屏幕内错误。
- 通知已读/全部已读采用先本地翻状态再后台确认的乐观更新；失败由下一次刷新纠回，设计上不等网络。

### 第二轮确认并修复的高风险缺口

1. 话题引用芯片打开目标 thread 需要刷新导航数据或网络请求，但点击后没有任何进行中反馈，重复点击也会并发打开；已在聊天 composer 增加「正在打开话题…」，并在请求期间忽略重复点击。
2. 全局搜索/聊天内搜索命中真实远端结果时需要 `messagesAround` 甚至切换 branch/task，原实现立即关闭或静默等待，用户看到的就是“点了没反应”；已在 roster 命中行显示「打开中…」，在聊天搜索页命中行显示「正在打开消息…」，并在请求期间禁止第二个打开。
3. 分享导出 Markdown/JSON 的 action sheet 点击后立即关闭，导出 GET 期间界面完全无反馈，重复进入还可再次导出；已在 composer 增加「正在导出对话记录…」，并在首个导出完成前忽略重复导出。Robolectric 门控测试证明 pending 可见且重复点击只发出一个 export GET。
4. 运行中的停止按钮点击后外观不变，慢网络下无法知道 interrupt 是否发出，也可重复点击；已把停止钮在请求期间换成 spinner/「正在停止本轮」，并忽略重复点击。Robolectric 门控测试证明 pending 可见且重复点击只发出一个 interrupt POST。
5. `Session.open(search hit)` 与 `Session.export` 捕获 `Throwable` 时未重新抛出 `CancellationException`，调用方取消会被当成普通失败路径吞掉；已修正取消传播。

### 仍需后续处置的中低风险缺口

- 排队消息的删除/取回编辑没有 row 级 pending；queued row 本身仍在屏幕上，语义比空白好，但慢网络下删除图标无确认，且可能重复点击。建议下一轮补 row 级 spinner 与请求去重。
- Connected Apps 的 authorize/disconnect 没有按账号 pending；授权 URL 打开前或 disconnect 慢时只靠最终状态/全局错误。建议补按账号 busy capsule。
- Browser/Computer 的 take/release 是 fire-and-forget，失败只靠 live stream 后续 control/status；高频输入事件的静默 ack 是有意的，但低频 take/release 可考虑明确失败提示。
- Routine 删除确认与 run-seen 标记没有独立 pending；行内 run/toggle/cancel 已有 `busyRows`，风险低于主聊天链路。
- 反应 emoji 与版本切换没有进行中态；失败会写全局 actionError，且结果通常快速经 stream/response 返回，列为低优先级。

本轮未发现新的「必然使用错误 threadId」或「服务端接受后必然丢失」路径；主要问题仍是若干网络动作缺少本地即时反馈。

### 第二轮验证记录

- `:app:compileDebugKotlin` 绿。
- `AndroidThreadNavigationTest.sharing a transcript shows progress and ignores a repeated export tap` 绿：export GET 被门控期间显示「正在导出对话记录…」，重复点击只发出一个请求。
- `AndroidThreadNavigationTest.stopping a turn shows progress and ignores a repeated stop tap` 绿：interrupt POST 被门控期间停止钮变为「正在停止本轮」，重复点击只发出一个请求。
- Android T1：`:core:test :app:testDebugUnitTest` 全绿。
