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
